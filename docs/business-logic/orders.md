# Orders Module

Code: `src/app/order/`. Tables: `orders`, `order_items`, `idempotency_keys` (+ `transactions` for the COD row, written through `PaymentService`). Endpoints: [api-contracts §1](../api-contracts.md#1-orders). Phase 1.

## 1. Status machine

```
        ┌──── pending_payment ──── (online only)
        │           │ payment captured (Kashier webhook)
        │           ▼
        └──────► placed ──► accepted ──► preparing ──► ready ──► assigned ──► picked ──► delivered
                    │           │            │           │          │
                    ▼           ▼            ▼           ▼          ▼
            rejected/cancelled cancelled  cancelled   cancelled  cancelled (admin)
```

| Status | Meaning | Who moves it here |
|---|---|---|
| `pending_payment` | online order created, waiting for Kashier | customer (placement) |
| `placed` | in the restaurant's queue | system (COD placement, or verified payment webhook) |
| `accepted` | restaurant accepted | restaurant (`order:order accept`) |
| `rejected` | restaurant declined — terminal; refund (online) or void (COD) | restaurant (`accept`), admin |
| `preparing` | cooking | restaurant (`order:order update`) |
| `ready` | ready for pickup; triggers auto-assignment | restaurant (`update`) |
| `assigned` | a delivery row exists and an agent is assigned | system (assignment service) / admin via `POST /deliveries/assign` |
| `picked` | agent picked up at the branch | agent (via `PATCH /deliveries/:id/status`) |
| `delivered` | handed to the customer — terminal; money settles | agent (via deliveries) |
| `cancelled` | cancelled before pickup — terminal | customer (window), restaurant (`cancel`), admin, system |

### 1.1 Allowed transitions (target by current)

| from \ to | accepted | rejected | preparing | ready | assigned | picked | delivered | cancelled |
|---|---|---|---|---|---|---|---|---|
| `pending_payment` | | | | | | | | customer, admin, system (sweep) |
| `placed` | rest | rest | | | | | | customer*, rest, admin |
| `accepted` | | | rest | | | | | rest, admin |
| `preparing` | | | | rest | | | | rest, admin |
| `ready` | | | | | system/admin | | | rest, admin |
| `assigned` | | | | | | agent | | admin |
| `picked` | | | | | | | agent | — (forbidden) |

`pending_payment → placed` is written only by the verified payment webhook (payments §4).
\* customer: within `CUSTOMER_CANCEL_WINDOW_SEC` (60 s) of placement **and** before `accepted_at` is set.
`rest` = restaurant_user with the permission in §1; admin can do every `rest` transition.

Rules:

- `PATCH /orders/:publicId/status` only accepts `accepted | rejected | preparing | ready | cancelled`. `assigned`, `picked`, `delivered` are written by the Deliveries module, `placed` by Payments.
- `OrderStatusService.assertTransition(from, to, actor)` checks the table; a forbidden pair → 409 `Invalid status transition`.
- The write is conditional (Q-O8): `UPDATE orders SET status = ?, <verb>_at = NOW(), updated_at = NOW() WHERE id = ? AND status = ? RETURNING ...`. 0 rows (someone else moved it) → 409.
- `rejected` / `cancelled` require `reason` (stored in `cancel_reason`) except for a customer cancel.
- After commit: WS event to `customer:<id>` and `branch:<id>` (+ `agent:<id>` when an agent is involved), and `withCache` keys of that branch's order list are deleted.

## 2. Placement — `OrderService.place(region, user, dto, correlationId)`

```
POST /api/orders
 ├─ middleware: authenticate → requireRole(customer) → idempotency({strict: true})
 └─ OrderService.place
     1. normalize items: merge duplicate productIds (sum quantity, re-check ≤ 50)
     2. durable replay guard: findIdempotencyKey(keyHash) on the region shard [Q-I1]
          same fingerprint → return the stored response; different → 409
     3. core lookups (cache first, then core-client), all BEFORE the trx, in parallel:
          branch     = branchClient.getBranch(branchId)
          restaurant = restaurantClient.getRestaurant(branch.restaurantId)
          address    = addressClient.getAddress(customerId, customerAddressId)
          products   = productClient.getBranchProducts(branchId, productIds)   ← one batch call
     4. resolve region: X-Region if sent (must equal REGION_BY_COUNTRY(branch.countryCode) else 409 Region mismatch),
        otherwise derived from the branch
     5. validate (no DB yet):
          restaurant.status === 'active' && branch.isActive && branch.acceptOrders   else Branch is not accepting orders
          every productId returned                                                  else Product not found
          every product isAvailable                                                 else Product unavailable
          every product stock >= quantity                                           else Out of stock
     6. price (pure, §3)
     7. const trx = await db(region).transaction(); try {
          order = insertOrder({...snapshots, ...pricing, publicId: uuid(),
                   status: online ? 'pending_payment' : 'placed'}, trx)
          items = insertOrderItems(rows[], trx)                          ← one multi-row INSERT
          if COD: paymentService.recordCodCollection(order, restaurant.ownerId, trx)
                    → transactions(type='cod_collection', method='cod', status='pending',
                                   amount=total, src=customerId, dst=ownerId)
          insertIdempotencyKey({keyHash, fingerprint, 201, response}, trx)
          await trx.commit()
        } catch { await trx.rollback(); throw }
     8. after commit:
          stockClient.reserveStock(branchId, {orderPublicId, items}, idempotencyKey=publicId)
            409 / failure → voidOrder(): status 'cancelled', cancel_reason 'out_of_stock_post_commit',
                            COD row → 'failed' (+ 0-amount adjustment for audit); online never charged
          COD → WS order.created → branch:<id>, restaurant:<id>
          online → nothing yet (restaurant sees it on payment capture)
     9. return OrderResponseDTO.from(order, items)
```

Performance notes:

- Core data is mostly served from Redis; on a cold cache the lookups run in parallel, so one round trip of latency.
- One short PG transaction: 2–4 inserts, no `SELECT` inside it.
- Kashier is not called here — the client calls `POST /payments/init` next.

Race on the last unit of stock: core's `reserveStock` is an atomic conditional decrement; the loser gets 409 and is voided.

### 2.1 Phase 1 implementation notes

- The branch is read first (it decides the shard), then the durable replay guard runs on that shard, then restaurant / address / products in parallel.
- `publicId` is a UUIDv7; `created_at` is derived from it (partitioning, database-design §4.0).
- Stock reservation after commit: `409` → order `cancelled` with `out_of_stock_post_commit`, the stored idempotent response becomes the same `409 Out of stock`. Core unreachable (503) → order `cancelled` with `stock_reservation_failed`, the idempotency row is **deleted** so retrying the same key places a fresh order, and stock is released best-effort.
- Concurrent requests with the same key and no Redis: the second insert hits the `idempotency_keys` PK (23505), rolls back and answers with the first one's stored response.
- **Since delivered:** COD `cod_collection` row, `paymentSummary` from the ledger, refunds (Phase 2); WS events (added to Phases 1–2 on 2026-11-10); cancelling a `ready` / `assigned` order withdraws offers / notifies the agent (Phase 3).

## 3. Pricing — `OrderPricingService` (pure, unit-testable)

All values are integers (minor units).

| Field | Formula |
|---|---|
| `unit_price_snapshot` | `toMinor(product.price)` |
| `line_total` | `unit_price × quantity` |
| `subtotal` | Σ `line_total` |
| `delivery_fee` | `branch.deliveryFee` (minor units, core) |
| `service_fee` | `Math.floor(subtotal × SERVICE_FEE_BPS / 10000)` (currently `0`) |
| `total` | `subtotal + delivery_fee + service_fee` |
| `commission` | `0` at placement; computed at delivery (deliveries §5) |

The client never sends prices. The DB re-checks `total` (`chk_orders_total`).

## 4. Reads

| Endpoint | Query | Notes |
|---|---|---|
| `GET /orders/:publicId` | Q-O1 + Q-O7 + Q-D2 + Q-P3 | order + items through the 5 s order cache (system-design §4, Layer B2); authorization in the service on every request (customer owns / restaurant member / admin), else 404 |
| `GET /customer/orders?year=` | Q-O2 | year bound; prior years → `dbArchive(region)` (Phase 5); items count from one `whereIn` |
| `GET /restaurant/orders` | Q-O3 | `requireBranchAccess`, `withCache(10)`; range ≤ 1 year |
| `GET /admin/orders` | Q-O3/Q-O2 per shard | fan-out with tagged cursor when `X-Region: all` |

Lists never call a repository per row: orders first, then one `whereIn('order_id', ids)` for items.

## 5. Cancellation policy

- **Customer**: `pending_payment` any time; `placed` only within 60 s of placement and before `accepted_at`. Otherwise 409 `Cancellation window expired`.
- **Restaurant**: any time before `picked`, with a reason (`order:order cancel`). `assigned → cancelled` is admin-only.
- **System**: `pending_payment` older than `PAYMENT_SESSION_TIMEOUT_MIN` (payment sweep); stock reservation failure; assignment exhausted is **not** a cancel (order stays `ready`, admin alerted).
- **After `picked`**: forbidden (food is with the agent); handled outside the system.

Side effects of `rejected` / `cancelled` (after commit unless noted):

| Payment state | Effect |
|---|---|
| online, `charge` succeeded | `refundService.refund(order, total, reason)` → refund row `pending` → Kashier → webhook |
| online, not paid | session marked `cancelled`; nothing to refund |
| COD | in the same trx: `cod_collection` → `failed` + 0-amount `adjustment` for the audit trail |
| any | `stockClient.releaseStock` (idempotent); active delivery → `cancelled`, agent released, WS `task.cancelled` |

## 6. Invariants

1. `total = subtotal + delivery_fee + service_fee`.
2. `commission ≤ subtotal`.
3. Status only moves forward along §1.1.
4. `delivered_at IS NOT NULL` ⇒ succeeded `charge` or `cod_collection`, a `commission` row, the balance credited, and an `agent_earnings` row exist.
5. `pending_payment` orders older than 15 min are cancelled by the sweep.
6. A customer never reads another customer's order, even with its `publicId`.
7. A non-owner restaurant user never reads orders of branches outside `branchIds`.

## 7. RBAC

| Action | Allowed |
|---|---|
| `POST /orders` | `customer` |
| `GET /orders/:publicId` | customer (own), restaurant_user (member), admin |
| `GET /customer/orders` | `customer` |
| `GET /restaurant/orders` | `order:order read` + branch access, admin |
| `GET /admin/orders` | admin |
| `PATCH …/status` accepted/rejected | `order:order accept`, admin |
| `PATCH …/status` preparing/ready | `order:order update`, admin |
| `PATCH …/status` cancelled | customer (own, window), `order:order cancel`, admin |

## 8. WebSocket events

| Event | Channels | Payload |
|---|---|---|
| `order.created` | `branch:<id>`, `restaurant:<id>` | `OrderSummaryResponseDTO` |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderPublicId, status, updatedAt }` |
| `order.cancelled` | `customer:<id>`, `branch:<id>`, `restaurant:<id>` | `{ orderPublicId, reason, updatedAt }` |

## 9. Errors (`app/order/errors.ts`)

`OrderNotFoundError`, `RegionMismatchError`, `BranchNotAcceptingOrdersError`, `ProductNotFoundError`, `ProductUnavailableError`, `OutOfStockError`, `InvalidStatusTransitionError`, `CancellationWindowExpiredError`, `ReasonRequiredError` — messages in [api-contracts §9](../api-contracts.md#9-error-messages-canonical).

## 10. Edge cases

- Same `Idempotency-Key`, same body, Redis lost → `idempotency_keys` row returns the original 201.
- Two tabs placing the same cart with different keys → two orders (by design; keys are the client's intent).
- Product price changed between cart and placement → the order uses the fresh price from core (the cache is invalidated by `product.price.changed`); the client shows the returned totals.
- Branch deactivated while the order is `placed` → the order continues; only new orders are rejected.
