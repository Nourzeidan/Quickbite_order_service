# Payments Module

Code: `src/app/payment/`, `src/pkg/payments/`. Tables: `payment_providers`, `payment_sessions`, `transactions`, `payment_webhook_events`. Endpoints: [api-contracts §2](../api-contracts.md#2-payments). Phase 2.

## 1. Responsibilities

- Start online payments (Kashier v3 Payment Sessions) for `pending_payment` orders.
- Verify and process Kashier webhooks; move orders to `placed` only on a verified capture.
- Own every write to the `transactions` ledger (other modules call `PaymentService` / `TransactionService` with their `trx`).
- Refunds (admin and automatic on reject/cancel) and COD bookkeeping.
- Expire unpaid online orders (payment sweep).

## 2. Enums (`app/payment/enums.ts`)

```ts
export enum PaymentSessionStatus { INITIALIZED = 'initialized', PENDING = 'pending', AUTHORIZED = 'authorized',
    CAPTURED = 'captured', FAILED = 'failed', EXPIRED = 'expired', CANCELLED = 'cancelled' }
export enum TransactionType { CHARGE = 'charge', REFUND = 'refund', COMMISSION = 'commission',
    PAYOUT = 'payout', COD_COLLECTION = 'cod_collection', ADJUSTMENT = 'adjustment' }
export enum TransactionMethod { ONLINE = 'online', COD = 'cod', BANK_TRANSFER = 'bank_transfer', SYSTEM = 'system' }
export enum TransactionStatus { PENDING = 'pending', SUCCEEDED = 'succeeded', FAILED = 'failed', REVERSED = 'reversed' }
export enum PaymentProvider { KASHIER = 1, COD = 2 }      // fixed ids, seeded on every shard
```

## 3. `POST /payments/init` — `PaymentService.init(region, user, dto, correlationId)`

```
1. order = findOrderByPublicId(orderId, db(region))                    [Q-O1]
   not found / not the caller's → 404 Order not found
   status !== 'pending_payment'  → 409 Order is not pending payment
2. live = findOpenSessionByOrderId(order.id, conn)                       [Q-P2]
   status in ('initialized','pending') and expires_at > NOW() → return it (domain-level idempotency)
3. session = kashier.createSession({
       amount: order.total, currency: order.currency,
       merchantOrderId: `${region}_${order.publicId}`,
       returnUrl, failUrl, serverWebhook,
   })                                                     ← network, NO trx open
   5xx/timeout after retries → 503 Payment provider unavailable (order stays pending_payment)
   4xx                       → 502 Payment provider rejected the request (+ alert)
4. trx: insertPaymentSession({status: 'initialized', providerSessionId, redirectUrl,
        expiresAt: order.created_at + PAYMENT_SESSION_TIMEOUT_MIN, rawInitPayload}) +
        insertIdempotencyKey(...) → commit
5. return PaymentInitResponseDTO
```

## 4. Webhook — `POST /payments/webhook/:provider`

### 4.1 Security

- `provider` must be `kashier`.
- HMAC of the raw payload with `KASHIER_WEBHOOK_SECRET` (`pkg/payments/kashier/kashier.signature.ts`, `crypto.timingSafeEqual`). Missing/invalid → 401 `Invalid signature`, logged as an alert, **nothing stored**.
- Region = prefix of the merchant order reference (`eg_<uuid>`), validated with `isRegion`.

### 4.2 Dedupe

`INSERT INTO payment_webhook_events (...) ON CONFLICT (provider_id, provider_event_id) DO NOTHING` [Q-P7]. 0 rows → duplicate → **200** immediately.

### 4.3 Processing — one transaction on the order's region

1. `session = findSessionByProviderSessionId(...)` [Q-P1]; amount/currency must match the session, else store `process_error`, no state change, alert.
2. By Kashier event:
   - **payment success / capture**:
     - session → `captured`, `raw_last_payload`.
     - insert `transactions(type='charge', method='online', provider_id=1, provider_reference_id, status='succeeded', amount=total, src=customerId, dst=NULL, idempotency_key=provider_event_id)`.
     - order `pending_payment → placed` (conditional). If the order was already `cancelled` by the sweep → keep it cancelled and queue a full refund (money arrived late).
   - **payment failed**:
     - session → `failed`; insert `charge` with `status='failed'` (audit).
     - order stays `pending_payment` (customer may retry `init` until the sweep expires it).
   - **refund succeeded / failed**:
     - pending `refund` row by `provider_reference_id` [Q-P4] → `succeeded` / `failed`.
     - on success: original charge `is_refunded = (refunded sum = charge amount)`; if the order was already delivered (settled) → debit the restaurant share via `FinanceService.debitForRefund(trx, …)` (locks the balance, capped at the balance, remainder as `adjustment`).
3. Stamp `processed_at`. If anything threw: rollback, then store `process_error` on the event and return 500 so Kashier retries.
4. After commit (success path): WS `payment.captured` → `customer:<id>`; `order.created` → `branch:<id>`, `restaurant:<id>`. Failure: `payment.failed` → `customer:<id>`.

The browser redirect (`KASHIER_RETURN_URL`) never changes state.

## 5. Payment sweep — `PaymentSweepService` (in-process loop, every 60 s per shard)

```sql
SELECT id FROM orders
WHERE status = 'pending_payment' AND created_at < NOW() - INTERVAL '<PAYMENT_SESSION_TIMEOUT_MIN> minutes'
ORDER BY created_at LIMIT 100
FOR UPDATE SKIP LOCKED;                                    -- Q-O4, safe with N instances
```

Per order (same trx): order → `cancelled` (`cancel_reason = 'payment_timeout'`), open sessions → `expired`. After commit: `releaseStock`, WS `order.cancelled` to the customer.

## 6. Refunds — `RefundService`

`POST /payments/:paymentId/refund` (admin) and automatic refunds on reject/cancel use the same path:

1. Load the charge (`type='charge'`, `status='succeeded'`) `FOR UPDATE`; refundable = `amount − Σ(refunds pending|succeeded)` [Q-P5]. `amount` omitted → full refundable. Over → 409.
2. Insert `transactions(type='refund', method=charge.method, provider_id=charge.provider_id, status='pending', amount, src=NULL, dst=customerId, refunded_payment_id=charge.id, idempotency_key=<header or "auto-refund:<orderId>">)`; commit.
3. Call `kashier.refund(charge.providerReferenceId, amount)` (after commit). Store Kashier's refund id in `provider_reference_id`. Kashier error → refund row `failed` + alert.
4. The refund webhook flips it to `succeeded` (§4.3).

COD orders never have a `charge`; a COD "refund" before delivery is the void described in orders §5.

## 7. COD

- Placement (Orders, same trx): `cod_collection` `pending`, `src=customerId`, `dst=ownerId`, `amount=total`.
- Delivered (Deliveries settlement, same trx): → `succeeded`.
- Cancelled before pickup: → `failed` + 0-amount `adjustment` (audit, no money moved).

## 8. Reads

- `GET /payments/:paymentId` — PK lookup; admin, or restaurant user with `order:payment read` whose `restaurantId` matches the transaction's order (or whose owner id is `src`/`dst`).

## 9. Invariants

1. The refunds of a charge never sum to more than the charge.
2. Webhooks are delivered at-least-once and processed effectively once (event unique key + `transactions.idempotency_key`).
3. A `charge` is `succeeded` only if its session is `captured`.
4. COD orders have `cod_collection`, never `charge`.
5. No order reaches `placed` from `pending_payment` without a verified webhook.

## 10. Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| sessions stuck `initialized` | customer abandoned | sweep cancels after 15 min |
| many duplicate webhooks | slow handler → Kashier retries | check handler latency; duplicates are harmless |
| signature mismatches | secret rotated on one side | fix `KASHIER_WEBHOOK_SECRET`; Kashier retries |
| webhook for an expired order | late capture | order stays cancelled; automatic full refund queued |

## 11. RBAC

| Action | Allowed |
|---|---|
| `POST /payments/init` | customer (own order) |
| `POST /payments/webhook/:provider` | none (HMAC) |
| `GET /payments/:id` | admin, `order:payment read` |
| `POST /payments/:id/refund` | admin |

## 12. Errors (`app/payment/errors.ts`)

`OrderNotPendingPaymentError`, `PaymentNotFoundError`, `PaymentNotRefundableError`, `RefundExceedsRefundableError`, `InvalidSignatureError`, `PaymentProviderUnavailableError`, `PaymentProviderRejectedError`.
