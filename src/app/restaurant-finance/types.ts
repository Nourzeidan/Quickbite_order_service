import type {PaginationMeta} from "../../lib/http/pagination/cursor-pagination.js";
import type {PayoutResponseDTO} from "./dto/finance.response.dto.js";

// restaurant-finance.md — the module's shared shapes (not HTTP DTOs)

// realtime: restaurant.balance_changed { currency, balance } -> restaurant:<id>, published after commit
export interface BalanceChange {
    restaurantId: number;
    currency: string;
    balance: number;
}

// delivery settlement credit: balance += amount (subtotal - commission)
export interface CreditSettlementInput {
    restaurantId: number;
    region: string;
    currency: string;
    amount: number;
}

// what debitForRefund did (§5); null from the service = nothing to take back
export interface RefundDebitResult extends BalanceChange {
    debited: number;                        // taken from the balance
    shortfall: number;                      // the balance could not cover it -> pending adjustment
}

// GET /restaurant/payouts — one page, sent with sendPaginated
export interface PayoutPage {
    data: PayoutResponseDTO[];
    meta: PaginationMeta;
}

// keyset cursor of the payouts list: [createdAt ISO, id]
export type PayoutCursor = [string, number];
