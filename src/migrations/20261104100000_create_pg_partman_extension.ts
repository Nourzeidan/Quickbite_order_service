import type {Knex} from "knex";

// pg_partman manages the monthly partitions of orders / order_items (docs/database-design.md §4.0).
// It is installed SQL-only (no pg_partman_bgw): src/lib/jobs/partition-maintenance.ts calls
// partman.run_maintenance_proc() on a timer instead of the background worker.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE SCHEMA IF NOT EXISTS partman;
        CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP EXTENSION IF EXISTS pg_partman;
        DROP SCHEMA IF EXISTS partman;
    `);
}
