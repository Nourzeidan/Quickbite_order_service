# Phase 4 walkthrough — Restaurant finance

Built 2026-11-18. This explains **what** was added and **why**, file by file, in the order money moves.
Rules: [business-logic/restaurant-finance.md](business-logic/restaurant-finance.md). Contracts: [api-contracts §5](api-contracts.md#5-restaurant-finance).

---

## 0. The idea in one picture

```
               credit (settlement)                    debit (refund after delivery)         debit (payout)
order delivered ───────────────► restaurant_balances ◄──────────────────────────── refund   ──────────► bank transfer
  + subtotal − commission              (one row per                                   webhook          (admin records it)
                                      restaurant+currency)
```

- `restaurant_balances` is only a **running total**. The truth is the ledger (`transactions`): every change of the balance has a row there, written **in the same DB transaction**, under `SELECT … FOR UPDATE` on the balance row.
- The restaurant's ledger account is the **owner's user id**; the platform is `NULL`.
- No new table, no migration (the ERD stays as agreed).

---

## 1. Core-service: an admin can set the commission

**Why:** until now every branch had commission 0 because core had no way to set it, so the platform earned nothing. You chose option (a): a real admin endpoint.

| File | Change |
|---|---|
| `core-service/src/app/branch/dto/branch.dto.ts` | `UpdateBranchCommissionDTO { commissionBps }` — int, 0..10000 (1500 = 15%). The DB column is a plain `INT`, so the DTO is the guard. |
| `…/repository/branch.repo.ts` | `updateBranchCommission` — one UPDATE … RETURNING. |
| `…/service/branch.service.ts` | `updateCommission` — admin only (`unAuthorizedError` otherwise), update + `branch.updated` outbox event in **one** transaction (same pattern as `updateStatus`). |
| `…/controller/branch.controller.ts`, `routes.ts` | `PATCH /api/branches/:id/commission`. |

**Why the outbox event:** order-service caches each branch for 60 s. `branch.updated` → RabbitMQ → order-service deletes `core:branch:<id>`, so the very next settlement reads the new rate. Old orders keep the commission they were settled with (`orders.commission`).

---

## 2. Reads: balance and payouts

| File | What |
|---|---|
| `restaurant-finance/repository/restaurant-balance.repo.ts` | `findBalancesByRestaurant` (Q-F1, PK) — all currencies, **no lock** (read only). |
| `payment/repository/transaction.repo.ts` | `listPayoutsByOwner` (Q-F2) — `dst_acc_id = owner AND type = 'payout'` in a date range, keyset `(created_at, id) <` cursor. Uses the existing `idx_transactions_dst_acc_type_created_at`. |
| `restaurant-finance/service/finance.service.ts` | `getBalance`, `listPayouts` |
| `restaurant-finance/controller/finance.controller.ts`, `routes.ts` | `GET /restaurant/balance`, `GET /restaurant/payouts` with `rbac(order:finance, read)`. |

Decisions:
- **Balance is never cached** — an owner looking at money must see the exact number.
- **Who can read:** owner and branch manager (core seeds `order:finance:read` for both), admin. Staff → 403. An admin has no restaurant in the JWT, so admins pass `?restaurantId=` (400 without).
- **Why the payout list asks core:** payouts are addressed to the owner's user id, so we need `restaurant.ownerId` — a cached core lookup, before any DB work.

---

## 3. Write: `POST /restaurant/payouts` (admin)

```
core: restaurant exists?                     ← before the trx (rule: no network call inside a trx) → 404
trx:
  same idempotency key already in the ledger? → return that payout (replay after Redis forgot it)
  lock balance row (FOR UPDATE)
  balance < amount → 409 Insufficient balance
  insert payout row  (platform → owner, bank_transfer, succeeded)
  balance -= amount
commit
emit restaurant.balance_changed
```

- The platform **records** a transfer operations already made; it does not move money.
- **Two layers of idempotency:** the existing Redis middleware (24 h, same key → same response) and `transactions.idempotency_key = payout:<hash>` (unique), so even a replay after 24 h can't pay twice.
- The ledger row is written through `PaymentLedgerService.recordPayout` — the payment module owns `transactions` (CLAUDE.md: modules talk through services, never another module's repo).

---

## 4. Refund after delivery: `FinanceService.debitForRefund`

**The problem:** the restaurant was credited `subtotal − commission` at delivery. If the customer is refunded later, that money must come back from the restaurant — but never more than it earned, and the balance can't go negative.

```
takenBack = what earlier refunds of this order already took back      (one query on the order's ledger)
share     = min(refund, (subtotal − commission) − takenBack)
debited   = min(share, balance)
shortfall = share − debited
```

Example: subtotal 100, commission 10, delivery fee 20 (total 120). Restaurant got 90.

| Refund | share | balance before | debited | shortfall |
|---|---|---|---|---|
| 10 | 10 | 500 | 10 | 0 |
| 110 (the rest) | min(110, 90 − 10) = 80 | 490 | 80 | 0 |

The extra 30 of the second refund is the delivery fee + commission → the platform's loss, not the restaurant's.

**Ledger rows (decision D1):**

| Row | type | status | owner → platform | key |
|---|---|---|---|---|
| taken from the balance | `adjustment` | `succeeded` | yes | `refund-debit:<region>:refund:<refundId>` |
| balance couldn't cover it | `adjustment` | **`pending`** = owed, not collected | yes | `refund-shortfall:<region>:refund:<refundId>` |

**Where the owner id comes from (D3):** the order's `commission` row (settlement always writes it, even at 0) — so no core call inside the webhook transaction.

---

## 5. The lock order (D2) — why the webhook changed shape

Two things can touch the same order at the same time: the **settlement** (agent taps delivered) and a **refund webhook**.

- Settlement locks: **order row** → charge/refund rows.
- The refund webhook used to lock: refund row → charge row. Adding "then the order" would be the **opposite order** → two transactions can each hold what the other wants → **deadlock**.

So the webhook now:
1. finds the order **without locks** (`RefundService.findOrderRefForRefundEvent`),
2. **locks the order row** (`OrderPaymentService.findByRef(…, forUpdate = true)`),
3. then processes the refund as before (`applyRefundWebhook`, which now returns the refund that became `succeeded`),
4. if the order is `delivered` → `debitForRefund`.

Same lock order everywhere → they run one after the other, never deadlock.

**The gap this closes:** an admin refunds part of an order while the agent is carrying it, and Kashier confirms before delivery. The webhook sees `picked` → nothing to debit (nothing was credited yet). Then settlement credits the **full** share. Without a fix the restaurant keeps money that was refunded. So:

- `PaymentLedgerService.settleDelivery` already read the order's charge rows; it now also reads its refunds (same query) and returns `refundedAmount`;
- `SettlementService` calls `debitForRefund(…, key = settlement:<publicId>)` in the same transaction.

Because of the order lock, each refund is taken back **exactly once**: either by the settlement (confirmed before) or by the webhook (confirmed after).

---

## 6. Realtime (D4)

`restaurant.balance_changed { currency, balance }` → room `restaurant:<id>`, always **after commit** via `FinanceService.publishBalance`:

| From | When |
|---|---|
| `SettlementService.settle` | every delivery (balance after credit and any catch-up debit) |
| `WebhookService.handle` | a refund debit actually happened |
| `FinanceService.recordPayout` | a payout (not on an idempotent replay) |

---

## 7. Tests — `play/phase4-e2e.ts` (35/36)

Run with core (API + worker) and order-service (API + worker) up; RabbitMQ needed for the commission cache check.

- Refunds are staged exactly as `RefundService` leaves them after sending (`pending`, `provider_requested_at` set), then confirmed by a **signed** refund webhook — because the real sandbox rejects the fake Kashier order ids of test orders. The real webhook → lock → debit path runs end to end.
- The one failure was environmental: RabbitMQ wasn't running, so `branch.updated` never arrived. Everything else — commission 10%, balance reads and permissions, payouts (409 / 404 / 403 / idempotency), refund debit, cumulative cap, shortfall at 0, the "refunded while on its way" case, socket events, ledger reconciliation — passed. Earlier suites: ws 16/16, Phase 2 32/32, Phase 3 44/44.
