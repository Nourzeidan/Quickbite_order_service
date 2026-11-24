// Phase 2 test driver: finds every id it needs in the database, so nothing has to be typed.
// The customer / branch / address / product come from the latest order on the shard (your Phase 1 orders).
//
//   npx tsx play/pay-test.ts order online        place an online order + POST /payments/init -> prints the Kashier URL
//   npx tsx play/pay-test.ts order cod           place a COD order
//   npx tsx play/pay-test.ts init                POST /payments/init again for the latest order (same session expected)
//   npx tsx play/pay-test.ts pay [FAILURE]       fake a signed Kashier webhook for the latest order's latest session
//   npx tsx play/pay-test.ts pay SUCCESS again   same transaction id as the previous fake -> must be a duplicate
//   npx tsx play/pay-test.ts cancel              cancel the latest order as its customer
//   npx tsx play/pay-test.ts refund [amount]     admin refund of the latest order's succeeded charge (amount in minor units)
//   npx tsx play/pay-test.ts show                order + sessions + ledger + webhook events (= payment-checks.ts)
//
// Options: REGION=ksa (default eg). Every command works on the LATEST order of the shard unless ORDER=<publicId> is set.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = process.env.REGION ?? "eg";
const base = `http://localhost:${env.port}/api`;
const conn = db(region);
const [command = "show", ...rest] = process.argv.slice(2);

function token(payload: Record<string, unknown>): string {
    return jwt.sign(payload, env.jwt.accessSecret, {expiresIn: "1h"});
}
const adminToken = () => token({userId: 999, email: "admin@test.com", role: "admin"});
const customerToken = (userId: number) => token({userId, email: `c${userId}@test.com`, role: "customer"});

async function call(method: string, path: string, opts: {token: string; body?: unknown; key?: boolean}) {
    const headers: Record<string, string> = {
        "Authorization": `Bearer ${opts.token}`,
        "X-Region": region,
        "Content-Type": "application/json",
    };
    if(opts.key) headers["Idempotency-Key"] = crypto.randomUUID();
    const init: RequestInit = {method, headers};
    if(opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    console.log(`${method} ${path} -> ${res.status}`);
    let json: any = null;
    try{ json = JSON.parse(text); }catch{ /* not json */ }
    console.log(json ? JSON.stringify(json, null, 2) : text);
    return {status: res.status, json};
}

// the order to work on: ORDER=<publicId> or the latest one
async function targetOrder() {
    const publicId = process.env.ORDER;
    const {rows: [order]} = publicId
        ? await conn.raw(`SELECT * FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`, [publicId, publicId])
        : await conn.raw(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 1`);
    if(!order) throw new Error(`no order found on ${region}${publicId ? ` with publicId ${publicId}` : ""}`);
    return order;
}

async function placeOrder(method: "online" | "cod") {
    // template = latest order on this shard (customer, branch, address, products)
    const template = await targetOrder();
    const {rows: items} = await conn.raw(
        `SELECT product_id, quantity FROM order_items WHERE order_id = ? AND order_created_at = ?`,
        [template.id, template.created_at.toISOString()]);
    const customerId = Number(template.customer_id);
    console.log(`using customer ${customerId}, branch ${template.branch_id}, address ${template.customer_address_id}, products ${items.map((i: any) => i.product_id).join(",")}\n`);

    const placed = await call("POST", "/orders", {
        token: customerToken(customerId),
        key: true,
        body: {
            branchId: Number(template.branch_id),
            customerAddressId: Number(template.customer_address_id),
            paymentMethod: method,
            items: items.map((item: any) => ({productId: Number(item.product_id), quantity: 1})),
        },
    });
    if(placed.status !== 201 || method === "cod") return;
    await initPayment(placed.json.data.publicId, customerId);
}

async function initPayment(publicId: string, customerId: number) {
    const result = await call("POST", "/payments/init", {token: customerToken(customerId), key: true, body: {orderId: publicId}});
    if(result.status === 200){
        console.log(`\n>>> open this in your browser and pay with a Kashier test card:\n${result.json.data.redirectUrl}\n`);
        console.log(`>>> then: npx tsx play/pay-test.ts show`);
    }
}

// fake Kashier webhook for the latest session of the order, signed like Kashier does
async function fakeWebhook(status: string, again: boolean) {
    const order = await targetOrder();
    const {rows: [session]} = await conn.raw(
        `SELECT merchant_order_ref, amount, currency FROM payment_sessions WHERE order_id = ? AND order_created_at = ? ORDER BY id DESC LIMIT 1`,
        [order.id, order.created_at.toISOString()]);
    if(!session) throw new Error("this order has no payment session yet (run: order online, or init)");

    // the transaction id is remembered per order so "again" can replay the exact same event
    const txFile = `play/.last-fake-tx-${order.public_id}`;
    const fs = await import("fs");
    const transactionId = again && fs.existsSync(txFile) ? fs.readFileSync(txFile, "utf8") : `TX-FAKE-${Date.now()}`;
    fs.writeFileSync(txFile, transactionId);

    const data: Record<string, unknown> = {
        merchantOrderId: session.merchant_order_ref,
        kashierOrderId: `K-FAKE-${order.public_id}`,
        orderReference: `TEST-${Date.now()}`,
        transactionId,
        status,
        method: "card",
        amount: env.kashier.webhookAmountUnit === "minor" ? session.amount : Number(fromMinor(session.amount)),
        currency: session.currency,
        transactionResponseCode: status === "SUCCESS" ? "00" : "05",
        channel: "online | e-commerce",
    };
    const signatureKeys = ["amount", "channel", "currency", "kashierOrderId", "merchantOrderId", "method", "orderReference", "status", "transactionId", "transactionResponseCode"];
    data.signatureKeys = signatureKeys;
    const signature = signKashierPayload(buildSignaturePayload(data, signatureKeys), env.kashier.webhookSecret);

    const res = await fetch(`${base}/payments/webhook/kashier`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "x-kashier-signature": signature},
        body: JSON.stringify({event: "pay", data}),
    });
    console.log(`fake webhook ${status} (${transactionId}) -> ${res.status} ${await res.text()}`);
}

async function show() {
    const order = await targetOrder();
    const createdAt = order.created_at.toISOString();
    console.log(`\nORDER ${order.public_id}  status=${order.status}${order.cancel_reason ? ` (${order.cancel_reason})` : ""}  ${order.payment_method}  total=${order.total} ${order.currency}  customer=${order.customer_id}`);

    const {rows: sessions} = await conn.raw(`
        SELECT id, merchant_order_ref, status, amount, expires_at FROM payment_sessions
        WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [order.id, createdAt]);
    console.log(`\nSESSIONS (${sessions.length})`); console.table(sessions);

    const {rows: ledger} = await conn.raw(`
        SELECT id, transaction_type AS type, status, amount, provider_reference_id AS provider_ref,
               refunded_payment_id AS refunds, is_refunded, provider_requested_at IS NOT NULL AS sent, note
        FROM transactions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [order.id, createdAt]);
    console.log(`\nLEDGER (${ledger.length})`); console.table(ledger);

    const {rows: events} = await conn.raw(`
        SELECT id, provider_event_id, processed_at IS NOT NULL AS processed, process_error, payload->'data'->>'amount' AS amount
        FROM payment_webhook_events WHERE payload->'data'->>'merchantOrderId' LIKE ? ORDER BY id`, [`${region}_${order.public_id}%`]);
    console.log(`\nWEBHOOK EVENTS (${events.length})`); console.table(events);
}

try{
    switch(command){
        case "order": {
            const method = rest[0] === "cod" ? "cod" : "online";
            await placeOrder(method);
            break;
        }
        case "init": {
            const order = await targetOrder();
            await initPayment(order.public_id, Number(order.customer_id));
            break;
        }
        case "pay":
            await fakeWebhook((rest[0] ?? "SUCCESS").toUpperCase(), rest.includes("again"));
            break;
        case "cancel": {
            const order = await targetOrder();
            await call("PATCH", `/orders/${order.public_id}/status`, {
                token: customerToken(Number(order.customer_id)), key: true, body: {status: "cancelled", reason: "test cancel"},
            });
            break;
        }
        case "refund": {
            const order = await targetOrder();
            const {rows: [charge]} = await conn.raw(`
                SELECT id FROM transactions WHERE order_id = ? AND order_created_at = ?
                  AND transaction_type = 'charge' AND status = 'succeeded' ORDER BY id LIMIT 1`, [order.id, order.created_at.toISOString()]);
            if(!charge) throw new Error("the latest order has no succeeded charge");
            const body: Record<string, unknown> = {reason: "test refund"};
            if(rest[0]) body.amount = Number(rest[0]);
            await call("POST", `/payments/${charge.id}/refund`, {token: adminToken(), key: true, body});
            break;
        }
        case "show":
            await show();
            break;
        default:
            console.log("commands: order [online|cod] | init | pay [SUCCESS|FAILURE] [again] | cancel | refund [amount] | show");
    }
}catch(err){
    console.error("error:", (err as Error).message);
}finally{
    await destroyAll();
}
