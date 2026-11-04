import type {Knex} from "knex";

// Durable store behind Redis for POST /orders (and POST /payments/init in Phase 2).
// NOT partitioned on purpose: the PK on key_hash alone is what makes two concurrent requests with
// the same key collide (23505). A partitioned PK would have to include created_at and lose that.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE idempotency_keys (
            key_hash BYTEA PRIMARY KEY,
            region TEXT NOT NULL,
            user_id BIGINT NOT NULL,
            request_fingerprint BYTEA NOT NULL,
            response_status INT NOT NULL,
            response_body JSONB NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL
        );

        -- supports cleanup of expired keys                                      (Q-I2)
        CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS idempotency_keys;`);
}
