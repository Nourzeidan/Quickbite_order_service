import type {Knex} from "knex";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";
import {OrderStatus} from "../../order/enums.js";
import {OPEN_SESSION_STATUSES, TransactionStatus} from "../../payment/enums.js";
import {
    ORDER_TABLES,
    PRIMARY_KEYS,
    type ArchivedTable,
    type MonthPartition,
    type OrderBatchRows,
    type OrderKey,
    type OrderTable,
    type Row
} from "../types.js";

// docs/business-logic/archival.md §5. Every function takes `conn` last: a hot shard, an archive shard
// or a trx on one of them — the same SQL runs on both clusters (identical schema).
//
// Why row_to_json() instead of the usual *_COLUMNS lists: this module copies WHOLE rows between two
// databases. Reading them as JSON and writing them back with json_populate_recordset() keeps every
// value exactly as Postgres stored it (TIMESTAMP, BIGINT, DECIMAL, JSONB) with no JS conversion,
// and the column list comes from the catalogue (tableColumns), so a column added by a later
// migration can't be silently dropped by the copy.

const TERMINAL_STATUSES = [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.REJECTED];
// a refund shortfall is a permanent "owed" record that nothing processes: it doesn't block archival
const SHORTFALL_KEY_PREFIX = "refund-shortfall:";

// key of the rows that belong to an order: (order_id, order_created_at) for children
const ORDER_KEY_COLUMN: Record<OrderTable, {id: string; createdAt: string}> = {
    orders: {id: "id", createdAt: "created_at"},
    order_items: {id: "order_id", createdAt: "order_created_at"},
    payment_sessions: {id: "order_id", createdAt: "order_created_at"},
    transactions: {id: "order_id", createdAt: "order_created_at"},
    agent_earnings: {id: "order_id", createdAt: "order_created_at"},
};

// [from, to) around a batch's created_at values: prunes orders / order_items to their partition(s)
export interface TimeRange {
    from: Date;
    to: Date;
}

// ---------------------------------------------------------------- schema

// the table's columns in their physical order (information_schema)
export async function tableColumns(table: ArchivedTable, conn: Knex): Promise<string[]> {
    const rows = await conn("information_schema.columns")
        .select("column_name")
        .where({table_schema: "public", table_name: table})
        .orderBy("ordinal_position");
    return rows.map((row: {column_name: string}) => row.column_name);
}

// ---------------------------------------------------------------- partitions

// Q-X5 — the month partitions of a pg_partman parent with their bounds (default partition excluded)
export async function listMonthPartitions(parent: "orders" | "order_items", conn: Knex): Promise<MonthPartition[]> {
    const result = await conn.raw(`
        SELECT p.partition_tablename AS name, i.child_start_time AS start, i.child_end_time AS "end"
        FROM partman.show_partitions(?, 'ASC', false) p
        CROSS JOIN LATERAL partman.show_partition_info(p.partition_schemaname || '.' || p.partition_tablename) i
    `, [`public.${parent}`]);
    return result.rows.map((row: {name: string; start: Date; end: Date}) => ({name: row.name, start: row.start, end: row.end}));
}

// archive side: pg_partman only premakes FUTURE months, so a past month is created before it is filled
export async function ensureMonthPartition(parent: "orders" | "order_items", monthStart: Date, conn: Knex): Promise<void> {
    await conn.raw("SELECT partman.create_partition_time(?, ARRAY[?::timestamptz])", [`public.${parent}`, monthStart.toISOString()]);
}

export async function isTableEmpty(table: string, conn: Knex): Promise<boolean> {
    const result = await conn.raw("SELECT NOT EXISTS (SELECT 1 FROM ??) AS empty", [table]);
    return result.rows[0].empty === true;
}

// Dropping an emptied month returns its disk at once (a DELETE only leaves dead rows for VACUUM).
// order_items first: it references orders. DETACH / DROP need a short exclusive lock on the parent;
// lock_timeout makes a busy moment skip the drop (retried next run) instead of queueing every query
// on orders behind it.
export async function dropMonthPartitions(ordersPartition: string, itemsPartition: string | null, trx: Knex): Promise<void> {
    await trx.raw("SET LOCAL lock_timeout = '2s'");
    if(itemsPartition){
        await trx.raw("ALTER TABLE order_items DETACH PARTITION ??", [itemsPartition]);
        await trx.raw("DROP TABLE ??", [itemsPartition]);
    }
    await trx.raw("ALTER TABLE orders DETACH PARTITION ??", [ordersPartition]);
    await trx.raw("DROP TABLE ??", [ordersPartition]);
}

// ---------------------------------------------------------------- picking orders

// Q-X2 — the next candidates of one partition: terminal, before the cutoff, untouched for minAge.
// Keyset by id (the PK (id, created_at) of the partition), so ineligible rows are walked past.
export async function findArchiveCandidates(
    partition: string,
    before: Date,
    untouchedSince: Date,
    afterId: number,
    limit: number,
    conn: Knex
): Promise<OrderKey[]> {
    const rows = await conn(partition)
        .select("id", "public_id", "created_at")
        .where("created_at", "<", toUtcTimestamp(before))
        .whereIn("status", TERMINAL_STATUSES)
        .andWhere("updated_at", "<", toUtcTimestamp(untouchedSince))
        .andWhere("id", ">", afterId)
        .orderBy("id")
        .limit(limit);
    return rows.map((row: {id: string; public_id: string; created_at: Date}) => ({id: Number(row.id), publicId: row.public_id, createdAt: row.created_at}));
}

// Q-X6 — which of these orders still have money in flight (one query, never one per order):
// a pending ledger row (except shortfalls) or a payment session that could still get a webhook
export async function findOrdersWithOpenMoney(ids: number[], range: TimeRange, conn: Knex): Promise<Set<number>> {
    if(ids.length === 0) return new Set();
    const result = await conn.raw(`
        SELECT order_id FROM transactions
        WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ?
          AND status = ?
          AND (idempotency_key IS NULL OR idempotency_key NOT LIKE ?)
        UNION
        SELECT order_id FROM payment_sessions
        WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ?
          AND status = ANY(?::text[])
    `, [
        ids, toUtcTimestamp(range.from), toUtcTimestamp(range.to), TransactionStatus.PENDING, `${SHORTFALL_KEY_PREFIX}%`,
        ids, toUtcTimestamp(range.from), toUtcTimestamp(range.to), OPEN_SESSION_STATUSES,
    ]);
    return new Set(result.rows.map((row: {order_id: string}) => Number(row.order_id)));
}

// ---------------------------------------------------------------- reading whole rows

// Q-X1 — the orders and every child row, as stored, ordered by id. Five indexed queries per batch.
export async function loadOrderRows(ids: number[], range: TimeRange, conn: Knex): Promise<OrderBatchRows> {
    const rows = {} as OrderBatchRows;
    for(const table of ORDER_TABLES){
        const key = ORDER_KEY_COLUMN[table];
        const result = await conn.raw(`
            SELECT row_to_json(t) AS row FROM ?? t
            WHERE ?? = ANY(?::bigint[]) AND ?? >= ? AND ?? < ?
            ORDER BY t.id
        `, [table, key.id, ids, key.createdAt, toUtcTimestamp(range.from), key.createdAt, toUtcTimestamp(range.to)]);
        rows[table] = result.rows.map((row: {row: Row}) => row.row);
    }
    return rows;
}

// Lock order: the ORDER rows first, then their transactions and sessions — the same order as the
// settlement and the refund webhook, so this can't deadlock with them. Whoever writes to these rows
// (an admin refund locks the charge) either finishes first or waits for the delete.
export async function lockOrderRows(ids: number[], range: TimeRange, trx: Knex): Promise<void> {
    for(const table of ["orders", "transactions", "payment_sessions"] as const){
        const key = ORDER_KEY_COLUMN[table];
        await trx.raw(`
            SELECT 1 FROM ?? WHERE ?? = ANY(?::bigint[]) AND ?? >= ? AND ?? < ? ORDER BY id FOR UPDATE
        `, [table, key.id, ids, key.createdAt, toUtcTimestamp(range.from), key.createdAt, toUtcTimestamp(range.to)]);
    }
}

// Q-X3 / Q-X4 — rows without an order, older than `before`, keyset by id
export async function loadOrderlessRows(
    table: "transactions" | "payment_webhook_events",
    before: Date,
    afterId: number,
    limit: number,
    conn: Knex
): Promise<Row[]> {
    const sql = table === "transactions"
        // payouts and non-order adjustments (partial index idx_transactions_created_at_no_order)
        ? `SELECT row_to_json(t) AS row FROM transactions t
           WHERE order_id IS NULL AND created_at < ? AND status <> 'pending' AND id > ? ORDER BY id LIMIT ?`
        // idx_payment_webhook_events_received_at
        : `SELECT row_to_json(t) AS row FROM payment_webhook_events t
           WHERE received_at < ? AND id > ? ORDER BY id LIMIT ?`;
    const result = await conn.raw(sql, [toUtcTimestamp(before), afterId, limit]);
    return result.rows.map((row: {row: Row}) => row.row);
}

export async function loadRowsById(table: "transactions" | "payment_webhook_events", ids: number[], conn: Knex): Promise<Row[]> {
    const result = await conn.raw("SELECT row_to_json(t) AS row FROM ?? t WHERE id = ANY(?::bigint[]) ORDER BY id", [table, ids]);
    return result.rows.map((row: {row: Row}) => row.row);
}

export async function lockRowsById(table: "transactions" | "payment_webhook_events", ids: number[], trx: Knex): Promise<void> {
    await trx.raw("SELECT 1 FROM ?? WHERE id = ANY(?::bigint[]) ORDER BY id FOR UPDATE", [table, ids]);
}

// ---------------------------------------------------------------- writing

// Insert rows as they are; a row already there (an earlier run that crashed before the delete) is
// overwritten with the latest hot values, so a re-copy is never stale (D4). One statement per table.
export async function upsertRows(table: ArchivedTable, rows: Row[], columns: string[], conn: Knex): Promise<void> {
    if(rows.length === 0) return;
    const keys = PRIMARY_KEYS[table];
    const updates = columns.filter((column) => !keys.includes(column));
    await conn.raw(`
        INSERT INTO ?? (??)
        SELECT ?? FROM json_populate_recordset(NULL::??, ?::json)
        ON CONFLICT (??) DO UPDATE SET ${updates.map(() => "?? = EXCLUDED.??").join(", ")}
    `, [table, columns, columns, table, JSON.stringify(rows), keys, ...updates.flatMap((column) => [column, column])]);
}

// children first. Refunds before charges: a refund points to its charge (refunded_payment_id).
// order_items go with their order (ON DELETE CASCADE).
export async function deleteOrderRows(ids: number[], range: TimeRange, trx: Knex): Promise<void> {
    const bounds = [ids, toUtcTimestamp(range.from), toUtcTimestamp(range.to)];
    await trx.raw("DELETE FROM agent_earnings WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ?", bounds);
    await trx.raw("DELETE FROM transactions WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ? AND refunded_payment_id IS NOT NULL", bounds);
    await trx.raw("DELETE FROM transactions WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ?", bounds);
    await trx.raw("DELETE FROM payment_sessions WHERE order_id = ANY(?::bigint[]) AND order_created_at >= ? AND order_created_at < ?", bounds);
    await trx.raw("DELETE FROM orders WHERE id = ANY(?::bigint[]) AND created_at >= ? AND created_at < ?", bounds);
}

export async function deleteRowsById(table: "transactions" | "payment_webhook_events", ids: number[], trx: Knex): Promise<void> {
    await trx.raw("DELETE FROM ?? WHERE id = ANY(?::bigint[])", [table, ids]);
}

// ---------------------------------------------------------------- stuck orders

// prior-year orders still hot (only run after ARCHIVE_STUCK_ALERT_DAYS, when the old months are
// nearly empty): count + a sample of public ids for the alert
export async function findStuckOrders(before: Date, sample: number, conn: Knex): Promise<{count: number; publicIds: string[]}> {
    const [count, rows] = await Promise.all([
        conn("orders").count({count: "*"}).where("created_at", "<", toUtcTimestamp(before)),
        conn("orders").select("public_id").where("created_at", "<", toUtcTimestamp(before)).orderBy("created_at").limit(sample),
    ]);
    return {count: Number(count[0]?.count ?? 0), publicIds: rows.map((row: {public_id: string}) => row.public_id)};
}

// ---------------------------------------------------------------- one archiver per region

// Session-level advisory lock on ONE pooled connection, held for the whole run and released at the
// end (or when the process dies and the connection closes). Another archiver gets false and skips.
// Not a transaction lock on purpose: a run lasts minutes and a transaction open that long would
// hold back VACUUM on the whole shard.
export async function withAdvisoryLock<T>(key: string, conn: Knex, fn: () => Promise<T>): Promise<T | null> {
    const client = conn.client as {acquireConnection(): Promise<unknown>; releaseConnection(connection: unknown): Promise<void>};
    const connection = await client.acquireConnection();
    try{
        const locked = await conn.raw("SELECT pg_try_advisory_lock(hashtext(?)) AS ok", [key]).connection(connection);
        if(locked.rows[0].ok !== true){
            return null;
        }
        try{
            return await fn();
        }finally{
            await conn.raw("SELECT pg_advisory_unlock(hashtext(?))", [key]).connection(connection);
        }
    }finally{
        await client.releaseConnection(connection);
    }
}
