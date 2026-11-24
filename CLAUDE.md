# CLAUDE.md — order-service

Guidelines for anyone (human or AI) working in this repository. Read this first, then the relevant file in [`docs/`](docs/README.md).

## What this service is

QuickBite **order-service**: orders, payments (Kashier v3 + COD), the money ledger (`transactions`), restaurant balances & payouts, deliveries, agent presence & earnings, and realtime updates (socket.io). Sibling of `../core-service`, which owns users, auth/JWT, restaurants, branches, RBAC catalog, products and stock.

- Database: PostgreSQL, **one cluster per country** (shard key column/identifier = `region`: `eg`, `ksa`, …), identical schema on every shard. A cold **archive cluster per region** holds prior-year rows (Phase 5).
- Redis: cache, idempotency, **agent presence** (GEO + last-seen sorted set, no table; nearest agent = `GEOSEARCH` from the branch, seen in the last 5 minutes), socket.io adapter, core-event dedupe.
- RabbitMQ: **inbound only** (core → order cache/authorization invalidation). This service publishes nothing to the broker in this milestone.
- Analytics, DevOps, read replicas, incentives/promo codes are **out of scope**.

## Source of truth

| Topic | Document |
|---|---|
| Architecture, sharding, caching, consistency, failure modes | [docs/system-design.md](docs/system-design.md) |
| Tables, constraints, **query catalogue → indexes**, migration order | [docs/database-design.md](docs/database-design.md) |
| Layout, layering, module anatomy, DTO pattern | [docs/folder-structure.md](docs/folder-structure.md) |
| HTTP / WebSocket contracts, error messages | [docs/api-contracts.md](docs/api-contracts.md) |
| core-service (sync + RabbitMQ) and Kashier integration | [docs/integrations.md](docs/integrations.md) |
| Business rules per module | [docs/business-logic/](docs/business-logic/) |
| Build order, acceptance gates, PR checklist | [docs/implementation-plan.md](docs/implementation-plan.md) |

If code and docs disagree, fix one of them in the same change. Never silently diverge.

## Stack (same as core-service)

Node 22, TypeScript (ESM, `"module": "nodenext"`, strict, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, decorators), Express 5, Knex 3 + `pg` (raw-SQL migrations), tsyringe, class-validator / class-transformer, zod (env), ioredis, jsonwebtoken, uuid, helmet, cors, cookie-parser, dotenv, reflect-metadata, tsx, prettier.
Additions for this service: `socket.io`, `@socket.io/redis-adapter`, `amqplib` + `amqp-connection-manager`. No ORM. Prefer `fetch` over axios. Do not add a runtime dependency without a reason in the PR.

## Commands

```bash
npm run dev                         # API + socket.io + core-events consumer (tsx watch src/server.ts)
npm run worker                      # background jobs: delivery offers, payment/refund sweep, partitions, cleanup (tsx watch src/worker.ts)
npm run archiver                    # archival process: nightly, prior-year rows hot -> archive (tsx watch src/archiver.ts)
npm run archive:once                # one archival pass now, ignoring the night window, then exit
npm run build                       # tsc
npm run typecheck                   # tsc --noEmit
npm run migrate                     # latest on EVERY hot shard (REGION=eg limits to one)
npm run migrate:rollback
npm run migrate:archive             # latest on every archive shard
npm run migrate:make -- <name>
npm run format | lint               # prettier
```

## Architecture rules

### Layering (strict)

```
src/app  → business modules (domain-aware)
src/lib  → app-aware glue (env, DI, shards, auth, http helpers, cache, idempotency, core-client, core-events, websocket)
src/pkg  → app-agnostic libraries (redis cache provider, rabbitmq client, kashier client, money, retry, time)
```

- `pkg/` never imports `lib/` or `app/`, never reads `env`. It receives config through constructors and exposes interfaces (`ICacheProvider`, `IMessageBroker`, `IPaymentProvider`).
- `lib/` never imports `app/` (core-service's `lib/auth/guard.ts → app/auth/utils.ts` leak is not copied). The only exception is `lib/di/container.ts`, which registers app classes at boot.
- `app` modules talk to each other only through **services injected via DI**, never through another module's repository or controller.

### Module anatomy (copy core-service)

```
app/<module>/controller/<name>.controller.ts
app/<module>/service/<name>.service.ts
app/<module>/repository/<name>.repo.ts
app/<module>/entity/<name>.entity.ts
app/<module>/dto/<name>.request.dto.ts | <name>.response.dto.ts
app/<module>/enums.ts  errors.ts  types.ts  routes.ts
```

Request flow: `Route → correlationId → resolveRegion → authenticate → requireRegion → requireRole / rbac / requireBranchAccess → idempotency → Controller → Service → Repository → db(region)`.

- **Controllers**: `@injectable()` class, arrow-function handlers, `try { validateBody → one service call → sendSuccess/sendPaginated } catch (err) { next(err) }`. No business logic, no repository imports.
- **Services**: `@injectable()`, dependencies via `@inject(TOKENS.X)`. Own business rules and the transaction (explicit `trx` — see Database rules). Return **response DTOs**.
- **Repositories**: exported async functions, `*_COLUMNS` constant, private `toEntity(row)`, **last parameter `conn: Knex` is required** (a shard from `db(region)` or a `trx`; there is no global `db`), a `// Q-xx` comment pointing to the query catalogue, return `null` when not found.
- **Entities**: class with `constructor(data: Partial<X>)` like core, plus small pure helpers.
- **DTOs**: request DTOs use class-validator; **every HTTP response is a response DTO** built by a static `from(...)`. Never return entities, raw rows or ad-hoc objects. Orders are exposed by `publicId` (UUID); internal bigserial ids of orders never leave the service.
- **Errors**: `export const XxxError = new AppError("Message", status)` in the module's `errors.ts`. Messages are the canonical list in api-contracts §9. No inline error strings.
- **Routes**: module router + `container.resolve<Controller>(TOKENS.X)`; mounted in `src/routes.ts` under `/api`. Plural, kebab-case paths; role-scoped list prefixes (`/customer/...`, `/restaurant/...`).

## Naming conventions

| Thing | Rule | Example |
|---|---|---|
| Files | kebab-case + role suffix | `order-status.service.ts`, `payment-session.repo.ts` |
| Classes | PascalCase + role | `OrderService`, `CreateOrderRequestDTO`, `OrderResponseDTO` |
| Enums | PascalCase name, UPPER_SNAKE members, lowercase DB values | `OrderStatus.PENDING_PAYMENT = 'pending_payment'` |
| Repo functions | verb + noun + `By` + key | `findOrderByPublicId`, `insertOrderItems` |
| Imports | ESM with `.js` suffix; `import type` for types | `import type { Knex } from "knex";` |
| DI tokens | `Symbol.for("<ClassName>")` in `lib/di/tokens.ts` | `TOKENS.OrderService` |
| Permissions | `order:<resource>` + action (core uses `core:<resource>`) | `order:order` / `accept` |
| WS events | `<aggregate>.<past_tense>` | `order.status_changed` |
| Redis keys | region-prefixed for shard data | `eg:GET:/api/restaurant/orders?...` |
| Tables / columns | snake_case plural / snake_case, `is_` booleans, `<verb>_at` timestamps | `orders.picked_at`, `payment_sessions.expires_at` |
| Constraints / indexes | `fk_<table>_<col>`, `uq_<table>_<cols>`, `idx_<table>_<cols>`, `idx_<table>_<col>_gist` | `idx_orders_branch_status_created_at` |
| Migrations | `<timestamp>_create_<table>_table.ts`, raw SQL via `knex.raw`, real `down()` | |

## Database rules

1. **Sharding**: every query runs on `db(region)`; region comes from the `X-Region` header (`lib/sharding/region-resolver.ts`). `POST /orders` may derive it from the branch's country instead. Never mix rows of two regions in one transaction. `X-Region: all` = admin fan-out reads only.
2. **Money** is `INT` minor units (piasters/halalas) with a `currency` column. Never floats, never `DECIMAL` for money. Convert core decimal prices with `pkg/utils/money.toMinor` (string math).
3. **Timestamps** are `TIMESTAMP` (UTC, core style); responses serialize them as ISO 8601.
4. **Enums** are `TEXT` + `CHECK` (core style); TS enums mirror them.
5. **No foreign keys to core-service data** (`customer_id`, `restaurant_id`, `branch_id`, `product_id`, `agent_id`, `src_acc_id`, `dst_acc_id` are logical refs). FKs only inside the shard, named, and each with a supporting index.
6. **Ledger**: every money movement is a `transactions` row; payouts are `transaction_type = 'payout'` (no payouts table). Restaurant account = **owner user id**; platform = **`NULL`**. Balance changes happen in the same transaction as their ledger rows, with `SELECT … FOR UPDATE` on the balance row.
7. **Indexes exist for queries, not columns.** Add the query to the catalogue (database-design §5) with a Q-id and the index in the same PR; each `CREATE INDEX` carries a `-- supports …` comment. Equality columns first, range column last.
8. **No N+1**: no query inside a loop over rows; load children with one `whereIn`; batch core-client lookups.
9. Explicit columns (`*_COLUMNS`), never `SELECT *`. Cursor pagination, never `OFFSET`. Customer/restaurant lists are bounded to the current year (older years → archive cluster).
10. **Transactions**: explicit `const trx = await db(region).transaction(); try { …; await trx.commit(); } catch (err) { await trx.rollback(); throw err; }` (core `auth.service.ts` style). The service owns the trx and passes it to every repo call.
11. **No network calls (core, Kashier, RabbitMQ) while a DB transaction is open.** WebSocket emits and cache deletes run after commit.

## Cross-cutting rules

- **Idempotency**: `Idempotency-Key` required (`idempotency({ strict: true })`) on order placement, payment init, refunds, payouts, status changes. Redis holds the response for 24 h, keyed per user + method + path + key, with a body fingerprint (same key + different body → 409). `POST /orders` and `POST /payments/init` are also backed by the `idempotency_keys` table (Phase 1+). System-side idempotency uses unique constraints (webhook events, `transactions.idempotency_key`, `agent_earnings.delivery_id`).
- **Caching**: `withCache(ttl, userScoped)` for hot reads (keys region-prefixed); explicit `cacheProvider.del` after writes; never use cached data for money or state-transition decisions.
- **Auth**: verify the core-issued JWT (`Authorization: Bearer`, `access_token` cookie fallback). RBAC: `admin` bypasses; restaurant users need `order:*` permissions (resolved from core, Redis-cached) and branch access (`branchIds` in JWT; owners see every branch); customers/agents only their own resources (checked in the service).
- **Kashier**: verify the webhook HMAC before processing; dedupe on `(provider_id, provider_event_id)`; the browser redirect never settles a payment.
- **Core events**: consumer dedupes with Redis `SET NX` on `core-events:dedupe:<eventId>` (24 h); handlers are idempotent cache invalidations; failures go to the DLQ.
- **Logging**: `logger` (structured, with `correlationId`); no `console.log` in `app/` or `lib/`. Never log secrets, tokens, or payment payloads.
- **Correlation**: honour incoming `X-Correlation-ID`, echo it, and forward it to core calls.

## Security & secrets

- **Never read, print, cat, grep, or commit `.env` files.** Only `.env.example` (names, no values) is versioned. Config is read only through `lib/config/env.ts` (zod); new env vars go there first.
- `ACCESS_SECRET` must match core. `CORE_INTERNAL_API_KEY`, `KASHIER_WEBHOOK_SECRET` and RabbitMQ credentials are three different secrets — never reuse one for another.

## Performance mindset

Peak ~620 RPS, 85% reads; hot writes (order insert, payment status update) < 200 ms p95. Every endpoint: one shard, index-backed queries, a handful of queries at most, short transactions, cache-friendly reads, WebSocket push instead of polling. When adding a feature, write its queries and indexes into the catalogue before writing code.

## Working process

- Build in the order of [docs/implementation-plan.md](docs/implementation-plan.md): Phase 0 scaffold → 1 Orders → 2 Payments → 3 Deliveries & agents → 4 Restaurant finance → 5 Archival. One module end-to-end before the next.
- **Realtime ships with each phase**: a phase isn't done until its WebSocket events (realtime.md §5) are emitted after commit through `WsPublisher` and tested.
- Inside a module: **migration → enums/errors → entity → request DTO → response DTO → repository → service → controller → routes → DI → mount → manual smoke test**.
- Each phase lists the core-service changes it depends on; don't start a phase until they exist.
- Use the PR checklist at the end of the implementation plan.

## Intentional deviations from core-service

Typed response DTOs everywhere · `db(region)` instead of a global `db` (repos require `conn`) · `INT` minor-unit money · honour incoming `X-Correlation-ID` · Bearer + cookie auth · auth errors return 401 (core returns 400) · validation errors carry field messages · no `console.log` · no `lib → app` imports. Everything else (stack, layout, naming, raw-SQL migrations, DI style, pagination/filter helpers, response envelope, explicit transactions) follows core-service.
