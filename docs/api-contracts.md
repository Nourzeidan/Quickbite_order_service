# API Contracts — `order-service`

All endpoints are mounted under `/api`. This is the corrected version of the root draft `../api-contracts.md` (kept untouched); changes are listed in §10.

---

## 0. Conventions

### 0.1 Headers (in)

| Header | Required where | Notes |
|---|---|---|
| `Authorization: Bearer <jwt>` | all authenticated endpoints | issued by core-service `/api/auth/login`; the `access_token` cookie is accepted as a fallback |
| `X-Region` | every request except health and the webhook | `eg`, `ksa`, … ; `all` only on admin fan-out reads; optional on `POST /orders` (derived from the branch) |
| `Idempotency-Key` | marked **(idem)** below | 1–255 chars; scoped to the caller; 24 h |
| `X-Correlation-ID` | optional | honoured if sent, generated otherwise |

### 0.2 Headers (out)

| Header | When |
|---|---|
| `X-Correlation-ID` | always |
| `X-Cache: HIT \| MISS` | endpoints behind `withCache` |
| `Idempotent-Replayed: true` | a stored idempotent response was returned |

### 0.3 Envelope (same as core)

```jsonc
// success
{ "success": true, "data": <DTO>, "meta": { ... } }
// paginated
{ "success": true, "data": [<DTO>, ...], "meta": { "nextCursor": "...", "hasMore": true, "count": 20 } }
// error
{ "error": "<message from §9>" }
```

### 0.4 Status codes

200 OK · 201 Created · 202 Accepted (async refund) · 400 validation / bad region · 401 not authenticated / bad signature · 403 not authorized · 404 not found · 409 conflict (illegal transition, idempotency mismatch, stock, balance) · 503 upstream unavailable (core / Kashier).

### 0.5 Data formats

- **Money**: integer minor units with a sibling `currency` (`"EGP"`, `"SAR"`). Formatting is the client's job.
- **Timestamps**: ISO 8601 UTC strings.
- **IDs**: the order's public id is a UUID (`publicId`); other ids are numbers and only meaningful with `X-Region`. Internal order ids never leave the service.
- **Pagination**: `?cursor=&limit=20&sortBy=createdAt&sortOrder=desc` (core helpers).
- **Filters**: `?filter[<field>][<op>]=<value>`, ops `eq, gt, lt, gte, lte, like, in` (core shape), whitelisted per endpoint.

### 0.6 Roles & permissions

Roles come from the core JWT: `customer`, `restaurant_user` (+ `restaurantRole` `owner | branch_manager | staff`, `restaurantId`, `branchIds`), `delivery_agent`, `admin`. `admin` bypasses `rbac()`. Restaurant permissions are seeded in core as `order:<resource>` + action — full table in [business-logic/rbac.md](./business-logic/rbac.md).

---

## 1. Orders

### 1.1 `POST /api/orders` — place order **(idem, strict)**

Auth: `customer`. `X-Region` optional (derived from the branch; must match it if sent).

```ts
class CreateOrderRequestDTO {
    @IsInt() @Min(1)                branchId!: number;
    @IsInt() @Min(1)                customerAddressId!: number;
    @IsEnum(PaymentMethod)          paymentMethod!: PaymentMethod;         // 'online' | 'cod'
    @ArrayMinSize(1) @ArrayMaxSize(50)
    @ValidateNested({ each: true }) @Type(() => OrderItemInputDTO)
                                    items!: OrderItemInputDTO[];
}

class OrderItemInputDTO {
    @IsInt() @Min(1)                productId!: number;
    @IsInt() @Min(1) @Max(50)       quantity!: number;
}
```

**201** `OrderResponseDTO`:

```ts
class OrderResponseDTO {
    publicId: string;
    region: string;
    status: OrderStatus;                 // 'pending_payment' (online) | 'placed' (cod)
    paymentMethod: 'online' | 'cod';
    restaurantId: number;
    branchId: number;
    deliveryAddress: { lat: number; lng: number; addressText: string };
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: string;
    items: OrderItemResponseDTO[];
    createdAt: string;
}

class OrderItemResponseDTO {
    productId: number;
    name: string;
    imageUrl: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
}
```

Online orders then call `POST /api/payments/init` (two small idempotent calls instead of one).

`publicId` is a UUIDv7 (time-ordered). Errors: 400 `Validation failed: …`, 400 `Region not resolved`, 404 `Address not found`, 409 `Region mismatch`, 409 `Branch is not accepting orders`, 409 `Product not found`, 409 `Product unavailable`, 409 `Out of stock`, 409 `Idempotency key reused with a different body`, 503 `Core service unavailable`.

### 1.2 `GET /api/orders/{publicId}`

Auth: customer (own), restaurant_user (own restaurant; non-owners only their branches), admin. Anyone else → 404 `Order not found` (no existence leak).

**200** `OrderDetailResponseDTO extends OrderResponseDTO`:

```ts
{
    delivery: DeliverySummaryResponseDTO | null;
    paymentSummary: {
        method: 'online' | 'cod';
        status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
        amount: number;
        refundedAmount: number;
        currency: string;
    };
    timeline: { acceptedAt?: string; rejectedAt?: string; readyAt?: string; assignedAt?: string;
                pickedAt?: string; deliveredAt?: string; cancelledAt?: string };
    cancelReason: string | null;
}

class DeliverySummaryResponseDTO {
    id: number;
    status: DeliveryStatus;
    agent: { id: number; name: string; phone: string | null } | null;
    assignedAt: string;
    acceptedAt: string | null;
    pickedAt: string | null;
    deliveredAt: string | null;
}
```

One repository call for the header + items + latest delivery + ledger rows (no N+1).

### 1.3 `GET /api/customer/orders?year=YYYY`

Auth: `customer`. `year` defaults to the current year; a prior year reads the archive **and** the hot cluster, merged, each order once (archival.md §6). Pagination by `createdAt desc`; the opaque cursor holds one position per source.

**200** paginated `OrderSummaryResponseDTO[]`:

```ts
class OrderSummaryResponseDTO {
    publicId: string;
    status: OrderStatus;
    total: number;
    currency: string;
    itemsCount: number;
    restaurantId: number;
    branchId: number;
    createdAt: string;
}
```

### 1.4 `GET /api/restaurant/orders`

Auth: `rbac(order:order, read)` + `requireBranchAccess('branchId')`. Query: `branchId` (required), `status?`, `from?`, `to?` (ISO, within one year), pagination. Cached 10 s per URL.

**200** paginated `OrderSummaryResponseDTO[]`.

### 1.5 `GET /api/admin/orders` (fan-out)

Auth: `admin`. `X-Region: all` allowed. Filters: `status`, `branchId`, `from`, `to`. **200** paginated `OrderSummaryResponseDTO[]` with a per-shard tagged cursor. Range defaults to Jan 1 of the current year → now and may not exceed one year (same for `/restaurant/orders`). A range that touches a prior year also reads the archive cluster (same for `/restaurant/orders`, `/agents/earnings`, `/restaurant/payouts`). `itemsCount` is the number of order lines.

### 1.6 `PATCH /api/orders/{publicId}/status` **(idem, strict)**

Auth depends on the target (see [orders.md §1](./business-logic/orders.md#1-status-machine)): restaurant_user with `order:order accept` (accepted/rejected), `update` (preparing/ready), `cancel` (cancelled); customer for cancel-within-window; admin always.

```ts
class UpdateOrderStatusRequestDTO {
    @IsIn(['accepted','rejected','preparing','ready','cancelled'])
    status!: 'accepted' | 'rejected' | 'preparing' | 'ready' | 'cancelled';

    @IsOptional() @IsString() @MaxLength(500)
    reason?: string;                     // required for rejected / cancelled
}
```

**200** `OrderStatusResponseDTO { publicId, status, updatedAt }`.

Errors: 404 `Order not found`, 409 `Invalid status transition`, 409 `Cancellation window expired`, 400 `Reason is required`.

---

## 2. Payments

### 2.1 `POST /api/payments/init` **(idem, strict)**

Auth: `customer` (own order). `X-Region` required.

```ts
class InitPaymentRequestDTO {
    @IsUUID() orderId!: string;          // order publicId
}
```

**200** `PaymentInitResponseDTO`:

```ts
{
    sessionId: number;                   // payment_sessions.id
    providerSessionId: string;           // Kashier's id
    redirectUrl: string;
    expiresAt: string;
    amount: number;
    currency: string;
}
```

An existing `initialized`/`pending` session for the order is returned instead of creating a new one.

Errors: 404 `Order not found`, 409 `Order is not pending payment`, 503 `Payment provider unavailable`, 502 `Payment provider rejected the request`.

### 2.2 `POST /api/payments/webhook/{provider}`

No auth; `provider ∈ {kashier}`; region comes from the payload's merchant order reference (`<region>_<publicId>`), not from a header. Signature header verified with HMAC (`KASHIER_WEBHOOK_SECRET`) **before** anything is stored.

**200** on success **and** on duplicates (Kashier stops retrying). 401 `Invalid signature`. 500 only if processing throws (Kashier retries; the stored event keeps `process_error`).

### 2.2b `GET /api/payments/return`

Browser landing page after Kashier's payment page (`KASHIER_RETURN_URL` may point here). No auth, returns a static HTML message, **reads nothing and changes nothing**: the query string is customer-controlled; the outcome comes from the webhook.

### 2.3 `GET /api/payments/{paymentId}`

Auth: admin, or restaurant_user with `order:payment read` for their own restaurant's orders. `paymentId` = `transactions.id`.

**200** `PaymentResponseDTO`:

```ts
{
    id: number;
    orderPublicId: string | null;
    type: 'charge' | 'refund' | 'commission' | 'cod_collection' | 'payout' | 'adjustment';
    method: 'online' | 'cod' | 'bank_transfer' | 'system';
    provider: 'kashier' | 'cod' | null;
    providerReferenceId: string | null;
    status: 'pending' | 'succeeded' | 'failed' | 'reversed';
    amount: number;
    currency: string;
    isRefunded: boolean;
    refundedPaymentId: number | null;
    createdAt: string;
    updatedAt: string;
}
```

### 2.4 `POST /api/payments/{paymentId}/refund` **(idem, strict)**

Auth: admin.

```ts
class RefundRequestDTO {
    @IsOptional() @IsInt() @Min(1)            amount?: number;    // omitted → full remaining amount
    @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
```

**202** `{ refundId: number, status: 'pending', amount: number, currency: string }` — final state arrives by webhook.

Errors: 404 `Payment not found`, 409 `Payment is not refundable`, 409 `Refund exceeds the refundable amount`.

---

## 3. Deliveries & agents

Phase 3, design: [business-logic/deliveries.md](./business-logic/deliveries.md). **Agents choose their orders**: the worker offers `ready` orders over WebSocket (`task.offered`), the agent accepts by REST; first accept wins. No auto-assignment, no admin assignment. Every endpoint: `requireRole(delivery_agent)` + `X-Region`; the agent is `req.user.userId`; orders are addressed by `orderPublicId`.

```ts
class AgentTaskResponseDTO {             // offers, available list, tasks, accept response
    orderPublicId: string;
    status: OrderStatus;
    pickup: { lat: number; lng: number } | null;
    dropoff: { lat: number; lng: number; addressText: string };
    itemsCount: number;
    total: number;
    currency: string;
    paymentMethod: 'online' | 'cod';
    cashToCollect: number;               // COD: total; online: 0
    deliveryFee: number;
    distanceMeters: number | null;       // agent -> pickup when known
    assignedAt: string | null;
    createdAt: string;
}
class DeliveryStatusResponseDTO { orderPublicId: string; status: OrderStatus; updatedAt: string }
```

### 3.1 `POST /api/deliveries/{orderPublicId}/accept` **(idem)**

The agent takes a `ready` order. Must be online (pinged ≤ 5 min) and within `ASSIGNMENT_RADIUS_METERS` of the pickup; holds no other `assigned`/`picked` order. **200** `AgentTaskResponseDTO` (status `assigned`; repeating an accept you already won returns the same).

Errors: 404 `Order not found`, 409 `Order already taken`, 409 `Order is not ready for delivery`, 409 `Agent is not online`, 409 `Agent is too far from the pickup`, 409 `Agent has an active delivery`.

### 3.2 `POST /api/deliveries/{orderPublicId}/decline`

The agent won't take this offer; it is never offered to them again. No order change. **204**. Errors: 404 `Order not found`.

### 3.3 `PATCH /api/deliveries/{orderPublicId}/status` **(idem)**

Only the order's current agent (anyone else → 404).

```ts
class UpdateDeliveryStatusRequestDTO {
    @IsEnum(['picked','delivered','released']) status!: 'picked' | 'delivered' | 'released';
    @IsOptional() @IsString() @MaxLength(500) reason?: string;      // for released
}
```

`picked`: `assigned → picked`. `delivered`: `picked → delivered` + settlement (commission, balance, COD collected, agent earning) in one transaction. `released`: `assigned → ready` (offered to others, never again to this agent).
**200** `DeliveryStatusResponseDTO`. Errors: 404 `Order not found`, 409 `Invalid status transition`, 409 `Order payment is not settled` (online order without a succeeded charge).

---

## 4. Agents

| Endpoint | Body / query | 200 | Errors |
|---|---|---|---|
| `POST /api/agents/presence/online` | `PresenceRequestDTO { @IsLatitude() lat, @IsLongitude() lng }` | `{ online: true }` | — |
| `POST /api/agents/presence/ping` | `PresenceRequestDTO` | `{ online: true }` | 409 `Agent is not online` |
| `POST /api/agents/presence/offline` | — | `{ online: false }` (an `assigned` order is released) | 409 `Agent has an active delivery` (holding a `picked` order) |
| `GET /api/agents/available-orders` | — | `AgentTaskResponseDTO[]`: ready orders within the radius of the last ping, nearest first, minus declined | 409 `Agent is not online` |
| `GET /api/agents/tasks?status=&cursor=&limit=` | `status ∈ assigned, picked, delivered, cancelled` | paginated `AgentTaskResponseDTO[]` (this year, newest first) | 400 bad cursor |
| `GET /api/agents/earnings?from=&to=&cursor=&limit=` | default: this month | `AgentEarningsResponseDTO` | 400 bad range / cursor |

```ts
class AgentEarningsResponseDTO {
    range: { from: string; to: string };
    totals: Array<{ count: number; sum: number; currency: string }>;
    items: Array<{ orderPublicId: string | null; amount: number; currency: string; earnedAt: string }>;
    nextCursor: string | null;
}
```

Clients ping every ~30 s while online. Presence lives in Redis only (no table).

---

## 5. Restaurant finance

### 5.1 `GET /api/restaurant/balance`

Auth: `rbac(order:finance, read)`; restaurant from the JWT; admins pass `?restaurantId=` (400 without). Not cached (must be fresh).

**200** `RestaurantBalanceResponseDTO { restaurantId, balances: [{ currency, balance }], asOf }`.

### 5.2 `GET /api/restaurant/payouts?from=&to=`

Auth: `rbac(order:finance, read)` (admins: `?restaurantId=`). Defaults: last 90 days, max one year, `cursor` + `limit` (≤ 100). **200** paginated `PayoutResponseDTO[]`:

```ts
{ id: number; amount: number; currency: string; status: 'pending' | 'succeeded' | 'failed' | 'reversed';
  providerReferenceId: string | null; createdAt: string }
```

### 5.3 `POST /api/restaurant/payouts` **(idem, strict)**

Auth: admin. Records a bank transfer that operations already executed.

```ts
class CreatePayoutRequestDTO {
    @IsInt() @Min(1)                restaurantId!: number;
    @IsInt() @Min(1)                amount!: number;
    @IsIn(['EGP','SAR'])            currency!: 'EGP' | 'SAR';
    @IsString() @MinLength(1)       providerReferenceId!: string;
    @IsOptional() @IsString() @MaxLength(500) note?: string;
}
```

**201** `PayoutResponseDTO`. Errors: 404 `Restaurant not found`, 409 `Insufficient balance`. A replay with the same `Idempotency-Key` returns the same payout (Redis 24 h, then `transactions.idempotency_key = payout:<hash>`).

Every balance change emits `restaurant.balance_changed { currency, balance }` → `restaurant:<id>` (settlement credit, refund debit, payout).

---

## 6. WebSocket (socket.io)

### 6.1 Connect

```ts
const socket = io("wss://<host>", {
    path: "/ws",
    auth: { token: "<jwt>" },            // or the access_token cookie (browsers)
    transports: ["websocket"],
});
```

Query-string tokens are **not** accepted (they leak into logs). A bad or missing token → `connect_error` with `Not Authenticated`.

### 6.2 Client → server

```ts
socket.emit("subscribe", "branch:42", (ack) => { /* { ok: true } | { ok: false, error: "not permitted" } */ });
socket.emit("unsubscribe", "branch:42");
```

### 6.3 Server → client

```ts
socket.on("hello", ({ allowedChannels }) => {});      // once, after connect
socket.on("subscribed", ({ channel }) => {});
socket.on("order.status_changed", (payload) => {});   // domain events, see 6.4
```

Heartbeat is socket.io's own (`pingInterval = WS_HEARTBEAT_SEC`).

### 6.4 Channels & events

| Channel | Who may subscribe | Events |
|---|---|---|
| `customer:<userId>` | that customer | `order.status_changed`, `order.cancelled`, `payment.captured`, `payment.failed`, `delivery.status_changed`, `delivery.position` |
| `restaurant:<restaurantId>` | restaurant users of that restaurant | `order.created`, `order.cancelled` |
| `branch:<branchId>` | members of that branch (owners: every branch in `branchIds`) | `order.created`, `order.status_changed`, `order.cancelled`, `delivery.status_changed` |
| `agent:<agentId>` | that agent | `task.assigned`, `task.cancelled` |

Payloads are response DTOs or documented subsets, e.g. `order.status_changed = { orderPublicId, status, updatedAt }`. Full catalogue in [business-logic/realtime.md](./business-logic/realtime.md).

---

## 7. Health

`GET /api/health` — no auth, no region. **200** `{ status: "ok", shards: [{ region, ok }], archiveShards: [{ region, ok }] }` when every hot shard answers, **503** `{ status: "error", … }` otherwise. Archive shards are reported but never fail the check: when one is down, only prior-year reads fail.

**Archived orders (Phase 5):** `GET /orders/:publicId` and `GET /payments/:id` find them in the archive. Writes go to hot only, so a status change, delivery action or refund on an archived order gets the existing **404** (`Order not found` / `Payment not found`). A late Kashier webhook for an archived order is acknowledged with **200** and recorded with `process_error = "order archived"`.

---

## 8. Internal / async

This service exposes **no** internal HTTP endpoints. core → order traffic arrives over RabbitMQ (`core.events` → queue `order-service.core-events`), envelope:

```jsonc
{
    "eventId": "<uuid, stable across redeliveries>",
    "eventType": "product.stock.changed",
    "occurredAt": "2026-04-16T15:00:00.000Z",
    "payload": { /* event-specific */ }
}
```

This service emits **no** outbound events in this milestone. Details: [integrations.md §3](./integrations.md#3-core-service--asynchronous-rabbitmq-inbound-only).

---

## 9. Error messages (canonical)

Every message is an `AppError` constant in a module's `errors.ts` (core style). No ad-hoc strings.

| Message | HTTP | Module |
|---|---|---|
| `Not Authenticated` | 401 | shared (`lib/auth`) |
| `Not Authorized for such Action !` | 403 | shared (`lib/auth`) |
| `You do not have access to this branch` | 403 | shared (`lib/auth`) |
| `Validation failed: <field messages>` | 400 | shared (`lib/validation`) |
| `Region not resolved` | 400 | shared (`lib/sharding`) |
| `Invalid region` | 400 | shared (`lib/sharding`) |
| `Region "all" is not allowed here` | 400 | shared (`lib/sharding`) |
| `Missing Idempotency-Key header` | 400 | shared (`lib/idempotency`) |
| `Idempotency key reused with a different body` | 409 | shared |
| `Request with this Idempotency-Key is already in progress` | 409 | shared |
| `Idempotency service unavailable` | 503 | shared |
| `Core service unavailable` | 503 | shared (`lib/core-client`) |
| `Order not found` | 404 | orders |
| `Region mismatch` | 409 | orders |
| `Branch is not accepting orders` | 409 | orders |
| `Product not found` | 409 | orders |
| `Product unavailable` | 409 | orders |
| `Out of stock` | 409 | orders |
| `Invalid status transition` | 409 | orders, deliveries |
| `Cancellation window expired` | 409 | orders |
| `Address not found` | 404 | orders (address missing or not the caller's) |
| `Validation failed: from must be before to and within one year` | 400 | orders (list ranges) |
| `Validation failed: cursor is invalid` | 400 | orders (lists) |
| `Validation failed: quantity must not be greater than 50` | 400 | orders (after merging duplicate products) |
| `Reason is required` | 400 | orders, deliveries |
| `Order is not pending payment` | 409 | payments |
| `Payment not found` | 404 | payments |
| `Payment is not refundable` | 409 | payments |
| `Refund exceeds the refundable amount` | 409 | payments |
| `Invalid signature` | 401 | payments |
| `Payment provider unavailable` | 503 | payments |
| `Payment provider rejected the request` | 502 | payments |
| `Order payment is not settled` | 409 | payments (delivery settlement) |
| `Order already taken` | 409 | deliveries |
| `Order is not ready for delivery` | 409 | deliveries |
| `Agent is too far from the pickup` | 409 | deliveries |
| `Agent has an active delivery` | 409 | deliveries, agents |
| `Agent is not online` | 409 | deliveries, agents |
| `Restaurant not found` | 404 | finance |
| `Insufficient balance` | 409 | finance |
| `Validation failed: restaurantId is required` | 400 | finance (admin reads) |

---

## 10. Changes vs the root draft

1. Auth is `Authorization: Bearer` (what core uses) with the `access_token` cookie as fallback.
2. Header name aligned with core: `X-Correlation-ID` (draft: `X-CorrelationId`).
3. Admin role is core's `admin` (draft: `system_admin`, which core does not have).
4. Permissions follow core's naming: `order:order`, `order:payment`, `order:delivery`, `order:finance` (draft: `orders:*`, `payments:*`, …).
5. `X-Region` rules per endpoint; `POST /orders` may omit it; added `Region mismatch`, `Invalid region`. The draft also mentioned `?region=` and cookies — dropped, header only.
6. WebSocket: no `?token=` query auth.
7. Error bodies are `{ error: message }` exactly like core; messages are listed in §9 (draft mixed codes, messages and `details`).
8. Webhook region is taken from the merchant order reference; duplicates → 200.
9. `GET /orders/{id}` returns `timeline` (from the order's `<verb>_at` columns) instead of `history` (there is no history table) and `cancelReason`.
10. `DeliveryTaskResponseDTO` adds `cashToCollect`; `AgentEarningsResponseDTO` is defined here.
11. Added `GET /api/admin/orders` (fan-out read the draft referenced but never defined).
12. Health returns per-shard status.
13. No incentives anywhere.
