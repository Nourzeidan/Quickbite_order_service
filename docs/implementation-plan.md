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

Module order: **Phase 0 scaffold → 1 Orders → 2 Payments → 3 Deliveries → 4 Agents → 5 Restaurant finance → 6 WebSocket wiring → 7 Archival**.

Acceptance for every phase: endpoints answer with the documented contract on local Postgres (one DB per region) + Redis + RabbitMQ, idempotency works, RBAC denies the right calls, and (from Phase 6) WebSocket clients receive the documented events.

> **Parallel work on core-service.** This service depends on new core endpoints, permissions, an API-key guard and an outbox. Each phase lists its **core-service changes**. Don't start a phase until they exist (or develop against a stub with the same signature).

---

## Phase 0 — Scaffold & shared infrastructure ✅ (implemented, tested 2026-11-04)

Goal: a runnable Express app with core's conventions plus country sharding, the core-client, the RabbitMQ consumer and the socket.io server. No business modules, **no migrations**.

| Step | Files | Notes |
|---|---|---|
| Project | `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | core's stack and tsconfig (ESM `nodenext`); **add** `socket.io`, `@socket.io/redis-adapter`, `amqplib`, `amqp-connection-manager`. No bcrypt / mailjet. |
| Config | `lib/config/env.ts` | zod; `REGIONS` + `DB_<region>_*` (required) + `ARCHIVE_DB_<region>_*` (optional until Phase 7), Redis, RabbitMQ, core, WS |
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
- COD order → `placed`, stock reserved on core (the `cod_collection` row comes with Phase 2), WS not yet (Phase 6).
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

---

## Phase 2 — Payments

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

---

## Phase 3 — Deliveries

| # | Deliverable |
|---|---|
| 1 | Migrations: `create_deliveries_table`, `create_restaurant_balances_table`, `create_agent_earnings_table` (settlement writes both, so they land with it) |
| 2 | `app/delivery/*`: enums, errors, entity, DTOs, repo (Q-D1..Q-D3), services (`delivery`, `assignment` incl. timeout scan, `settlement`), controller, routes |
| 3 | Order `ready` → auto-assignment after commit; until Phase 4 the candidate source is the admin-provided `agentId` (manual assignment) |
| 4 | Settlement in one trx: commission row + balance credit (`restaurant-balance.repo.ts` owned by `app/restaurant-finance/`, created now with `FinanceService.creditSettlement(trx, …)`) + `agent_earnings` (repo owned by `app/agent/`, created now with `AgentEarningService.record(trx, …)`) |

**Core-service changes required:** `GET /api/internal/users?ids=` (agent snapshots).

**Acceptance:**
- An order marked `ready` gets a delivery for the nearest online agent; two concurrent assigners → one wins.
- Agent rejects or doesn't answer in 30 s → reassigned; after 3 attempts → 409 + order back to `ready`.
- `picked` / `delivered` mirror onto the order; only the assigned agent can move the delivery.
- Delivering an order credits `subtotal − commission`, writes `commission` + `agent_earnings`; replaying `delivered` → 409, no double rows.

---

## Phase 4 — Agents

| # | Deliverable |
|---|---|
| 1 | Migration: `create_agent_presence_table` (+ `postgis`, GIST) |
| 2 | `app/agent/*`: presence (online/offline/ping, Redis GEO + Postgres), tasks, earnings reads, reconciliation loop |
| 3 | Assignment switches from its stub candidate source to `presence:geo` + the PostGIS fallback |

**Core-service changes required:** `delivery_agent` users readable via the users endpoint.

**Acceptance:**
- online → agent appears in `GEOSEARCH`; offline with a `picked` delivery → 409.
- Agent silent for 90 s → reconciled offline.
- Task list and earnings paginate and use Q-D1 / Q-A3.
- Redis flushed → assignment still works through PostGIS.

---

## Phase 5 — Restaurant finance

| # | Deliverable |
|---|---|
| 1 | No new migration (`restaurant_balances` landed in Phase 3) |
| 2 | `app/restaurant-finance/*`: balance read, payouts list, admin `POST /restaurant/payouts`, `debitForRefund` (wired into the refund webhook) |

**Core-service changes required:** none.

**Acceptance:**
- Balance and payout list match the ledger for a restaurant with several delivered orders.
- Payout larger than the balance → 409; same `Idempotency-Key` twice → one payout.
- Refund after delivery debits the balance, never below 0 (remainder as `adjustment`).

---

## Phase 6 — WebSocket wiring

| # | Deliverable |
|---|---|
| 1 | Services emit the events of [realtime.md §5](./business-logic/realtime.md#5-event-catalogue) after commit via `TOKENS.WsServer` |
| 2 | `delivery.position` fan-out from presence pings |
| 3 | Endpoint caches (`GET /restaurant/orders`, `GET /agents/tasks`) invalidated on the same transitions |

**Core-service changes required:** none.

**Acceptance:** a branch dashboard socket receives `order.created` for a COD order and after a payment capture; the customer receives every status change; the agent receives `task.assigned` / `task.cancelled`; a socket can't subscribe to another user's room.

---

## Phase 7 — Archival worker (the only separate process)

| # | Deliverable |
|---|---|
| 1 | `ARCHIVE_DB_<region>_*` required; `npm run migrate:archive` applies all migrations to the archive clusters |
| 2 | `src/worker.ts` + `lib/jobs/archival.worker.ts`: nightly per region, batches of orders with `created_at < Jan 1 of the current year` → copy order + children to archive in one archive trx → verify counts → delete from hot in one hot trx (children first); idempotent per batch (`ON CONFLICT DO NOTHING` on archive inserts) |
| 3 | Year-aware reads: customer/restaurant/agent list and detail endpoints use `dbArchive(region)` for prior years |

**Core-service changes required:** none.

**Acceptance:** prior-year orders disappear from hot and appear in archive with identical rows; `GET /customer/orders?year=<last year>` returns them; re-running the worker is a no-op; balances untouched.

---

## Build cadence

| Phase | Depends on | Delivers |
|---|---|---|
| 0 | core: API key, outbox | runnable scaffold |
| 1 | core: permissions, internal endpoints, events | orders end-to-end (COD) |
| 2 | Kashier sandbox | online payments, refunds |
| 3 | Phase 1–2 | assignment, delivery lifecycle |
| 4 | Phase 3 | presence, tasks, earnings |
| 5 | Phase 3–4 | balances, settlement, payouts |
| 6 | Phase 1–5 | realtime events |
| 7 | all | archive cluster + worker |

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
