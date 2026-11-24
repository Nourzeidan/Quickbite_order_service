import type {Knex} from "knex";

export interface RestaurantBalance {
    restaurantId: number;
    currency: string;
    balance: number;
    updatedAt: Date;
}

const BALANCE_COLUMNS = ["restaurant_id", "currency", "balance", "updated_at"];

function toRecord(row: any): RestaurantBalance {
    return {restaurantId: Number(row.restaurant_id), currency: row.currency, balance: row.balance, updatedAt: row.updated_at};
}

// Q-F1 — lazily created row, then locked: every change happens under FOR UPDATE in the caller's trx
export async function lockBalance(restaurantId: number, region: string, currency: string, conn: Knex): Promise<RestaurantBalance> {
    await conn.raw(`
        INSERT INTO restaurant_balances (restaurant_id, region, currency, balance)
        VALUES (?, ?, ?, 0)
        ON CONFLICT (restaurant_id, currency) DO NOTHING
    `, [restaurantId, region, currency]);
    const [row] = await conn("restaurant_balances")
        .select(BALANCE_COLUMNS)
        .where({restaurant_id: restaurantId, currency})
        .forUpdate();
    return toRecord(row);
}

// Q-F1 (PK) — delta may be negative (payouts / refund debits); the CHECK keeps it >= 0
export async function addToBalance(restaurantId: number, currency: string, delta: number, conn: Knex): Promise<RestaurantBalance> {
    const [row] = await conn("restaurant_balances")
        .update({balance: conn.raw("balance + ?", [delta]), updated_at: conn.fn.now()})
        .where({restaurant_id: restaurantId, currency})
        .returning(BALANCE_COLUMNS);
    return toRecord(row);
}

// Q-F1 (PK prefix) — every currency of one restaurant; no lock, read-only (GET /restaurant/balance)
export async function findBalancesByRestaurant(restaurantId: number, conn: Knex): Promise<RestaurantBalance[]> {
    const rows = await conn("restaurant_balances")
        .select(BALANCE_COLUMNS)
        .where("restaurant_id", restaurantId)
        .orderBy("currency", "asc");
    return rows.map(toRecord);
}
