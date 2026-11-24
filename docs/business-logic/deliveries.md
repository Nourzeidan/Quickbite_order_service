# Deliveries & Agents Module (Phase 3)

Code: `src/app/delivery/` (offers, accept, delivery status, settlement), `src/app/agent/` (presence, available orders, tasks, earnings), `src/worker.ts` (the offer worker).
Tables: `agent_earnings`, `restaurant_balances` + `pickup_lat` / `pickup_lng` on `orders`. Agent presence and offers: **Redis only**.
Endpoints: [api-contracts §3](../api-contracts.md#3-deliveries--agents).

Follows the agreed ERD (`img_2.png`): **no `deliveries` table**; the delivery state is the order state (`delivery_agent_id`, `assigned_at`, `picked_at`, `delivered_at` on `orders`). Phases 3 and 4 of the original plan are merged here.

**Agents choose their orders.** Nothing is auto-assigned: a worker process keeps **offering** `ready` orders over WebSocket to the nearest online agents, and an agent takes one by accepting it (first accept wins). Agents can also browse nearby ready orders. There is no admin assignment.

## 1. Data

### 1.1 `orders` — two new columns

| Column | Meaning |
|---|---|
| `pickup_lat`, `pickup_lng` `DECIMAL(10,7) NULL` (new) | the branch position, snapshotted at placement (like `delivery_lat/lng` for the customer). The worker and the "available orders" list need the pickup point of many ready orders at once; reading it from the row avoids a core lookup per branch. NULL on orders placed before Phase 3 → read from the cached `BranchClient` instead |
| `delivery_agent_id`, `assigned_at`, `picked_at`, `delivered_at` (existing) | current agent and delivery timeline |

### 1.2 `agent_earnings` (ERD + `region`, `order_created_at`, `currency`, `earned_at`)

One row per delivered order, `UNIQUE (order_id, order_created_at)` → settlement can't pay twice. Index `(agent_id, earned_at DESC)` for the earnings screen (Q-A3).

### 1.3 `restaurant_balances` (ERD + `currency`, `region`)

`PRIMARY KEY (restaurant_id, currency)`, `CHECK (balance >= 0)`. Created here because settlement credits it; reads and payouts come in Phase 4.

### 1.4 Redis (ephemeral — rebuilt by pings and worker ticks, never the source of truth)

| Key | Type | Content | TTL |
|---|---|---|---|
| `presence:geo:<region>` | GEO | agentId → last ping position | — (pruned by the worker) |
| `presence:seen:<region>` | sorted set | agentId → last ping time (ms) | — (pruned) |
| `offers:<region>:<publicId>` | set | agents this order is currently offered to | `OFFER_TTL_SEC` |
| `declined:<region>:<publicId>` | set | agents who declined or released this order (never offered it again) | 24 h |

"Online" = in both presence keys and seen within `AGENT_STALE_SEC` (300 s = the 5-minute cutoff). **Busy** (holding an `assigned` / `picked` order) is always read from Postgres (Q-O6), never cached.
Redis wiped → agents reappear on their next ping (~30 s) and the worker re-offers; Redis down → no offers until it's back. No order or money state is in Redis.

## 2. Status flow (on the order)

```
ready ──agent accepts──► assigned ──picked──► picked ──delivered──► delivered
  ▲                          │
  └── agent releases / agent goes stale (worker) ──┘
```

| From | To | Actor | Effect |
|---|---|---|---|
| `ready` | `assigned` | the agent (`POST /deliveries/:id/accept`) | `delivery_agent_id`, `assigned_at`; other offers withdrawn |
| `assigned` | `ready` | the agent (release, with reason) / system (agent stale) | `delivery_agent_id = NULL`; agent added to `declined`; offered again |
| `assigned` | `picked` | the agent | `picked_at` |
| `picked` | `delivered` | the agent | `delivered_at` + **settlement** (§6) |
| `ready` | `cancelled` | restaurant / admin | offers withdrawn |
| `assigned` | `cancelled` | admin | the agent gets `task.cancelled` |

## 3. The offer worker — `src/worker.ts` (separate process: `npm run worker`)

A second entrypoint with no HTTP server. A job runs every `OFFER_INTERVAL_SEC` (10 s) on every shard; each step is safe with several worker instances (`FOR UPDATE SKIP LOCKED`, conditional updates, Redis sets).

Each tick, per region:

1. **Take back stale tasks** — `assigned` orders (Q-O5) whose agent hasn't pinged for `AGENT_STALE_SEC` → conditional `assigned → ready`, agent into `declined`, WS `task.cancelled` to the agent + `order.status_changed` to customer and branch.
2. **Offer ready orders** — `ready` orders without an agent (Q-O5, oldest first, `OFFER_BATCH` per tick). For each order:
   - `GEOSEARCH presence:geo FROMLONLAT <pickup> BYRADIUS ASSIGNMENT_RADIUS_METERS m ASC WITHDIST COUNT 20`;
   - drop agents not seen in 5 min (`ZMSCORE presence:seen`), in `declined`, or already in `offers` (they already have it);
   - drop busy agents (**one** Postgres query for all candidate ids of the whole tick, Q-O6);
   - offer to the nearest `OFFER_TOP_N` (3): `SADD offers:…`, WS `task.offered` → `agent:<id>`.

   An offer set expires after `OFFER_TTL_SEC` (60 s), so an order nobody took is offered again later to whoever is nearest then. Within the TTL, each tick adds up to N new nearby agents who haven't seen it yet.
3. **Prune presence** — members older than the cutoff leave both presence keys.

The worker emits WebSocket events without a socket server through `@socket.io/redis-emitter` (publishes into the same Redis channel the API's socket.io adapter listens to). New dependency, reason: a separate process can't reach the API's sockets otherwise.

The other background jobs (payment sweep, refund sweep, idempotency cleanup, partition maintenance) **move into the worker too**, so the API process only serves requests.

"Cron job": an interval loop (`startIntervalJob`, already used for the sweeps): runs, waits `OFFER_INTERVAL_SEC`, runs again, never overlapping itself. Cron syntax would add a dependency and can't go below one minute without extensions; 10 s matters here.

## 4. Accepting — `POST /deliveries/:orderPublicId/accept` (agent, idempotent)

1. The agent must be online (Redis) and within `ASSIGNMENT_RADIUS_METERS` of the pickup point (distance from the agent's last ping).
2. One transaction:
   - `pg_advisory_xact_lock(<agent>)` — the agent can't take two orders at once (two taps, two devices);
   - not busy (Q-O6) → else 409 `Agent has an active delivery`;
   - conditional `UPDATE orders SET status='assigned', delivery_agent_id, assigned_at WHERE status='ready' AND delivery_agent_id IS NULL` → 0 rows → 409 `Order already taken`.
3. After commit: `task.offer_withdrawn` → the other agents in `offers:…`, delete the set; `order.status_changed` (assigned, with the agent's name/phone) → customer, branch.

**Decline** — `POST /deliveries/:orderPublicId/decline` (agent): adds the agent to `declined:…` (Redis only; no order change). The offer won't come back to them.

## 5. Agent endpoints (role `delivery_agent`, the agent = `req.user.userId`)

| Endpoint | Does |
|---|---|
| `POST /agents/presence/online {lat,lng}` | `GEOADD` + `ZADD` |
| `POST /agents/presence/ping {lat,lng}` | same (must be online, else 409 `Agent is not online`); while holding a `picked` order → WS `delivery.position` → `customer:<id>`. Apps ping every ~30 s |
| `POST /agents/presence/offline` | holding a `picked` order → 409 `Agent has an active delivery`; holding an `assigned` order → released back to `ready`; removed from both keys |
| `GET /agents/available-orders` | `ready` orders within the radius of the agent's last ping, nearest first, minus declined (Q-O5 + pickup columns; bounding box then exact distance) — what the app shows on open / reconnect, since WS offers can be missed |
| `PATCH /deliveries/:orderPublicId/status {status: picked \| delivered \| released, reason?}` | only the order's agent (else 404); transitions of §2 |
| `GET /agents/tasks?status=` | the agent's orders (Q-O6), newest first |
| `GET /agents/earnings?from=&to=` | page of `agent_earnings` (Q-A3) + `SUM` / `COUNT` |

## 6. Settlement on `delivered` — `SettlementService`, one transaction

Before the transaction: branch commission (bps) and restaurant owner id from the core cache.

1. conditional `picked → delivered` (only once; a retry → 409).
2. `commission = floor(subtotal × commissionBps / 10000)` → `orders.commission` + ledger row `commission` (owner → platform, key `commission:<orderId>`).
3. COD: `cod_collection` `pending → succeeded` (`PaymentLedgerService`). Online: the `charge` must be `succeeded`, else abort + `ALERT`.
4. `restaurant_balances` upsert + `FOR UPDATE`, `balance += subtotal − commission` (`FinanceService.creditSettlement`).
5. `agent_earnings`: `floor(delivery_fee × AGENT_SHARE_BPS / 10000)` (`AgentEarningService.record`).
6. commit → WS `order.status_changed` (delivered) → customer, branch.

Any failure rolls everything back; the unique keys stop double rows.

## 7. Realtime (this phase, after commit)

| Event | Room | From | When |
|---|---|---|---|
| `task.offered` | `agent:<id>` | worker | an order is offered (`AgentTaskResponseDTO` + `distanceMeters`) |
| `task.offer_withdrawn` | `agent:<id>` | API | another agent accepted, or the order was cancelled |
| `task.cancelled` | `agent:<id>` | worker / API | the agent's task was taken back (stale) or the order cancelled |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | API / worker | assigned / picked / delivered / back to ready — with `agent { id, name, phone }` when set |
| `delivery.position` | `customer:<id>` | API | agent ping while the order is `picked` |

## 8. Configuration

`OFFER_INTERVAL_SEC=10`, `OFFER_TOP_N=3`, `OFFER_TTL_SEC=60`, `OFFER_BATCH=100`, `ASSIGNMENT_RADIUS_METERS=5000`, `AGENT_STALE_SEC=300` (5-minute cutoff), `AGENT_SHARE_BPS=8000` (agent gets 80% of the delivery fee, decided 2026-11-10).

## 9. Invariants

1. An order has at most one agent (conditional `ready → assigned`); an agent holds at most one `assigned` / `picked` order (advisory lock + busy check).
2. `delivered` ⇒ a `commission` row, the balance credited and an `agent_earnings` row, in one transaction.
3. Only the order's agent can move it to `picked` / `delivered` / back to `ready`.
4. Redis holds only presence and offers; losing it delays offers but never loses or corrupts an order.

## 10. Errors

`Order not found` 404, `Order already taken` 409, `Order is not ready for delivery` 409, `Agent is not online` 409, `Agent is too far from the pickup` 409, `Agent has an active delivery` 409, `Invalid status transition` 409.
