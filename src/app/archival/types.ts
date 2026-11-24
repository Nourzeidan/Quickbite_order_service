// docs/business-logic/archival.md — shapes shared by the archival repository and service

// a row exactly as Postgres stores it, read with row_to_json() and written back with
// json_populate_recordset(): no JS type conversion in between (no Date / BIGINT / DECIMAL drift)
export type Row = Record<string, unknown>;

// an order and everything attached to it moves together, in this order (FK order for inserts)
export const ORDER_TABLES = ["orders", "order_items", "payment_sessions", "transactions", "agent_earnings"] as const;
export type OrderTable = (typeof ORDER_TABLES)[number];

// rows that have no order move on their own, by date (§5.3)
export const ORDERLESS_TABLES = ["transactions", "payment_webhook_events"] as const;
export type OrderlessTable = (typeof ORDERLESS_TABLES)[number];

export type ArchivedTable = OrderTable | OrderlessTable;

// ON CONFLICT target of each table (its primary key; partitioned tables include the partition key)
export const PRIMARY_KEYS: Record<ArchivedTable, string[]> = {
    orders: ["id", "created_at"],
    order_items: ["id", "order_created_at"],
    payment_sessions: ["id"],
    transactions: ["id"],
    agent_earnings: ["id"],
    payment_webhook_events: ["id"],
};

export type OrderBatchRows = Record<OrderTable, Row[]>;

// an order picked for a batch: its PK, enough to find its partition and its children
export interface OrderKey {
    id: number;
    publicId: string;
    createdAt: Date;
}

// a month partition of orders (or order_items) on the hot shard
export interface MonthPartition {
    name: string;
    start: Date;
    end: Date;
}

// what one run did in one region (logged; printed by `npm run archive:once`)
export interface ArchivalRegionReport {
    region: string;
    skipped: "locked" | null;           // another archiver holds this region
    batches: number;
    ordersMoved: number;
    ordersBlocked: number;              // prior-year, terminal, but money still pending (§3)
    batchesChanged: number;             // rows changed between copy and delete -> retried next run
    payoutsMoved: number;
    webhookEventsMoved: number;
    partitionsDropped: string[];
    stuckOrders: number | null;         // only counted once ARCHIVE_STUCK_ALERT_DAYS have passed
}
