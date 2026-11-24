import type {Knex} from "knex";

// one row per Kashier payment session. orders is partitioned, so the FK is composite (id, created_at).
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE payment_sessions (
            id BIGSERIAL PRIMARY KEY,
            region TEXT NOT NULL,
            order_id BIGINT NOT NULL,
            order_created_at TIMESTAMP NOT NULL,
            provider_id INT NOT NULL,                              -- payment_providers.id (logical; replicated lookup)
            provider_session_id TEXT NOT NULL,                     -- Kashier session _id
            merchant_order_ref TEXT NOT NULL,                      -- Kashier "order": <region>_<publicId>[_<n>]
            redirect_url TEXT NOT NULL,
            amount INT NOT NULL CHECK (amount > 0),
            currency TEXT NOT NULL CHECK (currency IN ('EGP','SAR')),
            status TEXT NOT NULL CHECK (status IN (
                'initialized','pending','authorized','captured','failed','expired','cancelled')),
            expires_at TIMESTAMP NOT NULL,
            raw_init_payload JSONB NOT NULL,                       -- what we sent to Kashier (no secrets)
            raw_last_payload JSONB NULL,                           -- last webhook for this session
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_payment_sessions_order_id FOREIGN KEY (order_id, order_created_at)
                REFERENCES orders (id, created_at),
            CONSTRAINT uq_payment_sessions_provider_session_id UNIQUE (provider_session_id),
            CONSTRAINT uq_payment_sessions_merchant_order_ref UNIQUE (merchant_order_ref)
        );

        -- supports order -> sessions (init re-use, webhook, sweep) and the FK   (Q-P2)
        CREATE INDEX idx_payment_sessions_order_id_order_created_at ON payment_sessions (order_id, order_created_at);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS payment_sessions;`);
}
