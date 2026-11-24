// Prints the payment side of one order: order status, sessions, ledger rows, webhook events.
//   npx tsx play/payment-checks.ts                 -> latest order on REGION (default eg)
//   npx tsx play/payment-checks.ts <publicId>
//   $env:REGION="ksa"; npx tsx play/payment-checks.ts <publicId>
import {db, destroyAll} from "../src/lib/knex/knex.js";

const region = process.env.REGION ?? "eg";
const conn = db(region);

try{
    const publicId = process.argv[2] ?? (await conn.raw(`SELECT public_id FROM orders ORDER BY created_at DESC LIMIT 1`)).rows[0]?.public_id;
    if(!publicId){
        console.log(`no orders on ${region}`);
        process.exit(0);
    }

    const {rows: [order]} = await conn.raw(`
        SELECT id, created_at, public_id, status, cancel_reason, payment_method, total, currency
        FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')
    `, [publicId, publicId]);
    if(!order){
        console.log(`order ${publicId} not found on ${region}`);
        process.exit(0);
    }
    console.log(`\nORDER ${order.public_id}  ${order.status}${order.cancel_reason ? ` (${order.cancel_reason})` : ""}  ${order.payment_method}  ${order.total} ${order.currency}`);

    const {rows: sessions} = await conn.raw(`
        SELECT id, merchant_order_ref, provider_session_id, status, amount, expires_at, redirect_url
        FROM payment_sessions WHERE order_id = ? AND order_created_at = ? ORDER BY id
    `, [order.id, order.created_at.toISOString()]);
    console.log(`\nSESSIONS (${sessions.length})`);
    console.table(sessions);

    const {rows: ledger} = await conn.raw(`
        SELECT id, transaction_type AS type, method, status, amount, src_acc_id AS src, dst_acc_id AS dst,
               provider_reference_id AS provider_ref, refunded_payment_id AS refunds, is_refunded,
               provider_requested_at IS NOT NULL AS sent, idempotency_key, note
        FROM transactions WHERE order_id = ? AND order_created_at = ? ORDER BY id
    `, [order.id, order.created_at.toISOString()]);
    console.log(`\nLEDGER (${ledger.length})`);
    console.table(ledger);

    const {rows: events} = await conn.raw(`
        SELECT id, provider_event_id, received_at, processed_at IS NOT NULL AS processed, process_error,
               payload->'data'->>'amount' AS amount
        FROM payment_webhook_events WHERE payload->'data'->>'merchantOrderId' LIKE ? ORDER BY id
    `, [`${region}_${publicId}%`]);
    console.log(`\nWEBHOOK EVENTS (${events.length})`);
    console.table(events);
}finally{
    await destroyAll();
}
