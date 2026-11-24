import type {Knex} from "knex";

// lookup table, same rows on every shard (fixed ids: app/payment/enums.ts PaymentProvider)
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_providers (
            id INT PRIMARY KEY,
            name TEXT NOT NULL,
            is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            priority SMALLINT NOT NULL DEFAULT 100,

            CONSTRAINT uq_payment_providers_name UNIQUE (name)
        );

        INSERT INTO payment_providers (id, name, is_enabled, priority) VALUES
            (1, 'kashier', TRUE, 10),
            (2, 'cod',     TRUE, 20)
        ON CONFLICT (id) DO NOTHING;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_providers;`);
}
