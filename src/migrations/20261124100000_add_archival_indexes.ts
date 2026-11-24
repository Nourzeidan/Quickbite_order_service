import type {Knex} from "knex";

// Phase 5 — archival of rows that have no order (docs/business-logic/archival.md §5.3).
// Orders and their children are found through the order (partition + order_id indexes); payouts and
// webhook events are found by date, and without these the nightly query is a full scan of two of the
// biggest tables.
//
// CONCURRENTLY: building an index on a live table must not block writes (payments, settlements).
// CREATE INDEX CONCURRENTLY can't run inside a transaction, hence `transaction: false`.
export const config = {transaction: false};

export async function up(knex: Knex): Promise<void> {
    // supports Q-X3: transactions WHERE order_id IS NULL AND created_at < ? ORDER BY id (payouts, non-order adjustments)
    // partial: only order-less rows (a small fraction of the ledger) are in it
    await knex.raw(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_created_at_no_order
            ON transactions (created_at) WHERE order_id IS NULL;
    `);
    // supports Q-X4: payment_webhook_events WHERE received_at < ? ORDER BY id
    await knex.raw(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_webhook_events_received_at
            ON payment_webhook_events (received_at);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_webhook_events_received_at;`);
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_created_at_no_order;`);
}
