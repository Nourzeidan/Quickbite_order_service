import type {Knex} from "knex";

// what an agent earned per delivered order (ERD + region, order_created_at, currency, earned_at).
// Written in the settlement transaction; one row per order.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE agent_earnings (
            id BIGSERIAL PRIMARY KEY,
            region TEXT NOT NULL,
            agent_id BIGINT NOT NULL,                              -- core users.id (logical)
            order_id BIGINT NOT NULL,
            order_created_at TIMESTAMP NOT NULL,
            amount INT NOT NULL CHECK (amount >= 0),               -- minor units
            currency TEXT NOT NULL CHECK (currency IN ('EGP','SAR')),
            earned_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_agent_earnings_order_id FOREIGN KEY (order_id, order_created_at)
                REFERENCES orders (id, created_at),
            -- one earning per order: a replayed settlement can't pay twice (also indexes the FK)
            CONSTRAINT uq_agent_earnings_order_id UNIQUE (order_id, order_created_at)
        );

        -- supports GET /agents/earnings?from=&to=                              (Q-A3)
        CREATE INDEX idx_agent_earnings_agent_id_earned_at ON agent_earnings (agent_id, earned_at DESC);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS agent_earnings;`);
}
