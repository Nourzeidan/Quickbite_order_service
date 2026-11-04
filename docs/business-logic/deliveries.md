# Deliveries Module

Code: `src/app/delivery/`. Tables: `deliveries` (+ `orders`, `transactions`, `restaurant_balances`, `agent_earnings` through the owning services in the settlement trx). Endpoints: [api-contracts §3](../api-contracts.md#3-deliveries). Phase 3.

## 1. Responsibilities

- Turn a `ready` order into a delivery (auto by proximity, or manual by admin).
- Run the delivery status machine for the assigned agent.
- Reassign on reject / timeout, with a limit.
- Settle the money on `delivered` (one transaction).

## 2. Delivery status machine

```
assigned ─► accepted ─► picked ─► delivered (terminal)
   │           │
   ▼           ▼
rejected    cancelled (order cancelled before pickup)
   │
   ▼
reassigned (old row; a new row is created)
```

| Status | Meaning | Written by |
|---|---|---|
| `assigned` | row created, agent notified | system / admin |
| `accepted` | agent accepted | agent |
| `rejected` | agent declined or did not answer in time → reassignment | agent / system (timeout) |
| `picked` | agent picked up at the branch | agent |
| `delivered` | handed over — triggers settlement | agent |
| `cancelled` | order cancelled while assigned/accepted | system |
| `reassigned` | superseded by a newer row (`reassigned_from`) | system |

Agent transitions via `PATCH /deliveries/:id/status`:

| Current | Target | Order mirror |
|---|---|---|
| `assigned` | `accepted` | — |
| `assigned` | `rejected` | order stays `assigned` until the next row is created, or goes back to `ready` if no candidate is left |
| `accepted` | `picked` | order `assigned → picked`, `picked_at` |
| `picked` | `delivered` | order `picked → delivered`, `delivered_at` + settlement |

Anything else → 409 `Invalid status transition`. The service checks `delivery.agent_id === req.user.userId` (else 404).

## 3. Assignment — `AssignmentService.assign(region, orderId, opts)`

Triggered after commit when an order becomes `ready`, by admin (`POST /deliveries/assign/:orderPublicId`, optional `agentId`), and by the timeout scan.

### 3.1 Auto

1. Order must be `ready` and have no active delivery (`assigned | accepted | picked`) [Q-D2] → else 409.
2. Candidates: `GEOSEARCH presence:geo:<region>` within `ASSIGNMENT_RADIUS_METERS` (5000) of the branch pickup point, minus `presence:busy:<region>`, nearest first, top `ASSIGNMENT_CANDIDATES` (5). Redis empty/down → Postgres fallback [Q-A1].
3. For the first candidate, **one transaction**:
   - `SELECT … FROM agent_presence WHERE agent_id = ? FOR UPDATE`; must be `is_online` and `last_seen_at > NOW() − PRESENCE_STALE_SEC`.
   - conditional `orders: ready → assigned`, `delivery_agent_id`, `assigned_at` (only one assigner can win this — the "one active delivery" guarantee).
   - insert `deliveries(status='assigned', pickup/dropoff snapshot, distance_meters, reassigned_from?)`.
   - commit.
4. After commit: `SADD presence:busy:<region> agentId`; WS `task.assigned` → `agent:<id>`, `delivery.status_changed` → customer + branch.
5. Candidate not eligible (step 3 check fails) → try the next one. None left → order stays `ready`; WS alert `assignment.unassigned` to admins; the timeout scan retries later.

### 3.2 Manual (admin)

Same transaction with the given `agentId` (still must be online and not busy); no candidate search.

### 3.3 Acceptance timeout — `AssignmentService.scanTimeouts` (in-process loop, every 10 s per shard)

`assigned` deliveries older than `AGENT_ACCEPT_TIMEOUT_SEC` (30 s) → `rejected` (reason `timeout`), agent removed from the busy set, then reassign (§4). Uses `FOR UPDATE SKIP LOCKED` so N instances are safe. The same loop retries `ready` orders without a delivery [Q-O5].

## 4. Reassignment

`POST /deliveries/reassign/:orderPublicId` (admin), agent `rejected`, or timeout:

1. Count the chain [Q-D3]; ≥ `MAX_REASSIGNMENT_ATTEMPTS` (3) → 409 `Max reassignment attempts reached` + admin alert; order back to `ready`.
2. Old row → `reassigned` (+ `reassigned_at`); new row via §3 with `reassigned_from = old.id`, excluding agents already tried for this order.

## 5. Settlement on `delivered` — `SettlementService.settle(...)`

Before the transaction: load the branch commission (basis points) and the restaurant owner id from the core cache.

In **one transaction** with the `picked → delivered` transition:

1. `INSERT INTO restaurant_balances (...) ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE` for `(restaurant_id, currency)`.
2. `commission = Math.floor(subtotal × commissionBps / 10000)`; set `orders.commission`.
3. Online: the `charge` must be `succeeded` (else abort + alert). COD: `cod_collection` `pending → succeeded`.
4. Insert `transactions(type='commission', method='system', status='succeeded', amount=commission, src=ownerId, dst=NULL, idempotency_key='commission:<orderId>')`.
5. `balance += subtotal − commission`.
6. `agentEarning = Math.floor(order.delivery_fee × AGENT_SHARE_BPS / 10000)`; `deliveries.earning_amount`; insert `agent_earnings(agent_id, order_id, delivery_id, amount)` (unique `delivery_id`).
7. Delivery → `delivered`, order → `delivered`. Commit.

After commit: `SREM presence:busy`, WS to customer, branch and agent. Any failure rolls everything back — no partial settlement. A retried `delivered` call is a 409 (conditional transition) and the unique keys stop double ledger rows.

## 6. Cancellation while in delivery

- Order cancelled while the delivery is `assigned` / `accepted` → delivery `cancelled` (same trx as the order), agent released, WS `task.cancelled` → `agent:<id>`.
- After `picked` → forbidden by the order status machine.

## 7. RBAC

| Action | Allowed |
|---|---|
| `POST /deliveries/assign/:orderPublicId` | admin (`order:delivery assign` reserved for future roles) |
| `POST /deliveries/reassign/:orderPublicId` | admin |
| `PATCH /deliveries/:id/status` | the assigned `delivery_agent` (ownership in the service) |

## 8. Invariants

1. At most one active delivery (`assigned | accepted | picked`) per order.
2. `delivered` ⇒ an `agent_earnings` row and a `commission` row exist, and the balance was credited in the same trx.
3. Chain length ≤ `MAX_REASSIGNMENT_ATTEMPTS`.
4. Only the assigned agent can move a delivery.

## 9. Performance

- Candidate search comes from Redis GEO in steady state; Postgres GIST is the fallback.
- `idx_deliveries_agent_id_status_assigned_at` covers the agent task list; `orders.delivery_agent_id` covers "current task" lookups.

## 10. WebSocket events

| Event | Channel | Payload |
|---|---|---|
| `task.assigned` | `agent:<id>` | `DeliveryTaskResponseDTO` |
| `task.cancelled` | `agent:<id>` | `{ deliveryId, reason }` |
| `delivery.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderPublicId, status, updatedAt, agent: { id, name, phone } }` |

## 11. Configuration

`ASSIGNMENT_RADIUS_METERS=5000, ASSIGNMENT_CANDIDATES=5, AGENT_ACCEPT_TIMEOUT_SEC=30, MAX_REASSIGNMENT_ATTEMPTS=3, AGENT_SHARE_BPS`.

## 12. Errors (`app/delivery/errors.ts`)

`DeliveryNotFoundError`, `OrderNotReadyForDeliveryError`, `OrderAlreadyHasActiveDeliveryError`, `OrderHasNoActiveDeliveryError`, `NoEligibleAgentsError`, `MaxReassignmentAttemptsReachedError`, `InvalidStatusTransitionError`.
