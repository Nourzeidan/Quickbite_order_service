# Restaurant Finance Module

Code: `src/app/restaurant-finance/`. Tables: `restaurant_balances`, `transactions` (payout rows). Endpoints: [api-contracts §5](../api-contracts.md#5-restaurant-finance). Phase 4 (built 2026-11-18).

Balance **credits** happen in the Deliveries settlement and **refund debits** in the Payments webhook — both through `FinanceService` methods that take the caller's `trx`. This module adds the reads and the one admin write (record payout).

## 1. Principles

- Every money movement is a `transactions` row; `restaurant_balances` is a materialized running sum, always updated in the same transaction as its ledger rows, under `SELECT … FOR UPDATE`.
- Restaurant account in the ledger = the **owner's user id**; platform = `NULL`.
- The balance never goes negative (`CHECK (balance >= 0)`).

## 2. `GET /restaurant/balance` — `FinanceService.getBalance(region, user)`

- `rbac({resource: "order:finance", action: "read"})`; restaurant = `req.user.restaurantId` (admins pass `?restaurantId=`, else 400).
- All rows of that restaurant [Q-F1] (one per currency).
- Not cached — owners and admins must see the exact value.
- **200** `RestaurantBalanceResponseDTO { restaurantId, balances: [{ currency, balance }], asOf }`.

## 3. `GET /restaurant/payouts?from=&to=`

- `rbac(order:finance, read)`; owner id from the cached core restaurant.
- `transactions WHERE dst_acc_id = ownerId AND transaction_type = 'payout' AND created_at BETWEEN …` [Q-F2], cursor by `created_at DESC`. Defaults: last 90 days.
- **200** paginated `PayoutResponseDTO[]`.

## 4. `POST /restaurant/payouts` (admin) — `FinanceService.recordPayout(region, admin, dto)`

`authenticate → requireRegion() → requireRole(admin) → idempotency({strict: true})`.

```
1. restaurant = restaurantClient.getRestaurant(dto.restaurantId)      ← before the trx; 404 → Restaurant not found
2. const trx = await db(region).transaction(); try {
     balance = SELECT … FROM restaurant_balances WHERE restaurant_id = ? AND currency = ? FOR UPDATE
     !balance || balance.balance < dto.amount → throw InsufficientBalanceError (409)
     insert transactions(type='payout', method='bank_transfer', status='succeeded',
            amount, currency, src=NULL, dst=restaurant.ownerId,
            provider_reference_id=dto.providerReferenceId, note, idempotency_key=<header>)
     UPDATE restaurant_balances SET balance = balance - ?, updated_at = NOW()
     await trx.commit()
   } catch { await trx.rollback(); throw }
3. return PayoutResponseDTO.from(tx)
```

The platform records transfers that operations already made; it does not move money itself. If an automated payout API is added later: insert `pending` → call provider → `succeeded` by webhook. The schema already allows it.

## 5. Refund after settlement — `FinanceService.debitForRefund(order, refundAmount, key, trx)`

Called in two places, always with the **order row locked**:

1. the **refund webhook**, when the refund succeeds and the order is already `delivered` (`key = refund:<refundId>`);
2. the **settlement**, for refunds that already succeeded while the order was on its way (`key = settlement:<publicId>`).

The webhook locks the order before the refund/charge rows (the same order as settlement: order → transactions), so the two never interleave and every refund is taken back exactly once: no deadlock, no miss, no double.

```
takenBack = Σ refund-debit + refund-shortfall adjustments of this order        (Q-P3, one query)
share     = min(refundAmount, (subtotal − commission) − takenBack)              ← cumulative cap: never more than it earned
debited   = min(share, balance)                                                 ← balance never < 0
shortfall = share − debited
```

| Row | type | status | src → dst | idempotency_key |
|---|---|---|---|---|
| debited part | `adjustment` | `succeeded` | owner → platform | `refund-debit:<region>:<key>` |
| not covered | `adjustment` | `pending` (owed, not collected) | owner → platform | `refund-shortfall:<region>:<key>` |

The delivery-fee part of a refund is the platform's loss. The owner id comes from the order's `commission` row (always written at settlement, even when 0), so no core call happens inside the transaction. Rows with amount 0 are not written.

## 6. Reconciliation

The balance must equal the ledger (admin check, per restaurant and currency):

```sql
SELECT
  COALESCE(SUM(o.subtotal) FILTER (WHERE o.status = 'delivered'), 0)
  - COALESCE((SELECT SUM(amount) FROM transactions WHERE transaction_type = 'commission' AND src_acc_id = :ownerId AND status = 'succeeded'), 0)
  - COALESCE((SELECT SUM(amount) FROM transactions WHERE transaction_type = 'payout' AND dst_acc_id = :ownerId AND status = 'succeeded'), 0)
  - COALESCE((SELECT SUM(amount) FROM transactions WHERE transaction_type = 'adjustment' AND status = 'succeeded' AND src_acc_id = :ownerId AND idempotency_key LIKE 'refund-debit:%'), 0)
FROM orders o WHERE o.restaurant_id = :restaurantId AND o.currency = :currency;
```

(Run against hot + archive for full history. Not an API in this milestone.)

## 7. Settlement formula (implemented in Deliveries)

`branch.commissionBps` is set by a system admin in core: `PATCH /api/branches/:id/commission { commissionBps }` (0–10000, emits `branch.updated`, so order-service drops the cached branch). Orders keep the commission they were settled with (`orders.commission`).

```
commission    = floor(order.subtotal × branch.commissionBps / 10000)
balance delta = order.subtotal − commission
```

## 8. RBAC

| Action | Allowed |
|---|---|
| `GET /restaurant/balance`, `GET /restaurant/payouts` | `order:finance read` (owner, branch_manager), admin |
| `POST /restaurant/payouts` | admin (`order:finance payout_create` seeded for future roles) |

## 9. Invariants

1. `balance ≥ 0`.
2. Σ settlements − Σ payouts − Σ refund debits = current balance (auditable from the ledger alone).
3. A payout is recorded only after the transfer cleared (operator's responsibility).

## 10. Future (not this milestone)

`GET /restaurant/finance/summary?period=month` — one query with `SUM(amount) FILTER (WHERE transaction_type = …)` per category (gross, commission, refunds, payouts). The schema already supports it.

## 11. Errors (`app/restaurant-finance/errors.ts`)

`RestaurantNotFoundError`, `InsufficientBalanceError`, `RestaurantIdRequiredError` (admin read without `restaurantId`).

## 12. Realtime

`restaurant.balance_changed { currency, balance }` → `restaurant:<id>`, after commit, from: the settlement credit (Deliveries), a refund debit (payment webhook, only when something was debited) and a payout.
