import type {Knex} from "knex";

// the ledger: every money movement is one row (database-design §4.5).
// order_id / order_created_at are NULL together (payouts, non-order adjustments).
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE transactions (
            id BIGSERIAL PRIMARY KEY,
            region TEXT NOT NULL,
            order_id BIGINT NULL,
            order_created_at TIMESTAMP NULL,
            transaction_type TEXT NOT NULL CHECK (transaction_type IN (
                'charge','refund','commission','payout','cod_collection','adjustment')),
            method TEXT NOT NULL CHECK (method IN ('online','cod','bank_transfer','system')),
            provider_id INT NULL,                                  -- NULL for system rows
            provider_reference_id TEXT NULL,                       -- charge: kashierOrderId · refund: Kashier refund transactionId
            status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reversed')),
            amount INT NOT NULL CHECK (amount >= 0),               -- minor units; 0 only for audit adjustments
            currency TEXT NOT NULL CHECK (currency IN ('EGP','SAR')),
            src_acc_id BIGINT NULL,                                -- core users.id; NULL = platform
            dst_acc_id BIGINT NULL,                                -- core users.id; NULL = platform
            is_refunded BOOLEAN NOT NULL DEFAULT FALSE,
            refunded_payment_id BIGINT NULL,                       -- on a refund row: the charge it refunds
            idempotency_key TEXT NULL,                             -- webhook event id / Idempotency-Key / auto-refund:<order>
            note TEXT NULL,
            provider_requested_at TIMESTAMP NULL,                  -- refund: when it was sent to the provider (NULL = queued)
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_transactions_order_id FOREIGN KEY (order_id, order_created_at)
                REFERENCES orders (id, created_at),
            CONSTRAINT fk_transactions_refunded_payment_id FOREIGN KEY (refunded_payment_id) REFERENCES transactions (id),
            CONSTRAINT uq_transactions_idempotency_key UNIQUE (idempotency_key),
            CONSTRAINT chk_transactions_accounts CHECK (src_acc_id IS NOT NULL OR dst_acc_id IS NOT NULL),
            CONSTRAINT chk_transactions_order_ref CHECK ((order_id IS NULL) = (order_created_at IS NULL))
        );

        -- supports order detail ledger + settlement lookups (charge / cod_collection) and the FK   (Q-P3)
        CREATE INDEX idx_transactions_order_id_order_created_at ON transactions (order_id, order_created_at)
            WHERE order_id IS NOT NULL;
        -- supports refund webhook -> refund row / charge by Kashier reference                    (Q-P4)
        CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id)
            WHERE provider_reference_id IS NOT NULL;
        -- supports GET /restaurant/payouts?from=&to=                                               (Q-F2)
        CREATE INDEX idx_transactions_dst_acc_type_created_at ON transactions (dst_acc_id, transaction_type, created_at DESC)
            WHERE transaction_type = 'payout';
        -- supports admin reconciliation by type + status + time                                  (Q-P6)
        CREATE INDEX idx_transactions_type_status_created_at ON transactions (transaction_type, status, created_at DESC);
        -- supports the refund chain of a charge and the FK                                       (Q-P5)
        CREATE INDEX idx_transactions_refunded_payment_id ON transactions (refunded_payment_id)
            WHERE refunded_payment_id IS NOT NULL;
        -- supports the refund sweep: queued refunds to send, sent ones with no outcome yet        (Q-P8)
        CREATE INDEX idx_transactions_pending_refunds_created_at ON transactions (created_at)
            WHERE transaction_type = 'refund' AND status = 'pending';
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS transactions;`);
}
