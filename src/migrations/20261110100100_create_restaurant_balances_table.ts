import type {Knex} from "knex";

// running balance per restaurant and currency (ERD + currency, region). Credited by the delivery
// settlement (Phase 3), debited by payouts and refunds (Phase 4), always under SELECT ... FOR UPDATE
// in the same transaction as the ledger rows.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE restaurant_balances (
            restaurant_id BIGINT NOT NULL,                         -- core restaurants.id (logical)
            region TEXT NOT NULL,
            currency TEXT NOT NULL CHECK (currency IN ('EGP','SAR')),
            balance INT NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- minor units, never negative
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT pk_restaurant_balances PRIMARY KEY (restaurant_id, currency)    -- Q-F1
        );
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS restaurant_balances;`);
}
