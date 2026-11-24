// Run: npx tsx play/phase2-e2e.ts   (API running on localhost; places test orders on eg; ~2 min because of the sweep step)
// Phase 2 end-to-end checks against the running API (localhost) + real Kashier sandbox for sessions.
// Card payments are simulated with signed webhooks (same signing as Kashier).
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env.js";
import {ensureStock} from "./test-stock.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const run = Date.now();          // unique transaction ids per run (webhook dedupe is permanent)
const base = `http://localhost:${env.port}/api`;
const conn = db(region);
let passed = 0, failed = 0;

function check(name: string, ok: boolean, detail: unknown = "") {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const admin = tok({userId: 999, email: "a@test.com", role: "admin"});

async function call(method: string, path: string, o: {token: string; body?: unknown; key?: string | null}) {
    const headers: Record<string, string> = {"Authorization": `Bearer ${o.token}`, "X-Region": region, "Content-Type": "application/json"};
    if(o.key !== null) headers["Idempotency-Key"] = o.key ?? crypto.randomUUID();
    const init: RequestInit = {method, headers};
    if(o.body !== undefined) init.body = JSON.stringify(o.body);
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json: any = null; try{ json = JSON.parse(text); }catch{}
    return {status: res.status, json, text};
}

async function webhook(o: {ref: string; amount: number; status?: string; tx: string; kashierOrderId: string; event?: string; currency?: string; badsig?: boolean}) {
    const data: Record<string, unknown> = {
        merchantOrderId: o.ref, kashierOrderId: o.kashierOrderId, orderReference: `T-${Date.now()}`,
        transactionId: o.tx, status: o.status ?? "SUCCESS", method: "card",
        amount: env.kashier.webhookAmountUnit === "minor" ? o.amount : Number(fromMinor(o.amount)),
        currency: o.currency ?? "EGP", transactionResponseCode: "00", channel: "online | e-commerce",
    };
    const keys = ["amount", "channel", "currency", "kashierOrderId", "merchantOrderId", "method", "orderReference", "status", "transactionId", "transactionResponseCode"];
    data.signatureKeys = keys;
    const sig = o.badsig ? "0".repeat(64) : signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret);
    const res = await fetch(`${base}/payments/webhook/kashier`, {
        method: "POST", headers: {"Content-Type": "application/json", "x-kashier-signature": sig},
        body: JSON.stringify({event: o.event ?? "pay", data}),
    });
    const text = await res.text(); let json: any = null; try{ json = JSON.parse(text); }catch{}
    return {status: res.status, json, text};
}

async function orderRow(publicId: string) {
    const {rows: [o]} = await conn.raw(`SELECT * FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`, [publicId, publicId]);
    return o;
}
async function sessions(o: any) {
    return (await conn.raw(`SELECT * FROM payment_sessions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [o.id, o.created_at.toISOString()])).rows;
}
async function ledger(o: any) {
    return (await conn.raw(`SELECT * FROM transactions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [o.id, o.created_at.toISOString()])).rows;
}
async function eventCount() {
    return Number((await conn.raw(`SELECT count(*)::int AS n FROM payment_webhook_events`)).rows[0].n);
}

// template from the latest order (customer / branch / address / product)
const {rows: [tpl]} = await conn.raw(`SELECT o.*, (SELECT product_id FROM order_items i WHERE i.order_id=o.id AND i.order_created_at=o.created_at LIMIT 1) AS product_id FROM orders o ORDER BY created_at DESC LIMIT 1`);
const customerId = Number(tpl.customer_id);
await ensureStock(Number(tpl.branch_id), Number(tpl.restaurant_id), Number(tpl.product_id));
const customer = tok({userId: customerId, email: "c@test.com", role: "customer"});
const otherCustomer = tok({userId: customerId + 1000, email: "o@test.com", role: "customer"});
const orderBody = (method: string) => ({branchId: Number(tpl.branch_id), customerAddressId: Number(tpl.customer_address_id), paymentMethod: method, items: [{productId: Number(tpl.product_id), quantity: 1}]});

try{
    // ---------------------------------------------------------------- A. online order + init
    console.log("\nA. online order + POST /payments/init (real Kashier)");
    const placed = await call("POST", "/orders", {token: customer, body: orderBody("online")});
    check("order placed as pending_payment", placed.status === 201 && placed.json?.data?.status === "pending_payment", placed.text);
    const publicId: string = placed.json.data.publicId;
    const total: number = placed.json.data.total;
    console.log(`        order ${publicId}, total ${total}`);

    const initKey = crypto.randomUUID();
    const init1 = await call("POST", "/payments/init", {token: customer, body: {orderId: publicId}, key: initKey});
    check("init -> 200 with a Kashier redirectUrl", init1.status === 200 && /^https:\/\/payments\.kashier\.io\/session\//.test(init1.json?.data?.redirectUrl ?? ""), init1.text);
    const init2 = await call("POST", "/payments/init", {token: customer, body: {orderId: publicId}});
    check("init again (new key) -> same session", init2.status === 200 && init2.json?.data?.sessionId === init1.json?.data?.sessionId, init2.text);
    const init3 = await call("POST", "/payments/init", {token: customer, body: {orderId: publicId}, key: initKey});
    check("init with the same key -> replayed", init3.status === 200 && init3.json?.data?.sessionId === init1.json?.data?.sessionId, init3.text);
    const init4 = await call("POST", "/payments/init", {token: customer, body: {orderId: crypto.randomUUID()}, key: initKey});
    check("same key + different body -> 409", init4.status === 409, init4.text);
    const init5 = await call("POST", "/payments/init", {token: otherCustomer, body: {orderId: publicId}});
    check("another customer -> 404 Order not found", init5.status === 404, init5.text);
    const init6 = await call("POST", "/payments/init", {token: customer, body: {orderId: publicId}, key: null});
    check("no Idempotency-Key -> 400", init6.status === 400, init6.text);

    let o = await orderRow(publicId);
    const [s1] = await sessions(o);
    check("one session, initialized, amount = total", s1 && s1.status === "initialized" && s1.amount === total && s1.merchant_order_ref === `eg_${publicId}`, s1);

    // ---------------------------------------------------------------- B. webhooks
    console.log("\nB. webhooks");
    const ref = s1.merchant_order_ref;
    const kOrder = `K-E2E-${publicId}`;
    const before = await eventCount();
    const bad = await webhook({ref, amount: total, tx: `TX-E2E-BAD-${run}`, kashierOrderId: kOrder, badsig: true});
    check("bad signature -> 401, nothing stored", bad.status === 401 && await eventCount() === before, bad.text);

    const mismatch = await webhook({ref, amount: total + 1, tx: `TX-E2E-MISMATCH-${run}`, kashierOrderId: kOrder});
    o = await orderRow(publicId);
    const {rows: [mm]} = await conn.raw(`SELECT process_error, processed_at FROM payment_webhook_events WHERE provider_event_id = ?`, [`pay:TX-E2E-MISMATCH-${run}:SUCCESS`]);
    check("amount mismatch -> 200, stored with note, order unchanged", mismatch.status === 200 && mm?.process_error === "amount or currency mismatch" && o.status === "pending_payment", {mismatch: mismatch.text, mm});

    const fail = await webhook({ref, amount: total, status: "FAILURE", tx: `TX-E2E-FAIL-${run}`, kashierOrderId: kOrder});
    o = await orderRow(publicId);
    let l = await ledger(o);
    check("FAILURE -> session failed, failed charge, order still pending_payment",
        fail.status === 200 && (await sessions(o))[0].status === "failed" && l.some((t: any) => t.transaction_type === "charge" && t.status === "failed") && o.status === "pending_payment", {fail: fail.text, l});

    const ok = await webhook({ref, amount: total, tx: `TX-E2E-OK-${run}`, kashierOrderId: kOrder});
    o = await orderRow(publicId);
    l = await ledger(o);
    const charge = l.find((t: any) => t.transaction_type === "charge" && t.status === "succeeded");
    check("SUCCESS -> order placed", ok.status === 200 && o.status === "placed", {ok: ok.text, status: o.status});
    check("SUCCESS -> session captured", (await sessions(o))[0].status === "captured");
    check("SUCCESS -> charge succeeded, customer -> platform, ref = kashierOrderId",
        charge && charge.amount === total && Number(charge.src_acc_id) === customerId && charge.dst_acc_id === null && charge.provider_reference_id === kOrder, charge);

    const rowsBefore = l.length;
    const dup = await webhook({ref, amount: total, tx: `TX-E2E-OK-${run}`, kashierOrderId: kOrder});
    check("same webhook again -> 200 duplicate, no new rows", dup.status === 200 && dup.json?.data?.result === "duplicate" && (await ledger(o)).length === rowsBefore, dup.text);
    const cap = await webhook({ref, amount: total, tx: `TX-E2E-OK-${run}`, kashierOrderId: kOrder, event: "capture"});
    const afterCap = await ledger(o);
    check("capture for the same transaction -> no 2nd charge, no refund", cap.status === 200 && afterCap.length === rowsBefore, {cap: cap.text, rows: afterCap.length});

    const detail = await call("GET", `/orders/${publicId}`, {token: customer, key: null});
    check("order detail paymentSummary = succeeded", detail.json?.data?.paymentSummary?.status === "succeeded", detail.json?.data?.paymentSummary);

    const notPending = await call("POST", "/payments/init", {token: customer, body: {orderId: publicId}});
    check("init on a placed order -> 409 Order is not pending payment", notPending.status === 409, notPending.text);

    // ---------------------------------------------------------------- C. reads + refunds
    console.log("\nC. GET /payments/:id + refunds (Kashier rejects the fake kashierOrderId, as expected)");
    const get = await call("GET", `/payments/${charge.id}`, {token: admin, key: null});
    check("GET /payments/:id (admin) -> PaymentResponseDTO", get.status === 200 && get.json?.data?.orderPublicId === publicId && get.json?.data?.provider === "kashier", get.text);
    const getCust = await call("GET", `/payments/${charge.id}`, {token: customer, key: null});
    check("GET /payments/:id (customer) -> 403", getCust.status === 403, getCust.text);
    const over = await call("POST", `/payments/${charge.id}/refund`, {token: admin, body: {amount: total + 1, reason: "e2e"}});
    check("refund more than the charge -> 409", over.status === 409, over.text);
    const custRefund = await call("POST", `/payments/${charge.id}/refund`, {token: customer, body: {reason: "e2e"}});
    check("refund as customer -> 403", custRefund.status === 403, custRefund.text);
    const refundKey = crypto.randomUUID();
    const r1 = await call("POST", `/payments/${charge.id}/refund`, {token: admin, body: {amount: 100, reason: "e2e partial"}, key: refundKey});
    l = await ledger(o);
    const refundRow = l.find((t: any) => t.transaction_type === "refund");
    check("admin refund reaches Kashier; fake order id -> 502, refund row failed + sent",
        r1.status === 502 && refundRow?.status === "failed" && refundRow?.provider_requested_at !== null, {r1: r1.text, refundRow});

    // ---------------------------------------------------------------- D. cancel paid order -> auto refund
    console.log("\nD. cancel a paid online order -> automatic refund reserved + sent");
    const placed2 = await call("POST", "/orders", {token: customer, body: orderBody("online")});
    const pid2: string = placed2.json.data.publicId;
    await call("POST", "/payments/init", {token: customer, body: {orderId: pid2}});
    let o2 = await orderRow(pid2);
    const [s2] = await sessions(o2);
    await webhook({ref: s2.merchant_order_ref, amount: placed2.json.data.total, tx: `TX-E2E-D-${Date.now()}`, kashierOrderId: `K-E2E-${pid2}`});
    o2 = await orderRow(pid2);
    check("second order paid -> placed", o2.status === "placed", o2.status);
    const cancel = await call("PATCH", `/orders/${pid2}/status`, {token: customer, body: {status: "cancelled", reason: "e2e"}});
    await sleep(2500);
    const l2 = await ledger(o2);
    const auto = l2.find((t: any) => t.transaction_type === "refund");
    check("customer cancel within 60 s -> cancelled", cancel.status === 200 && cancel.json?.data?.status === "cancelled", cancel.text);
    check("auto refund row: full amount, key auto-refund:charge:<id>, sent to Kashier",
        auto && auto.amount === placed2.json.data.total && /^auto-refund:charge:\d+$/.test(auto.idempotency_key) && auto.provider_requested_at !== null, auto);

    // ---------------------------------------------------------------- E. late capture
    console.log("\nE. payment arrives after the order was cancelled");
    const placed3 = await call("POST", "/orders", {token: customer, body: orderBody("online")});
    const pid3: string = placed3.json.data.publicId;
    await call("POST", "/payments/init", {token: customer, body: {orderId: pid3}});
    let o3 = await orderRow(pid3);
    const [s3] = await sessions(o3);
    const c3 = await call("PATCH", `/orders/${pid3}/status`, {token: customer, body: {status: "cancelled"}});
    check("cancel unpaid order -> cancelled, session cancelled", c3.status === 200 && (await sessions(o3))[0].status === "cancelled", c3.text);
    await webhook({ref: s3.merchant_order_ref, amount: placed3.json.data.total, tx: `TX-E2E-E-${Date.now()}`, kashierOrderId: `K-E2E-${pid3}`});
    await sleep(1500);
    o3 = await orderRow(pid3);
    const l3 = await ledger(o3);
    check("late success -> order stays cancelled", o3.status === "cancelled", o3.status);
    check("late success -> charge succeeded + auto refund reserved and sent",
        l3.some((t: any) => t.transaction_type === "charge" && t.status === "succeeded") &&
        l3.some((t: any) => t.transaction_type === "refund" && t.provider_requested_at !== null), l3.map((t: any) => [t.transaction_type, t.status, t.provider_requested_at !== null]));

    // ---------------------------------------------------------------- F. refund sweep picks up a never-sent refund
    console.log("\nF. refund sweep sends a refund that was reserved but never sent (simulated crash)");
    const lateRefund = l3.find((t: any) => t.transaction_type === "refund");
    await conn.raw(`UPDATE transactions SET status = 'pending', provider_requested_at = NULL, created_at = NOW() - interval '1 minute' WHERE id = ?`, [lateRefund.id]);
    let swept: any = null;
    for(let i = 0; i < 18; i++){                    // sweep runs every PAYMENT_SWEEP_INTERVAL_SEC (60 s)
        await sleep(5000);
        swept = (await conn.raw(`SELECT status, provider_requested_at FROM transactions WHERE id = ?`, [lateRefund.id])).rows[0];
        if(swept.provider_requested_at !== null) break;
    }
    check("sweep claimed and sent the queued refund", swept?.provider_requested_at !== null, swept);

    // ---------------------------------------------------------------- G. COD
    console.log("\nG. COD ledger");
    const cod = await call("POST", "/orders", {token: customer, body: orderBody("cod")});
    const pid4: string = cod.json.data.publicId;
    let o4 = await orderRow(pid4);
    let l4 = await ledger(o4);
    check("COD order -> cod_collection pending, customer -> restaurant owner",
        l4.length === 1 && l4[0].transaction_type === "cod_collection" && l4[0].status === "pending" && l4[0].dst_acc_id !== null, l4);
    await call("PATCH", `/orders/${pid4}/status`, {token: customer, body: {status: "cancelled"}});
    l4 = await ledger(o4);
    check("COD cancel -> cod_collection failed + 0-amount adjustment",
        l4.some((t: any) => t.transaction_type === "cod_collection" && t.status === "failed") &&
        l4.some((t: any) => t.transaction_type === "adjustment" && t.amount === 0), l4.map((t: any) => [t.transaction_type, t.status, t.amount]));
}catch(err){
    failed++;
    console.log("  ERROR", (err as Error).stack);
}finally{
    console.log(`\n${passed} passed, ${failed} failed`);
    await destroyAll();
}
