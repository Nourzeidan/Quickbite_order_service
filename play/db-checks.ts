// Phase 1 database acceptance checks on one shard:  npx tsx play/db-checks.ts [region]
// partitions, partition pruning for Q-O1, index use for Q-O2 / Q-O3, voided out-of-stock orders.
import {db, destroyAll} from "../src/lib/knex/knex.js";

const region = process.argv[2] ?? "eg";
const conn = db(region);

async function plan(title: string, sql: string, bindings: unknown[] = []) {
    const {rows} = await conn.raw(`EXPLAIN ${sql}`, bindings);
    console.log(`\n=== ${title}`);
    for(const row of rows) console.log("  " + row["QUERY PLAN"]);
}

try{
    const {rows: parts} = await conn.raw(`
        SELECT parent.relname AS parent, child.relname AS partition, pg_get_expr(child.relpartbound, child.oid) AS bounds
        FROM pg_inherits i
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_class child  ON child.oid  = i.inhrelid
        WHERE parent.relname IN ('orders', 'order_items')
        ORDER BY parent.relname, child.relname`);
    console.log(`=== partitions (${region})`);
    for(const p of parts) console.log(`  ${p.parent.padEnd(12)} ${p.partition.padEnd(28)} ${p.bounds}`);

    const {rows: [latest]} = await conn.raw(`SELECT public_id, customer_id, branch_id FROM orders ORDER BY created_at DESC LIMIT 1`);
    if(!latest){
        console.log("\nno orders on this shard yet: place one first");
    }else{
        // the exact predicate findOrderByPublicId uses
        await plan("Q-O1 order by public id (expect ONE partition, no Append)",
            `SELECT id FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`,
            [latest.public_id, latest.public_id]);

        // tiny tables make seq scans cheaper; turn them off to show the index CAN serve the query
        await conn.raw("SET enable_seqscan = off");
        const year = new Date().getUTCFullYear();
        await plan("Q-O2 customer orders this year (expect idx ...customer_id_created_at)",
            `SELECT id FROM orders WHERE customer_id = ? AND created_at >= ? AND created_at < ?
             ORDER BY created_at DESC, public_id DESC LIMIT 21`,
            [latest.customer_id, `${year}-01-01`, `${year + 1}-01-01`]);
        await plan("Q-O3 branch orders by status this month (expect idx ...branch_status_created_at)",
            `SELECT id FROM orders WHERE branch_id = ? AND status = 'placed' AND created_at >= date_trunc('month', now()) AND created_at < date_trunc('month', now()) + interval '1 month'
             ORDER BY created_at DESC, public_id DESC LIMIT 21`,
            [latest.branch_id]);
        await conn.raw("RESET enable_seqscan");
    }

    const {rows: voided} = await conn.raw(`
        SELECT public_id, status, cancel_reason, created_at FROM orders
        WHERE cancel_reason IN ('out_of_stock_post_commit', 'stock_reservation_failed')
        ORDER BY created_at DESC LIMIT 5`);
    console.log("\n=== orders voided after commit (out of stock / core unreachable)");
    if(voided.length === 0) console.log("  none");
    for(const v of voided) console.log(`  ${v.public_id}  ${v.status}  ${v.cancel_reason}`);

    const {rows: [idem]} = await conn.raw(`SELECT count(*)::int AS n FROM idempotency_keys`);
    console.log(`\n=== idempotency_keys rows: ${idem.n}`);
}finally{
    await destroyAll();
}
