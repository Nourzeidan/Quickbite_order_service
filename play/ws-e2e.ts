// Realtime check for Phases 1-2: opens customer + restaurant sockets, drives orders/payments over REST,
// and asserts which events each socket received.
//   npx tsx play/ws-e2e.ts          (API running; uses the latest order's customer / branch on eg)
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {io, type Socket} from "socket.io-client";
import {env} from "../src/lib/config/env.js";
import {ensureStock} from "./test-stock.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const base = `http://localhost:${env.port}`;
const conn = db(region);
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)}`); }
};

type Received = {event: string; payload: any};
async function connect(token: string, room: string): Promise<{socket: Socket; got: Received[]}> {
    const got: Received[] = [];
    const socket = io(base, {path: "/ws", auth: {token}, transports: ["websocket"]});
    socket.onAny((event, payload) => { if(event !== "hello" && event !== "subscribed") got.push({event, payload}); });
    await new Promise<void>((resolve, reject) => {
        socket.on("connect_error", reject);
        socket.on("hello", () => socket.emit("subscribe", room, (r: {ok: boolean}) => r.ok ? resolve() : reject(new Error(`subscribe ${room} refused`))));
    });
    return {socket, got};
}

async function rest(method: string, path: string, token: string, body?: unknown) {
    const init: RequestInit = {method, headers: {"Authorization": `Bearer ${token}`, "X-Region": region, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID()}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}/api${path}`, init);
    return {status: res.status, json: await res.json().catch(() => null) as any};
}

async function payWebhook(publicId: string, status: "SUCCESS" | "FAILURE") {
    const {rows: [s]} = await conn.raw(`
        SELECT ps.merchant_order_ref, ps.amount FROM payment_sessions ps JOIN orders o ON o.id = ps.order_id AND o.created_at = ps.order_created_at
        WHERE o.public_id = ?::uuid ORDER BY ps.id DESC LIMIT 1`, [publicId]);
    const data: Record<string, unknown> = {
        merchantOrderId: s.merchant_order_ref, kashierOrderId: `K-WS-${publicId}`, orderReference: "WS", transactionId: `TX-WS-${Date.now()}`,
        status, method: "card", amount: Number(fromMinor(s.amount)), currency: "EGP", transactionResponseCode: "00", channel: "online",
    };
    const keys = Object.keys(data).sort();
    data.signatureKeys = keys;
    await fetch(`${base}/api/payments/webhook/kashier`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "x-kashier-signature": signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret)},
        body: JSON.stringify({event: "pay", data}),
    });
}

const {rows: [tpl]} = await conn.raw(`
    SELECT o.customer_id, o.branch_id, o.restaurant_id, o.customer_address_id,
           (SELECT product_id FROM order_items i WHERE i.order_id = o.id AND i.order_created_at = o.created_at LIMIT 1) AS product_id
    FROM orders o ORDER BY created_at DESC LIMIT 1`);
const customerId = Number(tpl.customer_id), branchId = Number(tpl.branch_id), restaurantId = Number(tpl.restaurant_id);
await ensureStock(Number(tpl.branch_id), Number(tpl.restaurant_id), Number(tpl.product_id));
const customer = tok({userId: customerId, email: "c@t.com", role: "customer"});
const owner = tok({userId: 5000, email: "o@t.com", role: "restaurant_user", restaurantId, restaurantRole: "owner", branchIds: [branchId]});
const body = (paymentMethod: string) => ({branchId, customerAddressId: Number(tpl.customer_address_id), paymentMethod, items: [{productId: Number(tpl.product_id), quantity: 1}]});

const c = await connect(customer, `customer:${customerId}`);
const b = await connect(owner, `branch:${branchId}`);
const r = await connect(owner, `restaurant:${restaurantId}`);
const reset = () => { c.got.length = 0; b.got.length = 0; r.got.length = 0; };
const has = (list: Received[], event: string, publicId: string) => list.some((x) => x.event === event && x.payload?.orderPublicId === publicId || x.event === event && x.payload?.publicId === publicId);

try{
    console.log("\n1. COD order placed -> order.created to branch + restaurant (not the customer)");
    const cod = await rest("POST", "/orders", customer, body("cod"));
    const codId = cod.json.data.publicId;
    await sleep(800);
    check("branch got order.created", has(b.got, "order.created", codId), b.got);
    check("restaurant got order.created", has(r.got, "order.created", codId), r.got);
    check("customer got nothing", c.got.length === 0, c.got);

    console.log("\n2. restaurant accepts -> order.status_changed to customer + branch");
    reset();
    const acc = await rest("PATCH", `/orders/${codId}/status`, tok({userId: 5000, role: "admin"}), {status: "accepted"});
    await sleep(800);
    check("PATCH accepted -> 200", acc.status === 200, acc);
    check("customer got order.status_changed accepted", c.got.some((x) => x.event === "order.status_changed" && x.payload.status === "accepted"), c.got);
    check("branch got order.status_changed accepted", b.got.some((x) => x.event === "order.status_changed" && x.payload.status === "accepted"), b.got);

    console.log("\n3. cancel -> order.cancelled to customer + branch + restaurant");
    reset();
    await rest("PATCH", `/orders/${codId}/status`, tok({userId: 5000, role: "admin"}), {status: "cancelled", reason: "ws test"});
    await sleep(800);
    check("customer got order.cancelled", has(c.got, "order.cancelled", codId), c.got);
    check("branch got order.cancelled", has(b.got, "order.cancelled", codId), b.got);
    check("restaurant got order.cancelled with reason", r.got.some((x) => x.event === "order.cancelled" && x.payload.reason === "ws test"), r.got);

    console.log("\n4. online order: nothing to the restaurant until paid");
    reset();
    const on = await rest("POST", "/orders", customer, body("online"));
    const onId = on.json.data.publicId;
    await rest("POST", "/payments/init", customer, {orderId: onId});
    await sleep(800);
    check("no order.created while pending_payment", !has(b.got, "order.created", onId), b.got);

    console.log("\n5. payment declined -> payment.failed to the customer");
    await payWebhook(onId, "FAILURE");
    await sleep(800);
    check("customer got payment.failed", has(c.got, "payment.failed", onId), c.got);

    console.log("\n6. payment captured -> payment.captured + status_changed (customer), order.created (branch + restaurant)");
    reset();
    await payWebhook(onId, "SUCCESS");
    await sleep(1200);
    check("customer got payment.captured", has(c.got, "payment.captured", onId), c.got);
    check("customer got order.status_changed placed", c.got.some((x) => x.event === "order.status_changed" && x.payload.status === "placed"), c.got);
    check("branch got order.created", has(b.got, "order.created", onId), b.got);
    check("restaurant got order.created", has(r.got, "order.created", onId), r.got);

    console.log("\n7. another customer's room is refused");
    const other = io(base, {path: "/ws", auth: {token: customer}, transports: ["websocket"]});
    const refused = await new Promise<boolean>((resolve) => other.on("hello", () => other.emit("subscribe", `customer:${customerId + 1}`, (res: {ok: boolean}) => resolve(!res.ok))));
    other.close();
    check("subscribe to customer:<other> -> not permitted", refused);
}catch(err){
    failed++;
    console.log("  ERROR", (err as Error).stack);
}finally{
    c.socket.close(); b.socket.close(); r.socket.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    await destroyAll();
}
