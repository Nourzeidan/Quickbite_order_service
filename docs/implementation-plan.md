# Implementation Plan

Build **one module at a time**, end-to-end, before starting the next. Inside each module always follow this order:

```
1. migration(s) (+ the indexes from database-design §5, each with a "-- supports" comment)  →  npm run migrate (all shards)
2. enums.ts, errors.ts
3. entity/
4. dto/ request
5. dto/ response
6. repository/   (// Q-xx on every query)
7. service/      (register in lib/di/container.ts + tokens.ts)
8. controller/   (register in lib/di/container.ts + tokens.ts)
9. routes.ts  + mount in src/routes.ts
10. manual smoke test (Postman) + the done-checklist at the end of this file
```

Module order: **Phase 0 scaffold → 1 Orders → 2 Payments → 3 Deliveries & agents → 4 Restaurant finance → 5 Archival**.

> **Restructured 2026-11-10.** The original Phases 3 (Deliveries) and 4 (Agents) are merged into Phase 3, following the agreed ERD (`img_2.png`: no `deliveries` table, delivery state on `orders`). The separate "Phase 6 — WebSocket wiring" is removed: **every phase ships its own realtime events** (listed under each phase), and Phases 1–2 got theirs on 2026-11-10.

Acceptance for every phase: endpoints answer with the documented contract on local Postgres (one DB per region) + Redis + RabbitMQ, idempotency works, RBAC denies the right calls, and WebSocket clients receive **that phase's** events from [realtime.md §5](./business-logic/realtime.md#5-event-catalogue) (emitted after commit through `WsPublisher`).

> **Parallel work on core-service.** This service depends on new core endpoints, permissions, an API-key guard and an outbox. Each phase lists its **core-service changes**. Don't start a phase until they exist (or develop against a stub with the same signature).

---

## Phase 0 — Scaffold & shared infrastructure ✅ (implemented, tested 2026-11-04)

Goal: a runnable Express app with core's conventions plus country sharding, the core-client, the RabbitMQ consumer and the socket.io server. No business modules, **no migrations**.

| Step | Files | Notes |
|---|---|---|
| Project | `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | core's stack and tsconfig (ESM `nodenext`); **add** `socket.io`, `@socket.io/redis-adapter`, `amqplib`, `amqp-connection-manager`. No bcrypt / mailjet. |
| Config | `lib/config/env.ts` | zod; `REGIONS` + `DB_<region>_*` (required) + `ARCHIVE_DB_<region>_*` (optional until Phase 5), Redis, RabbitMQ, core, WS |
| Shards | `lib/knex/{knex.ts, knexfile.ts, migrate-all.ts}` | `db(region)`, `dbArchive(region)`, `pingAll()`, `destroyAll()`; migrations loop every shard |
| Region | `lib/sharding/{regions.ts, region-resolver.ts, errors.ts}` | `resolveRegion` (header only, invalid → 400), `requireRegion({ allowAll })` |
| Errors / logging / correlation | `lib/error/*`, `lib/logger/logger.ts`, `lib/correlation/correlationId.ts` | core copies; correlation honours the incoming header |
| Auth | `lib/auth/{jwt.ts, guard.ts, rbac.ts, enums.ts, errors.ts}` | Bearer + cookie; `requireRole`, `rbac` (admin bypass, otherwise **deny** until Phase 1), `requireRestaurantMember`, `requireBranchAccess` |
| HTTP | `lib/http/{response.ts, pagination/*}`, `lib/validation/validate.ts` | core copies; `validateBody` / `validateQuery` with field messages |
| Cache | `pkg/cache/*`, `lib/cache/{init.ts, withCache.ts}` | core provider + `trySet` (SET NX); region-prefixed keys |
| Idempotency | `lib/idempotency/idempotency.ts` | Redis: user-scoped key, body fingerprint (409 on mismatch), in-flight lock, stores status + body |
| Core client | `lib/core-client/{core-client.ts, errors.ts, types.ts}` | `api-key`, `X-Correlation-ID`, timeout, retry only for GET/idempotent calls |
| Messaging | `pkg/messaging/*`, `lib/messaging/init.ts`, `lib/core-events/{consumer.ts, types.ts}` | auto-reconnect, topology + DLQ, Redis dedupe, handler registry (empty) |
| WebSocket | `lib/websocket/{ws-server.ts, ws-auth.ts, errors.ts}` | socket.io on `/ws`, Redis adapter, JWT handshake, permitted rooms, subscribe/unsubscribe |
| Utils | `pkg/utils/{time.ts, money.ts, retry.ts}` | `toMinor` with string math |
| App | `src/app.ts`, `src/server.ts`, `src/routes.ts`, `app/health/health.routes.ts`, `lib/di/*` | graceful shutdown closes io, broker, shards, Redis |

**Core-service changes required:** `requireInternalApiKey` + `INTERNAL_API_KEY`; transactional outbox `events_outbox` + `src/worker.ts` drain + `core.events` exchange ([integrations §2.4](./integrations.md#24-required-changes-in-core-service-dependency-list)).

**Acceptance:**
- `npm run dev` starts; `GET /api/health` returns 200 with every hot shard `ok: true` (503 when one is down).
- `npm run migrate` runs on every shard (a no-op when Phase 0 was cut; since Phase 1 it applies the order migrations).
- A request with an unknown `X-Region` → 400; a protected route without a token → 401.
- On boot the consumer declares queue + bindings + DLQ. A message on `core.events` with key `product.test` (no handler) is logged `no handler, acking` and acked. Re-publishing the same `eventId` of a **handled** type (e.g. `product.price.changed`) is skipped (dedupe key present). Unknown types are acked before the dedupe step, so `product.test` can't show it.
- Stopping RabbitMQ and starting it again: the client reconnects and re-declares topology; no crash.
- A socket.io client connects to `/ws` with `auth: { token }`, receives `hello`, subscribes to an allowed room, and an `io.to(room).emit(...)` from another instance reaches it.

**Test notes (2026-11-04):** every check above passed. Helpers in `play/`: `token.ts` (signs test JWTs), `ws-client.ts` / `ws-emit.ts` (socket.io client + "other instance" emitter). Fix found while testing: dotenv 17 printed a banner to stdout, which broke `$t = npx tsx play/token.ts` → `config({quiet: true})` in `lib/config/env.ts`.

---

## Phase 1 — Orders (the spine) ✅ (implemented, tested 2026-11-04)

Partitioning added on top of the plan: `orders` / `order_items` are monthly partitions managed by `pg_partman` (database-design §4.0). The COD ledger row moves to Phase 2 with the `transactions` table (see orders.md §2.1).

| # | Deliverable |
|---|---|
| 1 | Migrations: `create_orders_table`, `create_order_items_table`, `create_idempotency_keys_table` |
| 2 | `app/order/enums.ts` (`OrderStatus`, `PaymentMethod`, `Currency`), `errors.ts`, `types.ts` |
| 3 | Entities: `order.entity.ts`, `order-item.entity.ts` |
| 4 | DTOs: `order.request.dto.ts` (`CreateOrderRequestDTO`, `OrderItemInputDTO`, `UpdateOrderStatusRequestDTO`, list queries), `order.response.dto.ts` (`OrderResponseDTO`, `OrderItemResponseDTO`, `OrderDetailResponseDTO`, `OrderSummaryResponseDTO`, `OrderStatusResponseDTO`) |
| 5 | Repos: `order.repo.ts` (Q-O1..Q-O8), `order-item.repo.ts` (Q-O7), `idempotency-key.repo.ts` (Q-I1, Q-I2) |
| 6 | Services: `order.service.ts` (place, getDetail, list*), `order-status.service.ts` (transition table, `assertTransition`, `changeStatus`), pricing helper |
| 7 | `controller/order.controller.ts`, `routes.ts` (`POST /orders`, `GET /orders/:publicId`, `GET /customer/orders`, `GET /restaurant/orders`, `GET /admin/orders`, `PATCH /orders/:publicId/status`) |
| 8 | Core-client wrappers: `branch`, `restaurant`, `address`, `product`, `stock`, `permission` + Redis read-through cache |
| 9 | `lib/auth/permission-cache.service.ts`; `rbac()` now checks restaurant-user permissions |
| 10 | Idempotency DB store wired for `POST /orders`; core-event handlers: `product.*`, `branch.*`, `restaurant.suspended`, `rbac.permissions_changed` |

**Core-service changes required:** seed `order:*` permissions; `restaurant_branches.delivery_fee`; internal endpoints (branch, restaurant, address, products batch, stock reserve/release, role permissions); publish the events above through the outbox.

**Acceptance:**
- COD order → `placed`, stock reserved on core (the `cod_collection` row comes with Phase 2).
- `\d+ orders` shows monthly partitions + `orders_default`; `EXPLAIN` of Q-O1 touches one partition.
- Online order → `pending_payment`.
- Same `Idempotency-Key` + same body → same response; + different body → 409; with Redis flushed → still the same response (DB store).
- Out of stock / unavailable / inactive branch → documented 409s; region mismatch → 409.
- Restaurant `staff` can accept but not cancel; a manager of branch A can't read branch B.
- `EXPLAIN` of Q-O2 / Q-O3 uses their indexes.

**Test notes (2026-11-04):** every check above passed, plus: order detail access (own customer / admin / branch staff → 200; other customer, other restaurant, other branch's staff, wrong shard, non-UUID → 404), the transition table (invalid jumps → 409, reject/cancel without reason → 400), the 60 s customer cancel window, stock released on core after a cancel, cursor pagination and the admin `X-Region: all` fan-out, and `branch.updated` invalidating the branch cache within seconds.
- Helpers in `play/`: `api.ps1` (PowerShell request helper), `token.ts` (`key=value` args for staff / manager / admin tokens, since core's invite flow needs email), `db-checks.ts` (partitions, Q-O1 pruning, voided orders), `db-index-check.ts` (Q-O2 / Q-O3 plans on ~60k synthetic rows inside a rolled-back transaction; tiny tables make the planner pick the `created_at` index instead).
- Fixed while testing: numeric query params (`limit`, `year`, `branchId`) always failed validation under `npm run dev`, because tsx (esbuild) doesn't emit decorator metadata, so `enableImplicitConversion` did nothing → explicit `@Type(() => Number)` in `order.request.dto.ts`. In core-service, `branch.service.ts` compared `restaurant.ownerId` (BIGINT → string) with `===` against the numeric JWT `userId`, so owners got 403 on `PATCH /branches/:id` → `Number(...) === Number(...)`.
- Not covered (failure paths outside this list): stock running out between the pre-check and the reservation (`out_of_stock_post_commit`), and core unreachable during reservation (`stock_reservation_failed`).

**Realtime (added 2026-11-10, `play/ws-e2e.ts`):** COD placement → `order.created` → `branch:<id>`, `restaurant:<id>`; every status change → `order.status_changed` → `customer:<id>`, `branch:<id>`; cancel / reject-void / payment timeout → `order.cancelled` → customer, branch, restaurant (with the reason). Emitted by `OrderEventsService` after commit.

---

## Phase 2 — Payments ✅ (implemented, tested 2026-11-09 — walkthrough + test guide: [phase-2-walkthrough.md](./phase-2-walkthrough.md))

| # | Deliverable |
|---|---|
| 1 | Migrations: `create_payment_providers_table` (+ seed `kashier`, `cod`), `create_payment_sessions_table`, `create_transactions_table`, `create_payment_webhook_events_table` |
| 2 | `pkg/payments/payment.interface.ts`, `pkg/payments/kashier/{kashier.client.ts, kashier.types.ts, kashier.signature.ts}`, `lib/payments/init.ts` |
| 3 | `app/payment/*`: enums, errors, entities (session, transaction), DTOs, repos (Q-P1..Q-P7), services (`payment`, `webhook`, `refund`, `payment-sweep`), controllers (payment, webhook), routes |
| 4 | Payment sweep loop started from `server.ts` |
| 5 | Orders: COD row now written through `PaymentService.recordCodCollection(trx)`; reject/cancel trigger refunds |

**Core-service changes required:** none.

**Acceptance:**
- `POST /payments/init` returns a Kashier `redirectUrl`; calling it twice returns the same session.
- A signed success webhook → order `placed`, `charge` `succeeded`; replaying it → 200, no new rows.
- Bad signature → 401, nothing stored.
- Unpaid order older than 15 min → `cancelled` by the sweep; a late success webhook → order stays cancelled + automatic refund.
- Admin refund → `refund` `pending` → webhook → `succeeded`; refunding more than the charge → 409.


**Test notes (2026-11-09):** `play/phase2-e2e.ts` against the running API: 32/32 checks passed — init (real Kashier sandbox session, reuse, idempotent replay, 409 on body mismatch, 404 for another customer), webhooks (401 bad signature with nothing stored, amount mismatch stored without state change, FAILURE, SUCCESS -> placed + captured + charge, duplicate, pay+capture of one transaction), `GET /payments/:id`, over-refund 409, admin refund sent to Kashier, auto refund on cancel of a paid order, late capture on a cancelled order -> stays cancelled + refund, refund sweep sending a never-sent refund, COD row + void. The sweep cancelled a real unpaid order at timeout + grace (`payment_timeout`). A **real** Kashier webhook (declined card) verified with our signature code and showed `amount: 70.5` -> `KASHIER_WEBHOOK_AMOUNT_UNIT=major` is right.
- Fixed while testing: Kashier rejects `localhost` as `merchantRedirect` (400) -> `KASHIER_RETURN_URL` must be public; added the cosmetic `GET /payments/return` page.
- Real sandbox, end to end: approved test-card payment (5123450000000008, expiry 06/25) -> real webhook -> order `placed`, session `captured`, charge `succeeded` with the real kashierOrderId; admin partial refund (100) -> 202 -> sent to Kashier (`PUT /v3/orders/:kashierOrderId`) -> real `refund` webhook (`amount: 1`) -> refund `succeeded`, matched by Kashier's refund transaction id. Kashier test mode: the card **expiry** picks the outcome (06/25 approved, 05/25 declined).
- ~~Not covered: Kashier unreachable during `init` and during a refund.~~ **Covered 2026-11-24** by `play/kashier-down-e2e.ts` (**20/20**): a fake Kashier in the test (refuses connections / never answers / 500 / 400 / ok, counting every call) and a second API (port 4101) + a short-lived worker pointed at it.
  - `init`: unreachable, 500 and no answer (3 × 800 ms timeouts) → 503 `Payment provider unavailable`, **3 tries**; 400 → 502 `Payment provider rejected the request`, **1 try**; order stays `pending_payment`, no session row; Kashier back → the **same** `Idempotency-Key` succeeds (5xx answers are never stored).
  - Admin refund, unreachable → 503, Kashier called **once** (never retried), row `pending` + `provider_requested_at` set + no provider id; retry with the same key → 202, same refund, not sent again; Kashier's late refund webhook settles it (matched by charge + amount). 400 → 502, row `failed` with the reason.
  - Order rejected while Kashier is down → reject 200; the full refund is reserved in the same trx, sent once **after** the response (`void sendQueued`), stays `pending`.
  - Refund sweep (`REFUND_STALE_ALERT_MIN=0`) → `ALERT refund has no outcome from the provider` for it, and it is **not** sent again.

**Realtime (added 2026-11-10, `play/ws-e2e.ts`, 16/16):** captured → `payment.captured` → `customer:<id>` + `order.status_changed` (placed) + `order.created` → branch, restaurant; declined → `payment.failed` → `customer:<id>`; nothing reaches the restaurant while an order is `pending_payment`; a socket can't join another customer's room.

---

## Phase 3 — Deliveries & agents ✅ (implemented, tested 2026-11-10)

Design: [business-logic/deliveries.md](./business-logic/deliveries.md). No `deliveries` table (ERD): delivery state on `orders`. **Agents choose their orders**: a worker offers `ready` orders over WebSocket to the nearest online agents, the first to accept gets it. No auto-assignment, no admin assignment.

| # | Deliverable |
|---|---|
| 1 | Migrations: `alter_orders_add_pickup_location` (`pickup_lat`, `pickup_lng`), `create_agent_earnings_table`, `create_restaurant_balances_table`. No presence table: presence and offers are Redis |
| 2 | `src/worker.ts` (`npm run worker`): offer job every `OFFER_INTERVAL_SEC` (take back stale tasks, offer ready orders to the `OFFER_TOP_N` nearest online non-busy agents within `ASSIGNMENT_RADIUS_METERS` of the pickup, last seen ≤ 5 min, prune presence) + the existing sweeps moved out of the API. WS from the worker via `@socket.io/redis-emitter` |
| 3 | `app/agent/*`: presence in Redis (online / ping / offline), available orders near the agent, tasks (Q-O6), earnings (Q-A3), `AgentEarningService.record(trx, …)` |
| 4 | `app/delivery/*`: `OfferService` (used by the worker), accept (advisory lock + conditional `ready → assigned`), decline, `DeliveryStatusService` (picked / delivered / released), `SettlementService` |
| 5 | `app/restaurant-finance/`: `restaurant-balance.repo.ts` + `FinanceService.creditSettlement(trx, …)` (credit only; reads/payouts in Phase 4) |
| 6 | Orders: placement snapshots the branch `lat`/`lng` into `pickup_*`; cancelling a `ready` / `assigned` order withdraws offers / notifies the agent; new `UserClient` (agent name / phone, cached) |
| 7 | Settlement on `delivered` in one trx: commission row + balance credit + COD `cod_collection` succeeded (or online charge check) + `agent_earnings` (80% of the delivery fee) |

**Core-service changes required:** none (`GET /api/internal/users?ids=` exists; branch `lat`/`lng`/`commission` exist — set a commission on the test branch).

**Realtime (this phase):** `task.offered` (worker), `task.offer_withdrawn`, `task.cancelled` → `agent:<id>`; `order.status_changed` (assigned / picked / delivered / back to ready, with the agent's name + phone) → customer, branch; `delivery.position` → `customer:<id>` on pings while `picked`.

**Acceptance:**
- A `ready` order is offered to the 3 nearest agents within 5 km of the branch who pinged in the last 5 min and aren't busy; an agent seen 6 min ago, 6 km away, busy, or who declined it never gets the offer.
- Two agents accept the same order → one 200, one 409 `Order already taken`; the others get `task.offer_withdrawn`. One agent accepts two orders at once → one 409.
- Nobody accepts → offered again after `OFFER_TTL_SEC` to whoever is nearest then.
- `GET /agents/available-orders` lists the same nearby ready orders, nearest first.
- Agent releases, or stops pinging while `assigned` → order back to `ready`, offered again, never to that agent.
- Only the order's agent can move it; `picked` / `delivered` set `picked_at` / `delivered_at`.
- `delivered` credits `subtotal − commission`, writes `commission` + `agent_earnings`, COD row `succeeded`; replaying `delivered` → 409, no double rows.
- Offline with a `picked` order → 409; tasks and earnings paginate.
- Worker restarted / two workers running → no duplicate assignment, no lost order. Redis flushed → offers resume after the next pings.


**Test notes (2026-11-10):** `play/phase3-e2e.ts` against the running API + worker: **44/44** — offers to exactly the 3 nearest fresh agents (500 m / 1 km / 2 km; not the 4th at 3 km, not 8 km, not one last seen 6 min ago) with distance + cash-to-collect; the 3 km agent still sees it in `available-orders`, 8 km doesn't and can't accept (too far); two simultaneous accepts → one 200 + one 409, `task.offer_withdrawn` to the rest, customer gets `assigned` with the agent; one active order per agent; only the order's agent moves it; release → back to `ready`, re-offered (never to that agent); picked → `delivery.position` to the customer; offline while picked → 409; delivered → COD collected, commission row, balance `+ subtotal − commission`, earning = 80% of the fee; delivered again → 409 with one earning; online order settles with its charge; a silent agent's task is taken back by the worker (`task.cancelled`); cancelling a ready order withdraws its offers; tasks + earnings; offline releases an assigned order. Phase 2 (32/32) and realtime (16/16) suites still pass with the sweeps moved into the worker.
- Background jobs moved from `server.ts` to `src/worker.ts` (`npm run worker`): **run both processes** from now on.
- Non-zero commission: covered in Phase 4 (core got `PATCH /api/branches/:id/commission`, admin only).
---

## Phase 4 — Restaurant finance

| # | Deliverable |
|---|---|
| 1 | No new migration (`restaurant_balances` landed in Phase 3) |
| 2 | `app/restaurant-finance/*`: balance read, payouts list, admin `POST /restaurant/payouts`, `debitForRefund` (wired into the refund webhook — replaces the Phase 2 TODO) |

**Core-service changes required:** `PATCH /api/branches/:id/commission { commissionBps }` (system admin, 0–10000, emits `branch.updated`) — decided 2026-11-18 so the platform can actually earn commission (see `core-service/CHANGES.md` §7).

**Built (2026-11-18):**

| # | Deliverable |
|---|---|
| 3 | `restaurant-finance/{errors,types,routes}.ts`, `dto/finance.request.dto.ts` + `finance.response.dto.ts`, `controller/finance.controller.ts`, `FinanceService` (`getBalance`, `listPayouts`, `recordPayout`, `debitForRefund`, `publishBalance`) |
| 4 | `PaymentLedgerService`: `recordPayout`, `listPayouts` (Q-F2), `refundDebitContext` (Q-P3), `recordRefundDebit`; `settleDelivery` also returns already-succeeded refunds |
| 5 | Refund webhook locks the **order row first** (`findOrderRefForRefundEvent` unlocked, then `findByRef(…, forUpdate)`), then the refund; debits if the order is `delivered` (replaces the TODO) |
| 6 | Settlement takes back refunds that succeeded while the order was on its way (`refund-debit:<region>:settlement:<publicId>`) and emits `restaurant.balance_changed` |

**Realtime (this phase):** `restaurant.balance_changed { currency, balance }` → `restaurant:<id>` after a settlement credit, a refund debit and a payout (owners watch the balance live). Settlement in Phase 3 starts emitting it once this phase adds the event.

**Acceptance:**
- Balance and payout list match the ledger for a restaurant with several delivered orders.
- Payout larger than the balance → 409; same `Idempotency-Key` twice → one payout.
- Refund after delivery debits the balance, never below 0 (remainder as `adjustment`).
- The restaurant socket receives `restaurant.balance_changed` for each of the three.

**Test notes (2026-11-18):** `play/phase4-e2e.ts` against core (API + worker) and order-service (API + worker): **35/36**.
- Commission: owner can't set it, 20000 bps → 400, admin sets 1000 → 200. Two COD orders settle with commission = 10% of subtotal, balance `+= Σ(subtotal − commission)`, one `restaurant.balance_changed` each (last = DB balance).
- Balance: owner = DB, branch manager 200, staff 403, customer 403, admin needs `?restaurantId` (400 without).
- Payouts: > balance → 409, owner → 403, unknown restaurant → 404; 201, same `Idempotency-Key` twice → one row, balance −500 once, socket event, list newest first, bad range → 400.
- Added 2026-11-19 (not run yet): replay after the Redis response expired → same payout from the ledger key, no 2nd row; two concurrent payouts that together exceed the balance → one 201 + one 409, balance −one payout.
- Refund after delivery (signed refund webhook on a staged *sent* refund; the sandbox rejects test kashierOrderIds): balance −refund, `adjustment` succeeded owner → platform `refund-debit:eg:refund:<id>`, socket event, replay → no 2nd debit. The 2nd refund (rest of the charge) takes back only `share − first refund`: the delivery fee stays with the platform. Charge `is_refunded`.
- Balance too low: debit stops at 0, `refund-shortfall:…` `pending` row for the remainder.
- Refund confirmed while `picked`: balance untouched, taken back at delivery (`refund-debit:eg:settlement:<publicId>`).
- Ledger: end − start = credits − payouts − refund debits for the run.
- **Failed (environment):** `branch.updated` didn't reach order-service because RabbitMQ was not running (port 5672 closed, consumer never started). The test deleted the cached branch instead; the 60 s branch cache TTL is the fallback anyway. Re-run with RabbitMQ up.
- Regression: ws 16/16, Phase 2 32/32, Phase 3 44/44.

**Final run (2026-11-24): 39/39** with RabbitMQ up (docker container `rabbitmq`): `branch.updated` reaches order-service and drops the cached branch; both 2026-11-19 checks pass (ledger-key replay, concurrent payouts → one 201 + one 409). The consumer reconnected to RabbitMQ on its own (no API restart). **Phase 4 done.**
- core-service's `npm run worker` runs `dist/worker.js` (needs a build); in dev use `npx tsx watch src/worker.ts`.

---

## Phase 5 — Archival ✅ (2026-11-24)

Design: [business-logic/archival.md](./business-logic/archival.md) (decisions D1–D10, approved 2026-11-24; D7 = separate process).

| # | Deliverable |
|---|---|
| 1 | `ARCHIVE_DB_<region>_*` required; `npm run migrate:archive` applies all migrations to the archive clusters; migration `add_archival_indexes` (Q-X3, Q-X4) |
| 2 | **`src/archiver.ts`** (`npm run archiver`, its own process; `npm run archive:once` = one pass) + `app/archival/`: per region under an advisory lock, inside the night window, batches of finished orders with `created_at < Jan 1` untouched for 30 days and no money pending → copy order + children to the archive in one archive trx (upsert) → verify identical rows → guarded delete from hot (lock, re-read, compare) → drop emptied month partitions. Payouts and webhook events move by date. |
| 3 | Year-aware reads: a range touching a prior year reads archive + hot, merged with one cursor per source (customer / restaurant / admin orders, order detail, agent earnings, payouts, `GET /payments/:id`) |

**Core-service changes required:** none.

**Realtime (this phase):** none, on purpose. Archiving moves prior-year, already-terminal orders between clusters; their state doesn't change, so there is nothing for a client to react to. (A separate process also has no sockets; progress goes to logs, not to customers.)

**Acceptance:** prior-year orders disappear from hot and appear in archive with identical rows; `GET /customer/orders?year=<last year>` returns them; re-running the archiver is a no-op; balances untouched.

**Test notes (2026-11-24):** `play/phase5-e2e.ts` against core (API) and order-service (API + worker), the archiver started by the suite: **38/38**, twice in a row.
- Staging: 2025 month partitions created on hot; 8 real delivered orders of this year copied with every child row under new ids, 2025 UUIDv7 ids and 2025 timestamps; a 2025 payout and webhook event.
- Race + lock: archiver paused between copy and delete (`ARCHIVE_TEST_PAUSE_MS`), a refund inserted meanwhile → the batch's delete rolled back, R still hot with the refund; a 2nd archiver at the same time → eg `skipped: locked`.
- Move: A (online, refunded), B (COD), G (crash leftover with a stale archive copy → overwritten), R (with the late refund), F (pending shortfall) gone from hot, identical in the archive; C (sent refund pending), D (`ready`), E (touched 5 days ago) stay hot; payout + webhook event moved; 2025-03 / 2025-04 partitions dropped on hot, 2025-06 kept; stuck orders reported; balances untouched.
- Reads: archived detail identical to before (payment summary included); `?year=2025` lists archived and hot orders across pages, each once, newest first; an order in both clusters shown once; restaurant orders / agent earnings / payouts over 2025 ranges; `GET /payments/:id` from the archive. Earnings totals count a row in both clusters twice until the next run (documented, checked).
- Writes: status change and refund on an archived order → 404; late webhook → 200, `process_error = order archived`.
- Idempotency: a 3rd run moves nothing and changes nothing.
- Regression: ws 16/16, Phase 2 32/32, Phase 3 44/44, Phase 4 39/39.

---

## Build cadence

| Phase | Depends on | Delivers | Realtime |
|---|---|---|---|
| 0 | core: API key, outbox | runnable scaffold, socket.io server | `hello`, rooms |
| 1 ✅ | core: permissions, internal endpoints, events | orders end-to-end (COD) | `order.created`, `order.status_changed`, `order.cancelled` |
| 2 ✅ | Kashier sandbox | online payments, refunds | `payment.captured`, `payment.failed` (+ order events) |
| 3 ✅ | Phase 1–2 | offer worker, presence, accept, delivery lifecycle, settlement, earnings | `task.*`, delivery status, `delivery.position` |
| 4 ✅ | Phase 3 | balances, payouts, refund debits | `restaurant.balance_changed` |
| 5 ✅ | all | archive cluster + archiver process + year-aware reads | none (no state change) |

---

## Per-phase done-checklist (copy into every PR)

- [ ] Migration has a working `down()`; names follow `fk_ / uq_ / idx_`; every index has a `-- supports …` comment and a Q-id in [database-design.md §5](./database-design.md#5-query-catalogue--indexes).
- [ ] `npm run migrate` applied on every shard; `EXPLAIN` checked for hot queries.
- [ ] No N+1: no query inside a loop over rows; children via one `whereIn`; core lookups batched/cached.
- [ ] Every repository function takes `conn: Knex` (from `db(region)` or a `trx`) as its last parameter.
- [ ] No network call (core, Kashier, RabbitMQ) inside an open transaction; WS emits and cache deletes after commit.
- [ ] State changes are conditional updates; balances are locked `FOR UPDATE`; multi-row writes in one transaction.
- [ ] Controllers return response DTOs via `sendSuccess` / `sendPaginated`; no internal order ids leaked.
- [ ] Errors come from the module's `errors.ts`; messages match api-contracts §9.
- [ ] Writes that cost money or create orders use `idempotency({ strict: true })`.
- [ ] `pkg/` imports nothing from `lib/`/`app/`; `lib/` imports nothing from `app/` (except the DI container).
- [ ] New env vars added to `lib/config/env.ts` and `.env.example`.
- [ ] `npm run typecheck` passes; docs (contracts, business logic, query catalogue) updated in the same PR.
