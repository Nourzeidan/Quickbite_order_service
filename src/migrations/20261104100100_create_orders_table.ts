import type {Knex} from "knex";

// Order header, range-partitioned by month on created_at (pg_partman).
//
// A partitioned table's PK / UNIQUE must contain the partition key, hence (id, created_at) and
// (public_id, created_at). public_id is a UUIDv7 and created_at is DERIVED from it on insert
// (uuid_extract_timestamp), so:
//   - (public_id, created_at) unique  <=>  public_id unique (created_at is a function of public_id)
//   - a lookup by public_id also knows created_at -> the planner prunes to ONE partition (Q-O1)
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE orders (
            id BIGSERIAL NOT NULL,
            region TEXT NOT NULL,
            public_id UUID NOT NULL,
            country_code TEXT NOT NULL,
            restaurant_id BIGINT NOT NULL,
            branch_id BIGINT NOT NULL,
            customer_id BIGINT NOT NULL,
            customer_address_id BIGINT NOT NULL,

            delivery_lat DECIMAL(10,7) NOT NULL,
            delivery_lng DECIMAL(10,7) NOT NULL,
            delivery_address_text_snapshot TEXT NOT NULL,

            status TEXT NOT NULL CHECK (status IN (
                'pending_payment','placed','accepted','rejected',
                'preparing','ready','assigned','picked','delivered','cancelled')),
            cancel_reason TEXT NULL,

            subtotal INT NOT NULL,
            delivery_fee INT NOT NULL,
            service_fee INT NOT NULL,
            total INT NOT NULL,
            commission INT NOT NULL DEFAULT 0,
            currency TEXT NOT NULL CHECK (currency IN ('EGP','SAR')),
            payment_method TEXT NOT NULL CHECK (payment_method IN ('online','cod')),

            delivery_agent_id BIGINT NULL,

            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            accepted_at TIMESTAMP NULL,
            rejected_at TIMESTAMP NULL,
            ready_at TIMESTAMP NULL,
            assigned_at TIMESTAMP NULL,
            picked_at TIMESTAMP NULL,
            delivered_at TIMESTAMP NULL,
            cancelled_at TIMESTAMP NULL,

            CONSTRAINT pk_orders PRIMARY KEY (id, created_at),
            CONSTRAINT uq_orders_public_id UNIQUE (public_id, created_at),
            CONSTRAINT chk_orders_total CHECK (total = subtotal + delivery_fee + service_fee),
            CONSTRAINT chk_orders_commission CHECK (commission >= 0 AND commission <= subtotal)
        ) PARTITION BY RANGE (created_at);

        -- supports GET /customer/orders?year=                              (Q-O2)
        CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);
        -- supports GET /restaurant/orders?branchId=&status=&from=&to=       (Q-O3, most queried)
        CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);
        -- supports the payment-expiry sweep and the assignment scan          (Q-O4, Q-O5)
        CREATE INDEX idx_orders_status_created_at ON orders (status, created_at)
            WHERE status IN ('pending_payment','ready','assigned');
        -- supports the agent's current orders                               (Q-O6)
        CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status)
            WHERE delivery_agent_id IS NOT NULL;
        -- supports GET /admin/orders without a branchId                      (Q-O9)
        CREATE INDEX idx_orders_created_at ON orders (created_at DESC);

        -- monthly partitions, 4 premade ahead, default partition catches anything out of range.
        -- infinite_time_partitions: keep premaking even on a quiet shard (dev, a new region).
        SELECT partman.create_parent(
            p_parent_table := 'public.orders',
            p_control := 'created_at',
            p_interval := '1 month',
            p_premake := 4
        );
        UPDATE partman.part_config SET infinite_time_partitions = TRUE WHERE parent_table = 'public.orders';
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DELETE FROM partman.part_config WHERE parent_table = 'public.orders';
        DROP TABLE IF EXISTS orders CASCADE;
        DROP TABLE IF EXISTS partman.template_public_orders;
    `);
}
