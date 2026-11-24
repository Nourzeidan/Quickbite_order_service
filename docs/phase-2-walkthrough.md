# Phase 2 — Payments: walkthrough

What was built in Phase 2, why each piece looks the way it does, and what is still open.
Rules live in [business-logic/payments.md](./business-logic/payments.md); this file explains the implementation.

Status (2026-11-09): ✅ done — 32/32 automated checks (`play/phase2-e2e.ts`) plus a real sandbox payment and a real refund. Test notes: [implementation-plan.md, Phase 2](./implementation-plan.md).

---

## 1. How Kashier works

Kashier is the payment gateway. The customer types card details on **Kashier's** hosted page; our server never sees card numbers.

### 1.1 Accounts and keys

| Thing | What it is | Where we use it |
|---|---|---|
| Merchant ID (`MID-…`) | your shop's id at Kashier | body of "create session" (`KASHIER_MERCHANT_ID`) |
| Secret Key | proves a request comes from your server | `Authorization` header on every call we make (`KASHIER_SECRET_KEY`) |
| Payment API Key | second credential; also the key Kashier signs webhooks with | `api-key` header (`KASHIER_API_KEY`) and the HMAC key (`KASHIER_WEBHOOK_SECRET`, same value) |
| Test vs live | two separate environments, different keys and hosts | dev: `test-api.kashier.io` (sessions), `test-fep.kashier.io` (refunds) |

Dashboard steps:

1. Sign up at merchant.kashier.io, stay in **Test mode**.
2. Copy the Merchant ID.
3. Integrations → API Keys: copy the Secret Key and the Payment API Key. The key's role needs the refund permission.
4. No dashboard webhook is needed: every session carries its own `serverWebhook`, and Kashier sends every event of that payment there (refunds included). Registering one in the dashboard too would only produce duplicates (harmless, deduped).
5. Kashier can't reach `localhost`: run a tunnel (`ngrok http 4000`) and set `KASHIER_WEBHOOK_URL=https://<tunnel>/api/payments/webhook/kashier`.
6. Pay with the test cards from Kashier's docs.

### 1.2 The payment flow

```
Customer        Our API                         Kashier
   │ POST /orders (online)  ──►  order = pending_payment
   │ POST /payments/init    ──►  POST /v3/payment/sessions ──►  { _id, sessionUrl }
   │ ◄── redirectUrl
   │ ── opens sessionUrl in browser ───────────────────────────►  hosted payment page
   │                                                           (card, 3-D Secure)
   │ ◄── browser redirected to KASHIER_RETURN_URL (display only)
   │                       POST /api/payments/webhook/kashier ◄── server-to-server
   │                       verify signature → charge row → order = placed
```

### 1.3 Concepts that drive the design

1. **Session** — a one-time payment page for one amount, created server-side; the customer is sent to its `sessionUrl`.
2. **The browser redirect can't be trusted.** The customer controls the browser and can fake "success" in the URL, so the redirect changes nothing in our database.
3. **The webhook is the only proof of payment.** Kashier signs it:
   - take the field names in `data.signatureKeys` and sort them;
   - build `key=value&key=value` from those fields, values URL-encoded (like the `query-string` package);
   - HMAC-SHA256 of that string with the Payment API Key, hex;
   - compare with the `x-kashier-signature` header.

   Only someone holding the key can produce a matching signature.
4. **At-least-once delivery.** No 200 within 30 s → Kashier retries up to 10 times. The same event can arrive many times, so processing it twice must give the same result as once.
5. **Events:** `pay` / `capture` are payments, `refund` / `partial_refund` are refunds. The outcome is `data.status` (`SUCCESS` / `FAILURE` / `PENDING`), not the event name.
6. **Refund** = `PUT {fep}/v3/orders/{kashierOrderId}` with `{apiOperation: "REFUND", reason, transaction: {amount}}`. Its final result also arrives as a webhook.

---

## 2. The code, layer by layer

Order follows CLAUDE.md: `pkg` (knows nothing about the app) → `lib` (wiring) → `app` (business rules).

### 2.1 Migrations — `src/migrations/20261109…`

| Table | Purpose | Decisions |
|---|---|---|
| `payment_providers` | lookup, fixed ids `1 = kashier`, `2 = cod` | same rows on every shard so ids never differ between regions |
| `payment_sessions` | one row per Kashier session | `order_id` + `order_created_at` FK: `orders` is partitioned by month and Postgres only allows an FK to its full PK `(id, created_at)`. `merchant_order_ref` (unique): webhooks carry no session id, so the session is found by our own reference |
| `transactions` | the ledger, one row per money movement | amounts always positive; direction is `src_acc_id → dst_acc_id` (NULL = platform). `idempotency_key UNIQUE` blocks duplicate rows. CHECK: `order_id` and `order_created_at` both NULL or both set |
| `payment_webhook_events` | every verified webhook: audit + dedupe | `UNIQUE (provider_id, provider_event_id)` |

Every index carries a `-- supports … (Q-xx)` comment (database rule 7).

### 2.2 `src/pkg/payments/` — the Kashier client

- [payment.interface.ts](../src/pkg/payments/payment.interface.ts) — `IPaymentProvider` (`createSession`, `refund`, `verifyWebhook`, `parseWebhook`) and `PaymentProviderError`:
  - `unavailable` (network, timeout, 5xx) → we answer **503**;
  - `rejected` (4xx, or Kashier answered FAILURE) → we answer **502**.

  The app depends on the interface, so another provider can be added without touching business code.
- [kashier/kashier.signature.ts](../src/pkg/payments/kashier/kashier.signature.ts) — rebuilds Kashier's signing string and compares with `crypto.timingSafeEqual`. A plain `===` returns faster the fewer characters match; an attacker can time that to guess a signature byte by byte.
- [kashier/kashier.client.ts](../src/pkg/payments/kashier/kashier.client.ts)
  - `createSession` converts minor units to Kashier's string (`12000` → `"120.00"`) with string math (`fromMinor`), never floats. Retries 3× on network / 5xx.
  - `refund` is **never retried**: a timed-out refund may have gone through, and a retry could refund twice.
  - `parseWebhook` normalizes the payload; dedupe id = `<event>:<transactionId>:<status>`.
- [kashier/kashier.types.ts](../src/pkg/payments/kashier/kashier.types.ts) — request / response shapes.

### 2.3 `src/lib/`

- `config/env.ts` — new variables, validated by zod; the app refuses to start without the Kashier keys.
- `payments/init.ts` — the only place env values reach the Kashier client.
- `idempotency/idempotency-key.repo.ts` — **moved** from `app/order/repository/`: payments needs it too, and modules may not use each other's repositories.
- `di/tokens.ts`, `di/container.ts` — new tokens and registrations, registered in dependency order (§2.4).

### 2.4 How orders and payments talk without a circular dependency

```
OrderService / OrderStatusService ──► PaymentLedgerService, RefundService   (payment module)
PaymentService / WebhookService / Sweep ──► OrderPaymentService              (order module)
```

`RefundService` and `PaymentLedgerService` depend on nothing in the order module, so the graph has no cycle and tsyringe can build it. The payment module never touches the `orders` table; it goes through [OrderPaymentService](../src/app/order/service/order-payment.service.ts), the order module's API for payments.

### 2.5 `src/app/payment/`

#### `PaymentService.init` — `POST /payments/init`

1. Check the durable idempotency store; a replay returns the stored response.
2. Load the order from Postgres. Not the caller's → 404 (don't reveal it exists). Not `pending_payment` → 409.
3. The order already has an open session → return it ("init twice returns the same session").
4. Call Kashier **outside any transaction**: a slow external call inside one would hold DB locks.
5. One short transaction: insert the session + the idempotency key.
6. Unique violation (two inits at once) → return the session the other request created.

The session expires at `order.created_at + PAYMENT_SESSION_TIMEOUT_MIN`, the same moment the sweep cancels the order.

#### `WebhookService.handle` — `POST /payments/webhook/kashier`

1. Signature checked **before anything is stored**. Bad → 401, nothing saved.
2. Parse `eg_<publicId>[_<n>]` → region → shard.
3. Insert the event row. Already processed → duplicate → 200, no work.
4. One transaction:
   - lock the session;
   - amount / currency must equal the session's, else save a note, change nothing, log an alert;
   - **success** → session `captured`, insert `charge`, order `pending_payment → placed` (conditional update);
   - **failure** → session `failed` + a failed `charge` for audit; the order stays `pending_payment` so the customer can retry;
   - **refund** → `RefundService.applyRefundWebhook`.
5. Processing throws → rollback, save the error, return 500 → Kashier retries, and the retry processes it again (an unfinished event is not a duplicate).
6. After commit: invalidate the order cache; automatic refund when needed (below).

Money for an order that can no longer be placed is refunded — e.g. the sweep cancelled at 15:00 and the payment completed at 15:01, or the customer paid through two sessions. The order is left alone and **that charge** is refunded.

Charges are keyed `kashier-charge:<transactionId>:<status>`, so a `pay` + `capture` pair for one transaction writes one row and triggers no refund.

#### `RefundService`

A refund is two steps, so that a crash can never lose one:

1. **Reserve** — inside the transaction that *decides* the refund (the admin request, the order reject / cancel, or the webhook of a late payment): lock the charge (`FOR UPDATE`, serializes refunds of one charge), refundable = charge − Σ(pending + succeeded refunds), over → 409, insert a `pending` refund row with `provider_requested_at = NULL` ("queued"). Committing the cancel and committing the refund are now the same commit.
2. **Send** — after commit: *claim* the row with one conditional UPDATE (`SET provider_requested_at = NOW() WHERE … provider_requested_at IS NULL`). Only one caller can win the claim, so the request path and the sweep (or two instances) never both send it. Then call Kashier:
   - clear rejection → row `failed` (the amount is refundable again);
   - timeout / 5xx → row stays `pending` (Kashier may have refunded; it's never re-sent automatically).
3. **Webhook** — find the row by Kashier's refund transaction id; if it arrived before we stored that id, match by charge + amount. Mark `succeeded` / `failed`. Once succeeded refunds cover the charge → `is_refunded = true`.
4. **Reconcile** (runs inside the payment sweep, every shard):
   - queued rows older than 30 s (the process died after commit, before sending) → send them;
   - sent rows still `pending` after `REFUND_STALE_ALERT_MIN` (60) → `ALERT` log for a human to check in the Kashier dashboard.

Keys: `admin-refund:<hash of admin + path + Idempotency-Key>`, `auto-refund:charge:<id>` (a charge is never auto-refunded twice).

#### `PaymentLedgerService`

Ledger writes the order module makes inside **its own** transactions:

- COD row at placement (`cod_collection`, `pending`);
- COD void: `failed` + a 0-amount `adjustment` for the audit trail;
- cancel the open sessions of an unpaid order;
- `summarize` → the order detail's `paymentSummary`.

#### `PaymentSweepService`

Every `PAYMENT_SWEEP_INTERVAL_SEC` (60 s), every shard:

- `SELECT … FOR UPDATE SKIP LOCKED` up to 100 unpaid orders older than **session timeout + grace** (`PAYMENT_SWEEP_GRACE_MIN`, 3) — two instances never take the same rows, and a payment finished in the session's last seconds still lands before the cancel;
- one UPDATE cancels them (`cancel_reason = payment_timeout`), their sessions → `expired`;
- after commit: release stock on core, invalidate the cache;
- then `RefundService.reconcile` for the same shard.

#### Controllers and routes

Thin, as in CLAUDE.md. The webhook route has no JWT and no `X-Region`: the signature is the authentication. `GET /payments/:id` = `rbac(order:payment read)` + a check that the order belongs to the user's restaurant / branch.

### 2.6 Changes to the order module

| File | Change |
|---|---|
| `repository/order.repo.ts` | `findOrderByRef` (Q-O10), `lockExpiredPendingPaymentOrders` (Q-O4), `updateOrdersStatus` (one UPDATE for a batch, no query per row) |
| `service/order-payment.service.ts` | new: the order module's API for payments |
| `payment-ref.ts` | `toPaymentRef(order)`: the slice of an order payments needs |
| `service/order.service.ts` | COD → `cod_collection` row in the placement trx; `voidOrder` voids it; detail `paymentSummary` from the ledger |
| `service/order-status.service.ts` | reject / cancel run in one trx that also voids COD, or (online) cancels open sessions and **reserves** refunds of paid charges; after commit the refunds are sent |

### 2.7 Other files

- [play/kashier-webhook.ts](../play/kashier-webhook.ts) — sends signed fake webhooks to the local server:
  ```
  npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<total>                 # success → placed
  npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<total> tx=TX-1         # run twice → 200, no new rows
  npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<total> badsig          # → 401, nothing stored
  npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<n> event=refund tx=RF-1 kashierOrderId=<from charge>
  ```
- [play/payment-checks.ts](../play/payment-checks.ts) — prints an order's sessions, ledger rows and webhook events.
- `.env.example` — the new variables with comments.

---

## 3. Where the code differs from the original docs

| Original doc | Implemented | Why |
|---|---|---|
| `KASHIER_FAIL_URL` | removed; `failureRedirect: true` | Kashier has one redirect URL |
| one Kashier host | `KASHIER_BASE_URL` + `KASHIER_FEP_BASE_URL` | refunds live on the `fep` host |
| webhook finds session by `provider_session_id` (Q-P1) | by `merchant_order_ref` | webhooks carry no session id |
| charge `provider_reference_id` = transaction id | = `kashierOrderId` (transaction id in `note`) | refunds are addressed by Kashier order id |
| duplicate event → always 200 | unfinished event is reprocessed | otherwise a 500 + retry would skip it forever |
| single-column FKs to `orders` | composite `(order_id, order_created_at)` | `orders` is partitioned |
| `idempotency-key.repo.ts` in `app/order/` | in `lib/idempotency/` | shared by orders and payments |

---

## 4. Open items

### Before Phase 3

1. ~~Nothing has run yet.~~ **Done:** migrations on both shards, 32/32 e2e checks, real payment + refund in the sandbox.
2. ~~Post-commit refunds are lost on a crash.~~ **Fixed:** refunds are reserved in the deciding transaction and the sweep sends any that were never sent.
3. ~~Refunds can stay `pending` forever.~~ **Fixed (alert, not auto-resolve):** sent refunds with no outcome after `REFUND_STALE_ALERT_MIN` raise an `ALERT`. They aren't re-sent or auto-resolved: Kashier's refund-status API isn't documented clearly enough to trust, and re-sending could refund twice.
4. ~~Tight sweep timing.~~ **Fixed:** the sweep cancels at session timeout + `PAYMENT_SWEEP_GRACE_MIN` (3).

### To verify in the sandbox

5. ✅ **Confirmed `major`** (real webhooks: `70.5`, `1`). **Webhook amount unit** (`KASHIER_WEBHOOK_AMOUNT_UNIT`, default `major`). Wrong → every payment stored as "amount mismatch", orders never placed. Check `payment_webhook_events.payload` after the first payment.
6. ✅ **Confirmed** (real webhooks verify). **Signature vs number formatting.** We sign the parsed JSON, exactly like Kashier's own Node.js example (`req.body` + `query-string`), so this should match. If valid sandbox webhooks get 401, this is the first suspect.
7. **Refund response shape and `failureRedirect` semantics** — undocumented. Also confirm the session response fields `_id` / `sessionUrl`.

### Can wait

8. Cancelling an unpaid order doesn't abandon the session at Kashier (the API exists); a later payment is just auto-refunded.
9. `payment_providers.is_enabled` is never read (docs: cache it, let ops disable a provider).
10. Kashier replays (`event: "idempotency"`) are acked and ignored.
11. Alerts are only `ALERT …` log lines; no alerting system behind them.
12. Order detail does one ledger query even on an order-cache hit (deliberate: payment state must not lag).
13. No automated tests (same as Phase 1).
14. Doc leftovers: orders.md "Deferred" line, catalogue row Q-P1, `play/api.ps1`.
15. Deferred by the plan: restaurant balance debit on refund after delivery (now Phase 4). Since done: WS events (added 2026-11-10), COD settlement at delivery (Phase 3). The sweeps now run in the worker (`npm run worker`).

---

## 5. How to test

### 5.1 Configure

1. Kashier dashboard (§1.1): Test mode, copy Merchant ID, Secret Key, Payment API Key.
2. Start a tunnel so Kashier can reach you: `ngrok http 4000` → copy the `https://….ngrok-free.app` URL.
3. Add to `order-service/.env` (names in `.env.example`):

   | Variable | Value |
   |---|---|
   | `KASHIER_BASE_URL` | `https://test-api.kashier.io` |
   | `KASHIER_FEP_BASE_URL` | `https://test-fep.kashier.io` |
   | `KASHIER_MERCHANT_ID` | `MID-…` |
   | `KASHIER_SECRET_KEY` | Secret Key |
   | `KASHIER_API_KEY` | Payment API Key |
   | `KASHIER_WEBHOOK_SECRET` | Payment API Key (same value) |
   | `KASHIER_RETURN_URL` | `https://<ngrok>/api/payments/return` — Kashier rejects `localhost` (400 `merchantRedirect must be a valid URL`); the page is cosmetic |
   | `KASHIER_WEBHOOK_URL` | `https://<ngrok>/api/payments/webhook/kashier` |
   | `KASHIER_WEBHOOK_AMOUNT_UNIT` | `major` (change to `minor` if §5.4 shows otherwise) |
   | the rest | defaults are fine |

   ngrok's free URL changes on every restart → update `KASHIER_WEBHOOK_URL` and restart the API.
4. `npm run migrate` (all shards), then core-service + Redis + RabbitMQ up, then `npm run dev`.
5. Check: `\d transactions` in psql shows `provider_requested_at`; `SELECT * FROM payment_providers` shows kashier + cod.

### 5.2 Helpers (one PowerShell window)

```powershell
. .\play\api.ps1
$c = npx tsx play/token.ts customer                 # customer userId 1
$a = npx tsx play/token.ts role=admin userId=999
$base = "http://localhost:4000/api"
```

- `npx tsx play/payment-checks.ts [<publicId>]` — order status, sessions, ledger, webhook events.
- `npx tsx play/kashier-webhook.ts ref=eg_<publicId> amount=<minor> [...]` — signed fake webhook (§2.7).

### 5.3 Local tests with fake webhooks (no Kashier needed except for `init`)

Place an online order first (body as in Phase 1, `paymentMethod: "online"`), note `publicId` and `total`.

| # | Do | Expect |
|---|---|---|
| 1 | `api POST "$base/payments/init" -Body @{orderId=$id} -Token $c -Region eg -Key k1` | 200, `redirectUrl` from Kashier; one `initialized` session |
| 2 | same call again with key `k2` | the **same** `sessionId` |
| 3 | same call with `k1` and a different `orderId` | 409 `Idempotency key reused with a different body` |
| 4 | `kashier-webhook.ts ref=eg_$id amount=<total> badsig` | 401; nothing new in `payment_webhook_events` |
| 5 | `kashier-webhook.ts ref=eg_$id amount=1` | 200; event stored with `process_error = amount or currency mismatch`; order still `pending_payment` |
| 6 | `kashier-webhook.ts ref=eg_$id amount=<total> status=FAILURE tx=TX-F` | session `failed`, failed `charge`; order still `pending_payment` |
| 7 | `kashier-webhook.ts ref=eg_$id amount=<total> tx=TX-1 kashierOrderId=K-1` | order `placed`, session `captured`, `charge` `succeeded` |
| 8 | repeat 7 exactly | 200 `duplicate`; no new rows |
| 9 | repeat 7 with `event=capture` | 200, note `charge already recorded`; no new rows, no refund |
| 10 | `api POST "$base/payments/<chargeId>/refund" -Body @{amount=100; reason="test"} -Token $a -Region eg -Key r1` | Kashier will **reject** (K-1 isn't a real Kashier order) → 502, refund row `failed`. Real refunds are tested in §5.4 |
| 11 | refund with `amount` > total | 409 `Refund exceeds the refundable amount` |
| 12 | `api GET "$base/payments/<chargeId>" -Token $a -Region eg` | 200 `PaymentResponseDTO` |
| 13 | COD order, then reject it as the restaurant | `cod_collection` `failed` + 0-amount `adjustment` |
| 14 | Sweep: set `PAYMENT_SESSION_TIMEOUT_MIN=1`, `PAYMENT_SWEEP_GRACE_MIN=0`, restart, place an online order, wait ~2 min | order `cancelled` (`payment_timeout`), sessions `expired`, stock released on core |
| 15 | Late payment: `kashier-webhook.ts` success for the order cancelled in 14 | order stays `cancelled`; a `refund` row (auto) appears; with a fake `kashierOrderId` Kashier rejects → `failed` + `ALERT` log |
| 16 | Crash safety (simulated — killing the process at exactly the right moment is hard to time): `UPDATE transactions SET provider_requested_at = NULL, status = 'pending' WHERE id = <refundId>;` then wait 30–90 s | sweep log `sending queued refunds`; the row is claimed (`sent = true`) and sent again to Kashier |

Reset the timeouts after 14–16.

### 5.4 Real sandbox payment (settles the open questions)

1. Place an online order, `POST /payments/init`, open `redirectUrl` in a browser.
2. Pay with a Kashier test card.
3. Watch the API log for `webhook processed`, then run `payment-checks.ts <publicId>`:
   - order `placed`, `charge` `succeeded` with `provider_ref` = a real `kashierOrderId`;
   - **WEBHOOK EVENTS → `amount`**: if it shows e.g. `120` / `120.00` for a 120 EGP order, `major` is right; if it shows `12000`, set `KASHIER_WEBHOOK_AMOUNT_UNIT=minor`;
   - a 401 in the log for a real payment → signature mismatch (§4 item 6).
4. Real refund: `POST /payments/<chargeId>/refund` (admin, amount < total) → 202 `pending` → refund webhook arrives → row `succeeded`; refund the rest → charge `is_refunded = true`.
5. Real auto refund: pay another order, then cancel it as the customer within 60 s → refund row → webhook → `succeeded`.
6. Wrong-card / declined test card → session `failed`, order stays `pending_payment`, `init` again opens session `_2`.

When §5.3 and §5.4 pass, mark Phase 2 ✅ in implementation-plan.md with test notes like Phase 1.

---

## 6. Sources

- [Kashier payment sessions](https://developers.kashier.io/payment/payment-sessions)
- [Kashier webhooks setup](https://developers.kashier.io/webhooks/setup)
- [Kashier webhook payloads](https://developers.kashier.io/docs/webhooks/payloads)
- [Kashier refunds](https://developers.kashier.io/docs/accept-payments/refunds)
- [Kashier refund API reference](https://developers.kashier.io/docs/api-reference/order-operations/refundOrder)
- [Kashier get payment session by id](https://developers.kashier.io/docs/api-reference/payment-sessions/getPaymentSessionById)
