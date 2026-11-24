# Integrations

## 1. Overview

| Peer | Direction | Transport | Purpose |
|---|---|---|---|
| core-service | order → core | **sync HTTP** (`/api/internal/*`) | branch / restaurant / address / product lookups, role permissions, stock reservation |
| core-service | core → order | **async RabbitMQ** (inbound only) | cache + authorization invalidation (`product.*`, `branch.*`, `restaurant.*`, `rbac.*`) |
| core-service | clients → both | JWT | core issues tokens; order-service only verifies (`ACCESS_SECRET`) |
| Kashier v3 | order → Kashier | HTTPS | create payment sessions, refunds |
| Kashier v3 | Kashier → order | HTTPS webhook | payment / refund outcomes |

This service publishes **nothing** to RabbitMQ in this milestone.

---

## 2. core-service — synchronous

### 2.1 Authentication between services

- Every call from order-service carries `api-key: <CORE_INTERNAL_API_KEY>` plus `X-Correlation-ID` (and `Idempotency-Key` on mutating calls).
- Core checks it with a new `requireInternalApiKey` middleware (`core-service/src/lib/auth/api-key.ts`, plain equality against `env.internal.apiKey`).
- No dedicated `internal/` module in core: each core module mounts its own internal routes in its `routes.ts`, prefixed `/internal/...`, guarded by `requireInternalApiKey`. Service and repository method names stay caller-agnostic (`findBranchById`, never `findBranchForInternal`).

### 2.2 Client — `lib/core-client/core-client.ts`

```ts
coreClient.request<T>({ method, path, body?, correlationId?, idempotencyKey? }): Promise<T>
```

- Timeout `CORE_TIMEOUT_MS` (default 800 ms) per attempt.
- 3 attempts with exponential backoff (50 ms → capped at 500 ms) on 5xx / network errors / timeouts — **only for GETs and calls with an `Idempotency-Key`**. 4xx are never retried.
- 5xx / timeout after retries → 503 `Core service unavailable`; 404 → `null` from the endpoint wrapper so the service can raise its own error; other 4xx → `AppError` with core's status.
- Endpoint wrappers are added by the phase that needs them; each one sits behind the Redis read-through cache from [system-design.md §4](./system-design.md#4-caching-redis).

### 2.3 Endpoints this service needs on core (to be added to core-service)

| Wrapper | Core endpoint | Phase | Returns |
|---|---|---|---|
| `branch.client.getBranches` / `getBranch` | `GET /api/internal/branches?ids=1,2,3` | 1 | `[{ id, restaurantId, countryCode, currency, lat, lng, isActive, acceptOrders, deliveryFee, commission, deliveryRadiusKm }]` |
| `restaurant.client.getRestaurants` / `getRestaurant` | `GET /api/internal/restaurants?ids=1,2,3` | 1 | `[{ id, ownerId, name, status }]` |
| `address.client.getAddress` | `GET /api/internal/customers/:userId/addresses/:id` | 1 | `{ id, userId, lat, lng, addressText }` (404 if not owned) |
| `product.client.getBranchProducts` | `POST /api/internal/branches/:id/products/batch` `{ productIds }` | 1 | `[{ productId, name, imageUrl, price: "55.00", stock, isAvailable }]` — one call for the whole cart |
| `stock.client.reserveStock` | `POST /api/internal/branches/:id/stock/reserve` `{ orderPublicId, items }` (idem) | 1 | 204, or 409 with the products that underflowed (atomic decrement) |
| `stock.client.releaseStock` / `releaseStockBatch` | `POST /api/internal/stock/release` `{ orders: [{ branchId, orderPublicId }] }` (idem, ≤ 100) | 1 | 204 — restock on cancel/reject; the payment sweep releases a whole batch in one call |
| `permission.client.getRolePermissions` | `GET /api/internal/roles/:roleName/permissions` | 1 | `["order:order:read", ...]` |
| `user.client.getUsers` | `GET /api/internal/users?ids=1,2,3` | 3 | `[{ id, name, phone }]` — batched agent snapshots |

**No per-row core calls.** Every lookup of branches, restaurants or users goes through `readThroughMany` (`lib/core-client/read-through.ts`): ONE Redis `MGET` for all ids, then ONE core batch call (≤ 100 ids) for the misses. `getBranch(id)` / `getRestaurant(id)` are the same path with one id. A loop that calls a client once per row is a bug.

Core prices are `DECIMAL` strings; convert with `pkg/utils/money.toMinor("55.00") === 5500` (string math, never float).

### 2.4 Required changes in core-service (dependency list)

| # | Change | Needed by |
|---|---|---|
| 1 | `requireInternalApiKey` middleware + `INTERNAL_API_KEY` env | Phase 0 |
| 2 | Transactional outbox `events_outbox` + `src/worker.ts` drain (`croner`, `FOR UPDATE SKIP LOCKED`, publisher confirms) + `core.events` exchange | Phase 0 |
| 3 | Seed `order:*` permissions and role mapping ([rbac.md §1](./business-logic/rbac.md#1-permissions-seeded-in-core-service)) | Phase 1 |
| 4 | `restaurant_branches.delivery_fee INT NOT NULL DEFAULT 0` (minor units) and commission in basis points | Phase 1 |
| 5 | Internal endpoints of §2.3 | Phase 1 / 3 |
| 6 | Publish `product.*`, `branch.*`, `restaurant.suspended`, `rbac.permissions_changed` through the outbox | Phase 1 |
| 7 | JWT carries `restaurantId`, `restaurantRole`, `branchIds` for restaurant users (already in core's `express.d.ts` shape) | Phase 1 |
| 8 | `delivery_agent` users have `name` / `phone` readable via the users endpoint | Phase 3 |

Until an endpoint exists, develop against a stub of the wrapper with the same signature.

---

## 3. core-service — asynchronous (RabbitMQ, inbound only)

### 3.1 Topology

| Component | Name | Declared by |
|---|---|---|
| Topic exchange | `core.events` (durable) | core worker; re-asserted here (idempotent) |
| Queue | `order-service.core-events` (durable, `x-dead-letter-exchange = core.events.dlx`) | order-service at boot |
| Bindings | `product.#`, `branch.#`, `restaurant.#`, `rbac.#` (`#` because keys have several words, e.g. `product.stock.changed`) | order-service |
| DLX / DLQ | `core.events.dlx` (topic) → `order-service.core-events.dlq` (bound with `#`) | order-service |
| Prefetch | `RABBITMQ_PREFETCH` (32) | order-service |
| Auth | per-service vhost user/password inside `RABBITMQ_URL`; no HMAC — the broker is the trust boundary | ops |

`pkg/messaging/rabbitmq/rabbitmq.client.ts` wraps `amqp-connection-manager`: automatic reconnect, and every channel's `setup` (asserts + consume) re-runs after a reconnect, so topology and the consumer come back by themselves.

### 3.2 Envelope

```jsonc
{ "eventId": "<uuid>", "eventType": "product.stock.changed", "occurredAt": "<ISO>", "payload": { } }
```

Routing key = `eventType`. `eventId` is stable across redeliveries (core's outbox row id).

### 3.3 Consumer flow — `lib/core-events/consumer.ts`

1. Parse the envelope; malformed → nack (no requeue) → DLQ.
2. `SET core-events:dedupe:<eventId> 1 NX EX 86400`. Already set → ack and stop. Redis error → log and continue (handlers are idempotent).
3. Look up the handler for `eventType`. None registered → log `no handler, acking` and ack (unknown types are not poison).
4. Run the handler. Success → ack. Throw → nack without requeue → DLQ (alert on DLQ depth; to replay, delete the dedupe key and re-publish).

Delivery is **at-least-once**; dedupe + idempotent handlers make it effectively-once. Handlers register with `registerHandler(eventType, handler)` from their module's phase (`lib/core-events/handlers/*.handler.ts`).

### 3.4 Events consumed

| Event | Trigger in core | Action here | Phase |
|---|---|---|---|
| `product.stock.changed` | stock decrement / edit | delete `core:product:price:<branchId>:<productId>` | 1 |
| `product.price.changed` | menu price edit | delete `core:product:price:<branchId>:<productId>` | 1 |
| `branch.updated` | branch metadata change | delete `core:branch:<branchId>` | 1 |
| `branch.deactivated` | branch turned off | delete `core:branch:<branchId>` (next lookup sees `isActive=false` → new orders rejected) | 1 |
| `restaurant.suspended` | admin suspends | delete `core:restaurant:<id>`; WS alert to admins listing that restaurant's open orders for review | 1 |
| `rbac.permissions_changed` | role/permission edit | delete `core:rbac:perms:<roleName>` | 1 |

### 3.5 Reliability requirement on core

Core writes the domain row and the outbox row in **one transaction** (service layer, never the repo). A separate worker drains the outbox with `FOR UPDATE SKIP LOCKED`, publishes with publisher confirms, and stamps `dispatched_at` only after the broker acks. Publishing directly in the request path can lose events on crash and is not acceptable.

---

## 4. Kashier v3

References: [payment sessions](https://developers.kashier.io/payment/payment-sessions), [webhooks](https://developers.kashier.io/webhooks/setup).

| Concern | Rule |
|---|---|
| Client | `pkg/payments/kashier/kashier.client.ts` — config via constructor (`baseUrl, merchantId, apiKey`), implements `IPaymentProvider`; instantiated in `lib/payments/init.ts` from env (Phase 2) |
| Create session | amount in minor units, currency from the order, merchant order reference `<region>_<publicId>`, return / fail URLs from env, server webhook URL `https://<host>/api/payments/webhook/kashier` |
| Timeouts / retries | 3 attempts with backoff on 5xx / network; 4xx not retried (502 to the client) |
| Webhook auth | HMAC verified with `KASHIER_WEBHOOK_SECRET` (`kashier.signature.ts`, constant-time compare) **before** storing; mismatch → 401 + alert |
| Dedupe | `payment_webhook_events (provider_id, provider_event_id)` unique; duplicate → 200 |
| Amount check | webhook amount/currency must equal the session's; mismatch → event stored with `process_error`, no state change, alert |
| Settlement | only the verified webhook settles; the browser redirect is cosmetic |
| Refunds | `IPaymentProvider.refund(providerReferenceId, amount)`; result confirmed by a refund webhook |
| Secrets | `KASHIER_API_KEY`, `KASHIER_WEBHOOK_SECRET` only in env; never logged; `raw_init_payload` stores no secrets |

Env (Phase 2): `KASHIER_BASE_URL` (sessions, `test-api` / `api`), `KASHIER_FEP_BASE_URL` (order operations / refunds, `test-fep` / `fep`), `KASHIER_MERCHANT_ID`, `KASHIER_SECRET_KEY` (`Authorization` header), `KASHIER_API_KEY` (`api-key` header), `KASHIER_WEBHOOK_SECRET` (HMAC key — Kashier signs with the **Payment API Key**), `KASHIER_RETURN_URL`, `KASHIER_WEBHOOK_URL` (public URL of the webhook, sent as `serverWebhook`), `KASHIER_TIMEOUT_MS`, `KASHIER_WEBHOOK_AMOUNT_UNIT` (`major`/`minor`, unit of `data.amount`), `PAYMENT_SESSION_TIMEOUT_MIN`, `PAYMENT_SWEEP_INTERVAL_SEC`. Kashier has no fail URL: `failureRedirect: true` sends failures to the return URL too.

Kashier v3 calls as implemented (`pkg/payments/kashier/`):

| Call | Request | Notes |
|---|---|---|
| Create session | `POST {KASHIER_BASE_URL}/v3/payment/sessions` | body `amount` is a major-unit string (`"100.00"`), `order` = merchant reference, `expireAt`, `merchantRedirect`, `serverWebhook`; response `_id` + `sessionUrl` |
| Refund | `PUT {KASHIER_FEP_BASE_URL}/v3/orders/{kashierOrderId}` | `{apiOperation: "REFUND", reason, transaction: {amount}}` (major units). **Never retried** (a timed-out refund may have succeeded): on timeout the refund row stays `pending` and the webhook decides |
| Webhook | `x-kashier-signature` = HMAC-SHA256 hex of the sorted `data.signatureKeys` as `k=v&…` (values URL-encoded like `query-string`) | events `pay`/`capture` → payment, `refund`/`partial_refund` → refund, others acked and ignored; outcome in `data.status` (`SUCCESS`/`FAILURE`/`PENDING`) |

Merchant reference: `<region>_<publicId>` for the first session of an order, `<region>_<publicId>_<n>` for later ones (Kashier wants `order` unique per merchant). Dedupe id of a webhook: `<event>:<transactionId>:<status>`.
