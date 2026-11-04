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

Auth: `customer`. `year` defaults to the current year; older years read the archive cluster (Phase 7). Pagination by `createdAt desc`.

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

Auth: `admin`. `X-Region: all` allowed. Filters: `status`, `branchId`, `from`, `to`. **200** paginated `OrderSummaryResponseDTO[]` with a per-shard tagged cursor. Range defaults to Jan 1 of the current year → now and may not exceed one year (same for `/restaurant/orders`). `itemsCount` is the number of order lines.

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

## 3. Deliveries

### 3.1 `POST /api/deliveries/assign/{orderPublicId}` **(idem)**

Auth: admin (`order:delivery assign`). Without `agentId` the auto-assignment runs; with it, manual assignment.

```ts
class AssignDeliveryRequestDTO {
    @IsOptional() @IsInt() @Min(1) agentId?: number;
}
```

**201** `DeliveryResponseDTO`:

```ts
{
    id: number;
    orderPublicId: string;
    agent: { id: number; name: string; phone: string | null };
    status: DeliveryStatus;
    pickup: { lat: number; lng: number };
    dropoff: { lat: number; lng: number };
    distanceMeters: number | null;
    assignedAt: string;
}
```

Errors: 409 `Order is not ready for delivery`, 409 `Order already has an active delivery`, 409 `No eligible agents`.

### 3.2 `POST /api/deliveries/reassign/{orderPublicId}` **(idem)**

Auth: admin. **201** `DeliveryResponseDTO` (the new row). Errors: 409 `Max reassignment attempts reached`, 409 `Order has no active delivery`.

### 3.3 `PATCH /api/deliveries/{deliveryId}/status` **(idem)**

Auth: the assigned `delivery_agent`.

```ts
class UpdateDeliveryStatusRequestDTO {
    @IsIn(['accepted','rejected','picked','delivered'])
    status!: 'accepted' | 'rejected' | 'picked' | 'delivered';

    @IsOptional() @IsString() @MaxLength(500)
    reason?: string;
}
```

**200** `DeliveryStatusResponseDTO { id, status, updatedAt }`. Errors: 404 `Delivery not found`, 409 `Invalid status transition`.

---

## 4. Agents

All agent endpoints: `requireRole(delivery_agent)`; the agent is `req.user.userId`.

| Endpoint | Body | 200 | Errors |
|---|---|---|---|
| `POST /api/agents/presence/online` | `PresenceRequestDTO { @IsLatitude() lat, @IsLongitude() lng }` | `{ online: true }` | — |
| `POST /api/agents/presence/offline` | — | `{ online: false }` | 409 `Agent has an active delivery` |
| `POST /api/agents/presence/ping` | `PresenceRequestDTO` | `{ online: true }` | 409 `Agent is not online` |
| `GET /api/agents/tasks?status=` | — | paginated `DeliveryTaskResponseDTO[]` | — |
| `GET /api/agents/earnings?from=&to=` | — | `AgentEarningsResponseDTO` | — |

```ts
class DeliveryTaskResponseDTO {
    deliveryId: number;
    orderPublicId: string;
    status: DeliveryStatus;
    pickup: { lat: number; lng: number };
    dropoff: { lat: number; lng: number; addressText: string };
    itemsCount: number;
    total: number;
    currency: string;
    paymentMethod: 'online' | 'cod';
    cashToCollect: number;               // total for COD, 0 for online
    assignedAt: string;
}

class AgentEarningsResponseDTO {
    range: { from: string; to: string };
    totals: { count: number; sum: number; currency: string };
    items: Array<{ orderPublicId: string; amount: number; currency: string; earnedAt: string }>;
    nextCursor: string | null;
}
```

---

## 5. Restaurant finance

### 5.1 `GET /api/restaurant/balance`

Auth: `rbac(order:finance, read)`; restaurant from the JWT. Not cached (must be fresh).

**200** `RestaurantBalanceResponseDTO { restaurantId, balances: [{ currency, balance }], asOf }`.

### 5.2 `GET /api/restaurant/payouts?from=&to=`

Auth: `rbac(order:finance, read)`. Defaults: last 90 days. **200** paginated `PayoutResponseDTO[]`:

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

**201** `PayoutResponseDTO`. Errors: 404 `Restaurant not found`, 409 `Insufficient balance`.

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

`GET /api/health` — no auth, no region. **200** `{ status: "ok", shards: [{ region, ok }] }` when every hot shard answers, **503** `{ status: "error", shards: [...] }` otherwise. Archive shards are not checked (they may not exist before Phase 7).

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
| `Delivery not found` | 404 | deliveries |
| `Order is not ready for delivery` | 409 | deliveries |
| `Order already has an active delivery` | 409 | deliveries |
| `Order has no active delivery` | 409 | deliveries |
| `No eligible agents` | 409 | deliveries |
| `Max reassignment attempts reached` | 409 | deliveries |
| `Agent has an active delivery` | 409 | agents |
| `Agent is not online` | 409 | agents |
| `Restaurant not found` | 404 | finance |
| `Insufficient balance` | 409 | finance |

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
