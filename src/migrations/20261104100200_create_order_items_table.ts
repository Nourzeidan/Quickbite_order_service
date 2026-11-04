import type {Knex} from "knex";

// Partitioned like orders, on the parent's created_at (copied into order_created_at), so a month of
// orders and its items live in partitions with the same bounds (archival detaches both, Phase 7).
// The FK must reference orders' PK (id, created_at), hence the composite FK.
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE order_items (
            id BIGSERIAL NOT NULL,
            region TEXT NOT NULL,
            order_id BIGINT NOT NULL,
            order_created_at TIMESTAMP NOT NULL,
            product_id BIGINT NOT NULL,
            quantity INT NOT NULL CHECK (quantity > 0),
            unit_price_snapshot INT NOT NULL,
            name_snapshot TEXT NOT NULL,
            image_url_snapshot TEXT NULL,
            line_total INT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT pk_order_items PRIMARY KEY (id, order_created_at),
            CONSTRAINT fk_order_items_order_id FOREIGN KEY (order_id, order_created_at)
                REFERENCES orders (id, created_at) ON DELETE CASCADE,
            CONSTRAINT chk_order_items_line_total CHECK (line_total = quantity * unit_price_snapshot)
        ) PARTITION BY RANGE (order_created_at);

        -- supports order detail + list expansion with one whereIn, and the FK   (Q-O7)
        CREATE INDEX idx_order_items_order_id_order_created_at ON order_items (order_id, order_created_at);

        SELECT partman.create_parent(
            p_parent_table := 'public.order_items',
            p_control := 'order_created_at',
            p_interval := '1 month',
            p_premake := 4
        );
        UPDATE partman.part_config SET infinite_time_partitions = TRUE WHERE parent_table = 'public.order_items';
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DELETE FROM partman.part_config WHERE parent_table = 'public.order_items';
        DROP TABLE IF EXISTS order_items CASCADE;
        DROP TABLE IF EXISTS partman.template_public_order_items;
    `);
}
