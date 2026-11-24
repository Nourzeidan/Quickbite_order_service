// Kashier failure paths end-to-end (payments.md §3, §6; integrations.md §4):
//   - POST /payments/init while Kashier is down / failing / slow / rejecting
//   - POST /payments/:id/refund (admin) while Kashier is down, then Kashier's late webhook
//   - an automatic refund (order rejected) while Kashier is down
//   - the refund sweep's "no outcome" alert, and that it never re-sends
//
// Needs core-service (npm run dev) and Postgres / Redis / RabbitMQ. Your own order-service API and
// worker can keep running: this script starts a FAKE Kashier on a free port and a SECOND API
// (port 4101) and a short-lived worker pointed at it, so the real Kashier sandbox is never called.
//   npx tsx play/kashier-down-e2e.ts        (~1 min)
import crypto from "crypto";
import http from "http";
import path from "path";
import {spawn, type ChildProcess} from "child_process";
import type {AddressInfo} from "net";
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env.js";
import {ensureStock} from "./test-stock.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const API_PORT = 4101;
const base = `http://localhost:${API_PORT}`;
const TIMEOUT_MS = 800;                                  // KASHIER_TIMEOUT_MS of the test API
const conn = db(region);
const run = Date.now();
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)?.slice(0, 600)}`); }
};

// ---------------------------------------------------------------- fake Kashier
// refuse: drop the connection (what "unreachable" looks like to fetch) · hang: never answer (timeout)
// 500 / 400: answer that status · ok: answer like the sandbox
type Mode = "refuse" | "hang" | "500" | "400" | "ok";
let mode: Mode = "ok";
const calls: {method: string; path: string}[] = [];
const fake = http.createServer((req, res) => {
    calls.push({method: req.method ?? "", path: req.url ?? ""});
    req.resume();
    switch(mode){
        case "refuse": req.socket.destroy(); return;
        case "hang": return;                                                   // the client times out
        case "500": res.writeHead(500, {"Content-Type": "application/json"}).end(`{"error":"internal"}`); return;
        case "400": res.writeHead(400, {"Content-Type": "application/json"}).end(`{"error":"bad request"}`); return;
        case "ok": {
            const body = req.method === "POST"
                ? {_id: `fake-session-${run}-${calls.length}`, sessionUrl: `https://fake.kashier.test/session/${calls.length}`}
                : {status: "PENDING", response: {status: "PENDING"}};
            res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify(body));
        }
    }
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
const sessionCalls = () => calls.filter((c) => c.method === "POST" && c.path === "/v3/payment/sessions").length;
const refundCalls = (kashierOrderId?: string) => calls.filter((c) => c.method === "PUT" && c.path.startsWith("/v3/orders/") && (!kashierOrderId || c.path.includes(encodeURIComponent(kashierOrderId)))).length;

// ---------------------------------------------------------------- processes pointed at the fake
const kashierEnv = {KASHIER_BASE_URL: fakeUrl, KASHIER_FEP_BASE_URL: fakeUrl, KASHIER_TIMEOUT_MS: String(TIMEOUT_MS)};
const children: ChildProcess[] = [];
function startProcess(entry: string, extraEnv: Record<string, string>): {child: ChildProcess; lines: () => string[]} {
    // `node --import tsx` = ONE process, so kill() really stops it (the tsx CLI starts a second one)
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
        cwd: path.resolve(import.meta.dirname, ".."), env: {...process.env, ...kashierEnv, ...extraEnv},
    });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    children.push(child);
    return {child, lines: () => output.split(/\r?\n/)};
}
async function stopAll() {
    for(const child of children){
        if(child.exitCode === null){
            child.kill();
            await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 3000); });
        }
    }
    await new Promise((resolve) => fake.close(resolve));
}
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 20_000) {
    const end = Date.now() + ms;
    while(Date.now() < end){ if(await fn()) return true; await sleep(250); }
    return false;
}

async function rest(method: string, path: string, token: string, body?: unknown, key: string = crypto.randomUUID()) {
    const init: RequestInit = {method, headers: {"Authorization": `Bearer ${token}`, "X-Region": region, "Content-Type": "application/json", "Idempotency-Key": key}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const started = Date.now();
    const res = await fetch(`${base}/api${path}`, init);
    return {status: res.status, json: await res.json().catch(() => null) as any, ms: Date.now() - started};
}
async function signedWebhook(event: "pay" | "refund", fields: {merchantOrderId: string; kashierOrderId: string; transactionId: string; amountMinor: number}) {
    const data: Record<string, unknown> = {
        merchantOrderId: fields.merchantOrderId, kashierOrderId: fields.kashierOrderId, orderReference: "KD", transactionId: fields.transactionId,
        status: "SUCCESS", method: "card", amount: env.kashier.webhookAmountUnit === "minor" ? fields.amountMinor : Number(fromMinor(fields.amountMinor)),
        currency: "EGP", transactionResponseCode: "00", channel: "online",
    };
    const keys = Object.keys(data).sort(); data.signatureKeys = keys;
    const res = await fetch(`${base}/api/payments/webhook/kashier`, {method: "POST",
        headers: {"Content-Type": "application/json", "x-kashier-signature": signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret)},
        body: JSON.stringify({event, data})});
    return res.status;
}

try{
    // ------------------------------------------------------------ setup
    console.log(`\nKashier failure paths e2e (run ${run}, fake Kashier at ${fakeUrl})`);
    const api = startProcess("src/server.ts", {PORT: String(API_PORT)});
    const up = await waitFor(async () => (await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0)) === 200);
    if(!up) throw new Error(`test API did not start on ${API_PORT}:\n${api.lines().slice(-20).join("\n")}`);

    const {rows: [tpl]} = await conn.raw(`
        SELECT o.customer_id, o.branch_id, o.restaurant_id, o.customer_address_id,
               (SELECT product_id FROM order_items i WHERE i.order_id = o.id AND i.order_created_at = o.created_at LIMIT 1) AS product_id
        FROM orders o WHERE o.created_at >= '2026-01-01' ORDER BY created_at DESC LIMIT 1`);
    await ensureStock(Number(tpl.branch_id), Number(tpl.restaurant_id), Number(tpl.product_id));
    const customer = tok({userId: Number(tpl.customer_id), email: "c@t.com", role: "customer"});
    const admin = tok({userId: 999, email: "a@t.com", role: "admin"});
    const orderBody = {branchId: Number(tpl.branch_id), customerAddressId: Number(tpl.customer_address_id), paymentMethod: "online", items: [{productId: Number(tpl.product_id), quantity: 1}]};
    const orderRow = async (publicId: string) => (await conn.raw(`SELECT id, created_at, status FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`, [publicId, publicId])).rows[0];
    const sessionsOf = async (publicId: string) => { const o = await orderRow(publicId); return (await conn.raw(`SELECT id, status, merchant_order_ref, amount FROM payment_sessions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [o.id, o.created_at.toISOString()])).rows; };
    const refundRow = async (id: number) => (await conn.raw(`SELECT id, status, provider_requested_at, provider_reference_id, note FROM transactions WHERE id = ?`, [id])).rows[0];

    async function placeOnline(): Promise<string> {
        const placed = await rest("POST", "/orders", customer, orderBody);
        if(placed.status !== 201) throw new Error(`place: ${placed.status} ${JSON.stringify(placed.json)}`);
        return placed.json.data.publicId;
    }
    // init (Kashier ok) + signed pay webhook -> placed, with a charge addressed to kashierOrderId
    async function placePaid(): Promise<{publicId: string; kashierOrderId: string; merchantRef: string; chargeId: number}> {
        const publicId = await placeOnline();
        mode = "ok";
        const init = await rest("POST", "/payments/init", customer, {orderId: publicId});
        if(init.status >= 300) throw new Error(`init: ${init.status} ${JSON.stringify(init.json)}`);
        const [session] = await sessionsOf(publicId);
        const kashierOrderId = `K-KD-${run}-${publicId}`;
        const code = await signedWebhook("pay", {merchantOrderId: session.merchant_order_ref, kashierOrderId, transactionId: `TX-KD-${run}-${publicId}`, amountMinor: session.amount});
        const o = await orderRow(publicId);
        const {rows: [charge]} = await conn.raw(`SELECT id FROM transactions WHERE order_id = ? AND order_created_at = ? AND transaction_type = 'charge' AND status = 'succeeded'`, [o.id, o.created_at.toISOString()]);
        if(code !== 200 || o.status !== "placed" || !charge) throw new Error(`pay webhook: ${code} ${o.status}`);
        return {publicId, kashierOrderId, merchantRef: session.merchant_order_ref, chargeId: Number(charge.id)};
    }

    // ------------------------------------------------------------ A. init
    console.log("\nA. POST /payments/init while Kashier fails");
    const pending = await placeOnline();
    const initKey = crypto.randomUUID();

    mode = "refuse"; let before = sessionCalls();
    let r = await rest("POST", "/payments/init", customer, {orderId: pending}, initKey);
    check("unreachable -> 503 Payment provider unavailable", r.status === 503 && r.json?.error === "Payment provider unavailable", r);
    check("… tried 3 times (network errors are retried)", sessionCalls() - before === 3, sessionCalls() - before);
    check("… order still pending_payment, no session stored", (await orderRow(pending)).status === "pending_payment" && (await sessionsOf(pending)).length === 0);

    mode = "500"; before = sessionCalls();
    r = await rest("POST", "/payments/init", customer, {orderId: pending});
    check("Kashier 500 -> 503, tried 3 times", r.status === 503 && sessionCalls() - before === 3, {status: r.status, tries: sessionCalls() - before});

    mode = "hang"; before = sessionCalls();
    r = await rest("POST", "/payments/init", customer, {orderId: pending});
    check(`Kashier never answers -> 503 after 3 timeouts of ${TIMEOUT_MS} ms`, r.status === 503 && sessionCalls() - before === 3 && r.ms >= 3 * TIMEOUT_MS, {status: r.status, tries: sessionCalls() - before, ms: r.ms});

    mode = "400"; before = sessionCalls();
    r = await rest("POST", "/payments/init", customer, {orderId: pending});
    check("Kashier 400 -> 502 Payment provider rejected the request, NOT retried", r.status === 502 && r.json?.error === "Payment provider rejected the request" && sessionCalls() - before === 1, {status: r.status, error: r.json?.error, tries: sessionCalls() - before});
    check("… still no session stored", (await sessionsOf(pending)).length === 0);

    mode = "ok"; before = sessionCalls();
    r = await rest("POST", "/payments/init", customer, {orderId: pending}, initKey);
    check("Kashier back: the SAME Idempotency-Key works (a 503 is never stored as the answer)", r.status === 200 && typeof r.json?.data?.redirectUrl === "string" && sessionCalls() - before === 1, {status: r.status, tries: sessionCalls() - before});
    check("… one initialized session stored", (await sessionsOf(pending)).length === 1);

    // ------------------------------------------------------------ B. admin refund
    console.log("\nB. admin refund while Kashier is unreachable");
    const paid = await placePaid();
    const refundKey = crypto.randomUUID();
    mode = "refuse"; before = refundCalls(paid.kashierOrderId);
    r = await rest("POST", `/payments/${paid.chargeId}/refund`, admin, {amount: 100, reason: "kashier down test"}, refundKey);
    check("unreachable -> 503 to the admin", r.status === 503 && r.json?.error === "Payment provider unavailable", r);
    check("… Kashier called exactly once (a refund is never retried: it may have gone through)", refundCalls(paid.kashierOrderId) - before === 1, refundCalls(paid.kashierOrderId) - before);
    const {rows: [reserved]} = await conn.raw(`SELECT id FROM transactions WHERE refunded_payment_id = ? AND transaction_type = 'refund' ORDER BY id DESC LIMIT 1`, [paid.chargeId]);
    let row = await refundRow(Number(reserved.id));
    check("… refund row stays PENDING (outcome unknown), marked as sent, no provider id", row.status === "pending" && row.provider_requested_at !== null && row.provider_reference_id === null, row);

    mode = "ok"; before = refundCalls(paid.kashierOrderId);
    r = await rest("POST", `/payments/${paid.chargeId}/refund`, admin, {amount: 100, reason: "kashier down test"}, refundKey);
    check("admin retries with the same Idempotency-Key -> 202, the same refund, NOT sent again", r.status === 202 && r.json?.data?.refundId === Number(reserved.id) && r.json?.data?.status === "pending" && refundCalls(paid.kashierOrderId) === before, {status: r.status, data: r.json?.data, sent: refundCalls(paid.kashierOrderId) - before});

    const code = await signedWebhook("refund", {merchantOrderId: paid.merchantRef, kashierOrderId: paid.kashierOrderId, transactionId: `RF-KD-${run}`, amountMinor: 100});
    row = await refundRow(Number(reserved.id));
    check("Kashier had refunded after all: its webhook settles the pending refund (matched by charge + amount)", code === 200 && row.status === "succeeded" && row.provider_reference_id === `RF-KD-${run}`, {code, row});

    mode = "400"; before = refundCalls(paid.kashierOrderId);
    r = await rest("POST", `/payments/${paid.chargeId}/refund`, admin, {amount: 50, reason: "kashier rejects"});
    const {rows: [rejected]} = await conn.raw(`SELECT id, status, note FROM transactions WHERE refunded_payment_id = ? AND transaction_type = 'refund' ORDER BY id DESC LIMIT 1`, [paid.chargeId]);
    check("Kashier 400 on a refund -> 502, row FAILED with the reason, sent once", r.status === 502 && rejected.status === "failed" && String(rejected.note).includes("provider error") && refundCalls(paid.kashierOrderId) - before === 1, {status: r.status, rejected, sent: refundCalls(paid.kashierOrderId) - before});

    // ------------------------------------------------------------ C. automatic refund
    console.log("\nC. order rejected while Kashier is unreachable (automatic refund)");
    const auto = await placePaid();
    mode = "refuse"; before = refundCalls(auto.kashierOrderId);
    r = await rest("PATCH", `/orders/${auto.publicId}/status`, admin, {status: "rejected", reason: "kashier down test"});
    check("reject still succeeds (the refund is reserved in the same trx, sent after commit)", r.status === 200 && (await orderRow(auto.publicId)).status === "rejected", r);
    // the PATCH doesn't wait for Kashier (order-status.service.ts: `void sendQueued`): wait for that one call
    await waitFor(() => refundCalls(auto.kashierOrderId) - before >= 1, 10_000);
    await sleep(500);                                    // let the failed send finish writing its outcome
    const {rows: [autoRefund]} = await conn.raw(`SELECT id, status, provider_requested_at FROM transactions WHERE refunded_payment_id = ? AND transaction_type = 'refund'`, [auto.chargeId]);
    check("… full refund row PENDING and marked as sent; Kashier called once, after the response", autoRefund?.status === "pending" && autoRefund.provider_requested_at !== null && refundCalls(auto.kashierOrderId) - before === 1, {autoRefund, sent: refundCalls(auto.kashierOrderId) - before});

    // ------------------------------------------------------------ D. the sweep
    console.log("\nD. refund sweep: alert, never re-send");
    const sentBeforeSweep = refundCalls(auto.kashierOrderId);
    // REFUND_STALE_ALERT_MIN=0: "stale" right away instead of after 60 min
    const worker = startProcess("src/worker.ts", {REFUND_STALE_ALERT_MIN: "0"});
    const alertLine = () => worker.lines().find((line) => line.includes("ALERT refund has no outcome from the provider") && line.includes(`"refundId":${autoRefund.id}`));
    const alerted = await waitFor(() => alertLine() !== undefined, 30_000);
    check("sweep logs 'ALERT refund has no outcome from the provider' for the unknown refund", alerted, worker.lines().filter((l) => l.includes("ALERT")).slice(-3));
    check("… and does NOT send it again (a human checks the Kashier dashboard)", refundCalls(auto.kashierOrderId) === sentBeforeSweep && (await refundRow(Number(autoRefund.id))).status === "pending", refundCalls(auto.kashierOrderId) - sentBeforeSweep);

    // cleanup: settle it like Kashier would, so your real worker doesn't alert on it every minute
    const {rows: [autoSession]} = await conn.raw(`SELECT ps.merchant_order_ref FROM payment_sessions ps JOIN orders o ON o.id = ps.order_id AND o.created_at = ps.order_created_at WHERE o.public_id = ?::uuid LIMIT 1`, [auto.publicId]);
    const {rows: [autoAmount]} = await conn.raw(`SELECT amount FROM transactions WHERE id = ?`, [autoRefund.id]);
    await signedWebhook("refund", {merchantOrderId: autoSession.merchant_order_ref, kashierOrderId: auto.kashierOrderId, transactionId: `RF-KD-auto-${run}`, amountMinor: autoAmount.amount});
    check("cleanup: Kashier's webhook settles the automatic refund", (await refundRow(Number(autoRefund.id))).status === "succeeded");
}catch(err){
    failed++;
    console.log(`  ERROR ${(err as Error).stack ?? err}`);
}finally{
    await stopAll();
    console.log(`\n${passed} passed, ${failed} failed`);
    await destroyAll();
    process.exit(failed === 0 ? 0 : 1);
}
