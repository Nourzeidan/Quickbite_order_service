import type {Knex} from "knex";

// branch position snapshotted at placement (deliveries.md §1.1): the offer worker and the agents'
// "available orders" list need the pickup point of many ready orders at once.
// NULL on orders placed before Phase 3 (the service falls back to the cached core branch).
// Added on the partitioned parent, so every partition (and future ones) gets the columns.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE orders
            ADD COLUMN pickup_lat DECIMAL(10,7) NULL,
            ADD COLUMN pickup_lng DECIMAL(10,7) NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        ALTER TABLE orders
            DROP COLUMN IF EXISTS pickup_lat,
            DROP COLUMN IF EXISTS pickup_lng;
    `);
}
