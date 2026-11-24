# System Design — order-service

## 1. Scope

From the PRD and the whiteboard (`img.png`, `img_1.png`), QuickBite is split into:

| Service | Owns | Store |
|---------|------|-------|
| **core-service** (exists) | users, auth (JWT), restaurants, branches, RBAC catalog, menus, products, stock, customer addresses | PostgreSQL + PostGIS, Redis |
| **order-service** (this) | orders, order items, payments (Kashier + COD), ledger/transactions, restaurant balances, payouts, deliveries, agent presence & earnings, realtime (WS) | **PostgreSQL per country** (hot) + archive cluster per country, Redis |
| analytics-service (later) | aggregates, reports | NoSQL |

Why orders are split out of core:

1. **Different write profile.** Core is read-heavy (menu browsing); this service is the high-write, money-critical path. They scale and tune independently.
2. **Isolation.** Money and order data live in their own clusters; a noisy menu query cannot starve checkout.
3. **Sharding fits orders, not the catalog.** A customer orders in their own country; the product catalog is global.
4. **Independent failure domain.** A core incident degrades (cached branches/products keep checkout alive) instead of taking order placement down.

PRD requirements this service is accountable for:

- Order placement (online / COD), tracking, history (current year hot, older years from the archive).
- Restaurant order management + status updates with per-restaurant RBAC (owner / branch_manager / staff).
- Delivery assignment (automatic by proximity + availability, manual admin override, reassignment with limits), delivery status updates, agent history and read-only earnings.
- Payments: online payment confirmed **before** the restaurant sees the order, idempotent handling; COD collected by the agent.
- Restaurant running balance (credited on delivered, commission deducted automatically), payouts recorded by admin, full history.
- Admin: full visibility, manual overrides, reconciliation.
- NFRs: checkout < 1–3 s, strong consistency for orders & payments, per-country locality, peak handling, strong authorization boundaries, secure payments.

## 2. High-level architecture

```mermaid
flowchart LR
    subgraph Clients
      CA[Customer app]
      RD[Restaurant dashboard]
      DA[Delivery app]
      AD[Admin dashboard]
    end

    CA & RD & DA & AD -- HTTPS /api --> OS
    CA & RD & DA & AD -- WSS /ws --> OS
    CA & RD & AD -- HTTPS --> CS

    subgraph order-service [order-service (stateless, N instances per region)]
      OS[HTTP API + socket.io + core-events consumer]
      AW[worker - offers, sweeps, partitions, cleanup]
      AR[archiver - nightly archival]
    end

    OS -- sync HTTP (branch, address, products, permissions, reserveStock) --> CS[core-service]
    OS -- sessions / refunds --> K[Kashier v3]
    K -- webhooks --> OS

    CS -- outbox → core.events --> MQ{{RabbitMQ}}
    MQ -- product.# branch.# restaurant.# rbac.# --> OS

    OS --> R[(Redis)]
    OS --> PGEG[(PG eg — hot)]
    OS --> PGKSA[(PG ksa — hot)]
    AW --> PGEG & PGKSA
    AR --> PGEG & PGKSA
    AR --> ARC[(PG archive per region)]
    OS -. prior-year reads .-> ARC
```

One codebase, three processes:

- `src/server.ts` — Express API, socket.io server on the same HTTP server, the RabbitMQ `core-events` consumer. Serves requests only.
- `src/worker.ts` (`npm run worker`) — every background job: the delivery offer job (every 10 s: take back stale tasks, offer ready orders to the nearest agents, prune presence), the payment / refund sweep, partition maintenance, idempotency cleanup. Each job uses `FOR UPDATE SKIP LOCKED`, conditional updates or advisory locks, so running N workers is safe. It emits WebSocket events through `@socket.io/redis-emitter` (same Redis channel as the API's adapter).

- `src/archiver.ts` (`npm run archiver`) — archival only (Phase 5, business-logic/archival.md). Its own process on purpose: the worker's jobs are short and time-critical, archival is long, heavy and never urgent, so it gets its own pools and event loop and never delays an offer. One archiver per region at a time (advisory lock). `npm run archive:once` runs one pass now.

All three are stateless; all state lives in PostgreSQL, Redis and RabbitMQ.

Request pipeline (same shape as core-service):

```
Route → correlationId → resolveRegion → authenticate → requireRegion → requireRole / rbac / requireBranchAccess → idempotency → Controller → Service → Repository → db(region)
```

## 3. Sharding by country

### 3.1 Model

- **Shard key: country** — `eg`, `ksa`, … The column and the code identifier are named `region` so the router stays generic if a country is ever sub-sharded (`eg-cai`, `eg-alx`). In this milestone `region == country code`.
- Each region has its **own PostgreSQL cluster** running the **same migrations** (`order_service_<region>`), plus an archive cluster (`order_service_archive_<region>`) with the same schema.
- Every sharded table has `region TEXT NOT NULL` right after `id` — redundant with the shard, kept for safety checks, archival exports and fan-out merges.
- All rows of one order (items, payment sessions, ledger rows, deliveries, earnings) live on the same shard → every business transaction is a **single-shard local ACID transaction**. No 2PC.

Why country and not another key:

| Candidate | Locality | Hot-spot risk | Cross-shard reads |
|---|---|---|---|
| `customer_id` | poor | low | restaurant view of all its orders → fan-out |
| `restaurant_id` | poor | very high (one big chain) | customer history → fan-out |
| `order_id` | none | low | every list is fan-out |
| **country** | **high** | medium (meal peaks) | rare — admin global views only |

A customer in Egypt orders from an Egyptian branch, delivered by an Egyptian agent, and the branch dashboard reads only Egyptian orders: all actors are co-located. Meal-time hot spots are absorbed by Redis caching of the pending-orders list, WebSocket push instead of polling, and horizontal scaling of the stateless tier.

### 3.2 Routing

`src/lib/knex/knex.ts` + `src/lib/sharding/`:

```ts
db(region: string): Knex;           // hot cluster pool for the region (lazy, cached); throws on unknown region
dbArchive(region: string): Knex;    // archive cluster pool (Phase 5)
pingAll(): Promise<ShardPing[]>;    // health
destroyAll(): Promise<void>;        // graceful shutdown
```

- Built from env: `REGIONS=eg,ksa` and, per region, `DB_<region>_HOST|PORT|USERNAME|PASSWORD|NAME` (+ `ARCHIVE_DB_<region>_*`, required since Phase 5). One Knex pool per region and cluster, `DB_POOL_MAX` per pool.
- `resolveRegion` (global middleware) reads **only the `X-Region` header**. A value that is not a configured region (or `all`) → 400 `Invalid region`. Region is **not** a JWT claim, path segment, query param or cookie.
- `requireRegion()` (per route) → 400 `Region not resolved` when missing; `requireRegion({ allowAll: true })` accepts `all` (admin fan-out reads only). Writes always resolve to one concrete region.
- **`POST /orders`**: if `X-Region` is absent, the service derives the region from the chosen branch's `countryCode` (cached branch metadata from core). If it is present and differs from the branch's country → 409 `Region mismatch`. An order can never land on the wrong shard.
- Controllers pass `req.region` to services; services call `db(region)` and pass that `Knex` (or a `trx` opened on it) to repositories. **Repositories never default to a global connection** (deviation from core, where repos default to `conn = db`).

### 3.3 Identifiers

- Internal ids are `BIGSERIAL` **per shard**. The order's public id is a **UUID** (`public_id`), globally unique.
- Other public ids (`paymentId` = `transactions.id`, `deliveryId`, `sessionId`) are bigints and are always used together with `X-Region`.
- Cross-service ids (`customer_id`, `restaurant_id`, `branch_id`, `product_id`, `agent_id`, `src_acc_id`, `dst_acc_id`) are core ids — global, not shard-local.

### 3.4 Admin fan-out (`X-Region: all`)

Admin global views only, never in the hot path. The controller runs the same paginated query on each shard in parallel (capped), each with `limit + 1`, merges on `(created_at DESC, id DESC)` and returns the first `limit`. The cursor is tagged per shard (`{eg: <cursor>, ksa: <cursor>}`, base64url). With two countries today this is cheap.

### 3.5 What lives outside the shard key

- `payment_providers` — tiny lookup, **replicated** to every shard by its seed migration (same rows everywhere).
- Migrations — the same files run against every hot shard (and every archive shard from Phase 5).
- The Kashier merchant account — one tenant (or one per region, depending on the Kashier contract).

### 3.6 Adding a region

1. Provision PG for the hot and archive clusters; enable `postgis`.
2. Add the region to `REGIONS`, add `DB_<region>_*` (and `ARCHIVE_DB_<region>_*`).
3. `npm run migrate` (and `npm run migrate:archive`) — applies to every configured shard.
4. Core: make sure branches in that country report the new country code/currency.

## 4. Caching (Redis)

Same `ICacheProvider` / `withCache` as core, plus `trySet` (atomic `SET NX`). Keys holding shard data are **region-prefixed**.

### Layer A — read-through cache of core data

| Key | Source (core) | TTL | Invalidation |
|-----|---------------|-----|--------------|
| `core:branch:<branchId>` | `GET /api/internal/branches/:id` | 60 s | `branch.updated`, `branch.deactivated` events, TTL |
| `core:product:price:<branchId>:<productId>` | `POST /api/internal/branches/:id/products/batch` | 30 s | `product.price.changed`, `product.stock.changed` events |
| `core:restaurant:<id>` | `GET /api/internal/restaurants/:id` | 5 min | `restaurant.suspended`, TTL |
| `core:rbac:perms:<roleName>` | `GET /api/internal/roles/:role/permissions` | 5 min (stale-serve up to 1 h if core is down) | `rbac.permissions_changed` |

### Layer B — endpoint cache (`withCache`)

| Endpoint | TTL | Scope |
|---|---|---|
| `GET /restaurant/orders?branchId=&status=placed` | 10 s | region + URL (branch is in the URL) |
| `GET /agents/tasks?status=` | 5 s | region + URL + user |

Both are also pushed over WebSocket on change, so well-behaved clients don't poll; the cache only absorbs misbehaving ones. Services delete the keys after a committed transition.

### Layer B2 — order data cache

| Key | Content | TTL | Invalidation |
|---|---|---|---|
| `<region>:order:<publicId>` | order row + items (`OrderCacheService`) | 5 s | deleted after every committed status change / post-commit void |

Serves `GET /orders/:publicId` (tracking polls). One key per order, shared by every caller: the access check (customer owns / restaurant member / admin) runs on every request against the cached row, so the cache never decides visibility. Transitions, payments and settlement always read Postgres. Redis down → straight to Postgres.

### Layer C — idempotency

`idempotency:<region>:<userId>:<METHOD>:<path>:<key>` → `{fingerprint, statusCode, body}`, 24 h, plus a 30 s `…:lock` key held while the first request is in flight. `POST /orders` and `POST /payments/init` are also persisted in `idempotency_keys` (Phase 1+) so a Redis loss can't double-create an order or a payment session.

### Layer D — agent presence

| Key | Content | Updated by |
|---|---|---|
| `presence:geo:<region>` | GEO set: agent → last ping position | online / ping; removed on offline / by the worker |
| `presence:seen:<region>` | sorted set: agent → last ping time | online / ping; pruned after 5 min |
| `offers:<region>:<publicId>` / `declined:…` | who has / refused an offer | offer worker, accept, decline |

Presence is Redis-only (no table): it is ephemeral and rebuilt by pings within ~30 s. Agents are never auto-assigned — the worker offers orders to the nearest fresh agents and the agent accepts (deliveries.md). "Busy" is read from `orders`, never cached.

### Layer E — socket.io fan-out

`@socket.io/redis-adapter` uses Redis pub/sub so `io.to(room).emit(...)` from any instance reaches the socket wherever it is connected. No sticky load balancer, no per-region fan-out channel.

### Layer F — core-event dedupe

`core-events:dedupe:<eventId>` (`SET NX EX 86400`) — see §6.

Rules:

- Never use cached data for a money or state-transition decision. Settlement, payouts and transitions read and lock Postgres.
- Redis outage → the service keeps working: cache misses go to core/DB, idempotency falls back to the `idempotency_keys` table on the two critical paths, assignment falls back to the PostGIS query, socket.io cross-instance fan-out pauses (sockets stay open; clients can re-fetch via REST).

## 5. Consistency & concurrency

- **One transaction per business operation, on one shard**: order + items (+ COD `cod_collection` row); webhook event + session + charge + order transition; settlement (ledger rows + balance + earnings + order/delivery status).
- **Explicit transactions** (core `auth.service.ts` style):
  ```ts
  const trx = await db(region).transaction();
  try {
      await insertOrder(order, trx);
      await insertOrderItems(items, trx);
      await trx.commit();
  } catch (err) {
      await trx.rollback();
      throw err;
  }
  ```
- **Conditional state transitions** instead of read-then-write:
  ```sql
  UPDATE orders SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
  WHERE id = ? AND status = 'placed'
  RETURNING ...;
  ```
  0 rows ⇒ `Invalid status transition` (409). Race-free under concurrent requests.
- **Money paths** lock the balance row: `SELECT … FROM restaurant_balances WHERE restaurant_id = ? AND currency = ? FOR UPDATE`, then insert ledger rows and update the balance in the same transaction (details in §9).
- **Idempotency**: `Idempotency-Key` for client writes; unique constraints for system writes (`payment_webhook_events (provider_id, provider_event_id)`, `transactions.idempotency_key`, `agent_earnings.delivery_id`).
- **Side effects after commit**: WebSocket emits, cache deletes and core `reserveStock` run only after `trx.commit()`.
- **Strong vs eventual**: orders, payments, balances = strong (single-shard PG). Core stock, cached core data and realtime pushes = eventual.

## 6. Communication with core-service

### 6.1 Synchronous (HTTP)

`lib/core-client/core-client.ts` — a thin `fetch` wrapper:

- Sends `api-key: <CORE_INTERNAL_API_KEY>` and `X-Correlation-ID` on every call (`Idempotency-Key` when the call mutates).
- Timeout `CORE_TIMEOUT_MS`; retries 3× with exponential backoff (capped at 500 ms) on 5xx / network errors — **only for GETs and calls that carry an `Idempotency-Key`**.
- Non-2xx → `AppError` (5xx/timeout → 503 `Core service unavailable`).
- Endpoint wrappers (`branch.client.ts`, `product.client.ts`, `address.client.ts`, `permission.client.ts`, `stock.client.ts`) are added in the phase that needs them.

Use cases: validate a branch not in cache, fetch fresh price/stock at order time, fetch the customer's address for the delivery snapshot, load role permissions, reserve stock after an order commits.

Degradation per call: branch/address lookups must succeed (503 otherwise); permission lookups serve stale cache up to 1 h, then deny.

We never import core's code: hard service boundary, two databases, two deploy lifecycles.

### 6.2 Asynchronous (RabbitMQ, inbound only)

This service **emits nothing** to the broker in this milestone (no analytics consumer yet; clients get updates over WebSocket; Kashier calls us by webhook). The only async path is core → order for cache and authorization invalidation:

| Component | Name | Owner |
|---|---|---|
| Topic exchange | `core.events` (durable) | core (re-asserted here, idempotent) |
| Queue | `order-service.core-events` (durable, DLX arg) | this service |
| Bindings | `product.#`, `branch.#`, `restaurant.#`, `rbac.#` | this service |
| Dead-letter exchange / queue | `core.events.dlx` / `order-service.core-events.dlq` | this service |
| Prefetch | 32 | this service |

Consumer flow: parse envelope → `SET core-events:dedupe:<eventId> 1 NX EX 86400` → already set ⇒ ack and skip → dispatch to the handler registered for `eventType` (unknown type ⇒ log + ack) → success ⇒ ack; throw ⇒ nack without requeue (→ DLQ). If Redis is down the dedupe step is skipped and the handler runs anyway — handlers are idempotent cache deletes, so a duplicate is harmless. Full event list in [integrations.md §3](./integrations.md#3-core-service--asynchronous-rabbitmq-inbound-only).

Core must publish through a **transactional outbox** (domain write + outbox row in one trx; a worker drains with `FOR UPDATE SKIP LOCKED` and publisher confirms). Publishing straight from a request can lose events on crash and is not acceptable.

Why RabbitMQ and not an HTTP webhook from core: core's write path doesn't depend on our availability, bursts buffer in the broker, future consumers bind their own queues, and retry/DLQ come for free.

### 6.3 Auth

Same JWT (`ACCESS_SECRET`) as core; order-service only **verifies** tokens, it never issues them.

## 7. Payments

Kashier v3 Payment Sessions + server webhooks. An online order is created in `pending_payment` (invisible to the restaurant). `POST /payments/init` creates a session and returns the hosted-page `redirectUrl`. Only the **HMAC-verified webhook** moves the order to `placed`; the browser redirect never settles anything. COD orders go straight to `placed` with a `pending` `cod_collection` ledger row. Unpaid `pending_payment` orders are cancelled after `PAYMENT_SESSION_TIMEOUT_MIN` (15 min) by the payment sweep. Details: [business-logic/payments.md](./business-logic/payments.md).

## 8. Realtime

socket.io on the same HTTP server, path `/ws`. Handshake auth with `auth.token` or the `access_token` cookie (no query-string tokens — they leak into logs). Rooms = channels: `customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>`, `agent:<agentId>`. Clients `subscribe` to rooms they are permitted to join. Services emit after commit via `io.to(room).emit(event, payload)`; the Redis adapter fans out across instances. The scaffold exists from Phase 0; every phase emits its own events (`WsPublisher`; the worker via a Redis emitter). Details: [business-logic/realtime.md](./business-logic/realtime.md).

## 9. Strong consistency for money

All money paths run in one transaction on one shard and lock the balance row first.

- **On delivered** (Deliveries module):
  1. `SELECT … FROM restaurant_balances WHERE (restaurant_id, currency) FOR UPDATE` (insert the row first if missing: `INSERT … ON CONFLICT DO NOTHING`).
  2. Online: the `charge` (`succeeded`) must exist. COD: flip `cod_collection` `pending → succeeded`.
  3. Insert `transactions(type='commission', method='system', src=ownerId, dst=NULL)`; set `orders.commission`.
  4. `balance += subtotal − commission`.
  5. Insert `agent_earnings` (unique `delivery_id` ⇒ idempotent).
  6. Delivery → `delivered`, order → `delivered`. Commit.
- **Payout** (admin): lock balance → `balance ≥ amount` else 409 `Insufficient balance` → insert `transactions(type='payout', method='bank_transfer', src=NULL, dst=ownerId)` → `balance −= amount` → commit.
- **Refund after settlement**: the refund webhook debits the balance by the restaurant's share, capped at the current balance; any remainder is recorded as an `adjustment` row. The balance never goes negative.

`transactions.idempotency_key` (unique) and the webhook-event unique key guarantee nothing is recorded twice on retries.

## 10. Archival & retention

PRD: only the **current year** is queryable from the hot DB; older data moves to other storage.

1. A separate Postgres **archive cluster per region** (`order_service_archive_<region>`) runs the same migrations.
2. The archiver process (Phase 5, `src/archiver.ts`) copies prior-year, finished orders in batches (with their items, sessions, transactions, earnings), verifies the archive holds identical rows, then deletes them from hot under a lock-and-compare guard — per region, idempotent per batch. Payouts and webhook events move by date; emptied month partitions are dropped. Details: [business-logic/archival.md](business-logic/archival.md).
3. Customer/restaurant/agent reads take `year=YYYY` (or a date range): current year → `db(region)`; a range touching a prior year → `dbArchive(region)` **and** `db(region)`, merged with one cursor per source (a prior-year order can still be hot during its 30-day grace). Same repositories, different connections (`lib/knex/read-sources.ts`).
4. Restaurant balances are not archived (they are running totals).

All list queries stay bounded (one year at most) so index range scans stay small.

## 11. Capacity & performance

PRD envelope: 200k DAU, ~5.4M req/day, avg ~62 RPS, **peak ~620 RPS**, 85% reads / 15% writes, ~146 GB/yr of orders.

- Peak writes ≈ 93 RPS across regions — fine for one primary per region with small transactions and covering indexes.
- Reads are dominated by tracking and lists: served by index range scans (`(customer_id, created_at DESC)`, `(branch_id, status, created_at DESC)`), short endpoint caches, and WebSocket push replacing polling.
- Checkout budget (p95 < 1.5 s): core lookups ~100 ms (mostly cached), PG transaction ~20 ms, Kashier session ~400 ms (separate call).
- Hot writes (order insert, payment status update) < 200 ms p95.
- No N+1: list endpoints fetch orders, then one `whereIn('order_id', ids)` for items; core lookups are batched (`products/batch`).
- Pools: `DB_POOL_MAX` per shard, sized so `instances × pool_max < max_connections`.

## 12. Failure handling

| Failure | Behaviour |
|---------|-----------|
| One region's Postgres down | only that region fails (503); managed failover restores within seconds |
| Redis down | cache misses → core/DB; idempotency falls back to `idempotency_keys` on critical paths; assignment uses PostGIS; WS cross-instance fan-out paused |
| Kashier down | COD unaffected; `POST /payments/init` → 503 with retry; order stays `pending_payment` up to 15 min; init is idempotent |
| Duplicate Kashier webhook | unique `(provider_id, provider_event_id)` → 200, no reprocessing |
| core-service down | cached branches/products keep checkout working; uncached branches → 503; permissions served stale up to 1 h |
| `reserveStock` rejected after commit | order voided (`cancelled`, reason `out_of_stock_post_commit`), COD row voided / online never charged |
| RabbitMQ down | `amqp-connection-manager` reconnects and re-declares topology; core's outbox accumulates; caches go stale only until TTL |
| Handler throws on a core event | message → DLQ; alert on DLQ depth; replay after the fix (delete the dedupe key to force re-run) |
| No agent available | order stays `ready`; retries up to `MAX_REASSIGNMENT_ATTEMPTS`, then an admin alert over WS |
| WS instance crash | socket.io client reconnects to any instance; missed events recoverable via REST |

## 13. Security

- JWT verified on every HTTP request and WS handshake. RBAC per restaurant (role → permissions from core) + branch scoping (`branchIds` in JWT) + ownership checks in services (customer owns order, agent owns delivery). Unauthorized access to a specific order returns `Order not found` (no existence leak).
- A request's resolved region is asserted against the resource: a region-A request can never read a region-B row.
- Unauthenticated endpoints: `GET /api/health` and `POST /api/payments/webhook/:provider` (HMAC-verified before anything is stored).
- Outbound calls to core use the `api-key` header; it is never logged.
- Idempotency keys are user-scoped, so one user can't replay another user's response.
- Secrets only from env (zod-validated). Never log request bodies of payment endpoints, tokens, or signatures. `.env` files are never committed, read or printed by tooling.
- helmet, CORS allow-list, JSON body size limit.

## 14. Configuration (env names only)

`PORT, NODE_ENV, CORS_ORIGINS, ACCESS_SECRET, REGIONS, DB_POOL_MAX, DB_MIGRATION_DIR, DB_MIGRATION_EXTENSION, DB_<region>_HOST|PORT|USERNAME|PASSWORD|NAME, ARCHIVE_DB_<region>_HOST|PORT|USERNAME|PASSWORD|NAME, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, RABBITMQ_URL, RABBITMQ_CORE_EVENTS_EXCHANGE, RABBITMQ_CORE_EVENTS_QUEUE, RABBITMQ_CORE_EVENTS_BINDINGS, RABBITMQ_CORE_EVENTS_DLX, RABBITMQ_CORE_EVENTS_DLQ, RABBITMQ_PREFETCH, CORE_SERVICE_BASE_URL, CORE_INTERNAL_API_KEY, CORE_TIMEOUT_MS, WS_HEARTBEAT_SEC`.

Added by later phases: `KASHIER_BASE_URL, KASHIER_MERCHANT_ID, KASHIER_API_KEY, KASHIER_WEBHOOK_SECRET, KASHIER_RETURN_URL, KASHIER_FAIL_URL, PAYMENT_SESSION_TIMEOUT_MIN` (Phase 2); `ASSIGNMENT_RADIUS_METERS, ASSIGNMENT_CANDIDATES, AGENT_ACCEPT_TIMEOUT_SEC, MAX_REASSIGNMENT_ATTEMPTS, AGENT_SHARE_BPS` (Phase 3); `PRESENCE_STALE_SEC` (Phase 4); `CUSTOMER_CANCEL_WINDOW_SEC, SERVICE_FEE_BPS` (Phase 1).
