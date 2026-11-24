import type {Transaction} from "../../payment/entity/transaction.entity.js";
import type {RestaurantBalance} from "../repository/restaurant-balance.repo.js";

export class RestaurantBalanceResponseDTO {
    restaurantId!: number;
    balances!: {currency: string; balance: number}[];
    asOf!: string;

    static from(restaurantId: number, rows: RestaurantBalance[], asOf: Date): RestaurantBalanceResponseDTO {
        const dto = new RestaurantBalanceResponseDTO();
        dto.restaurantId = restaurantId;
        dto.balances = rows.map((row) => ({currency: row.currency, balance: row.balance}));
        dto.asOf = asOf.toISOString();
        return dto;
    }
}

export class PayoutResponseDTO {
    id!: number;
    amount!: number;
    currency!: string;
    status!: string;
    providerReferenceId!: string | null;
    createdAt!: string;

    static from(tx: Transaction): PayoutResponseDTO {
        const dto = new PayoutResponseDTO();
        dto.id = tx.id;
        dto.amount = tx.amount;
        dto.currency = tx.currency;
        dto.status = tx.status;
        dto.providerReferenceId = tx.providerReferenceId;
        dto.createdAt = tx.createdAt.toISOString();
        return dto;
    }
}
