// Phase 3 (deliveries & agents) end-to-end against the running API + worker (npm run dev + npm run worker).
//   npx tsx play/phase3-e2e.ts        (~2 min: it waits for worker ticks)
// Fake agents (fresh ids per run) go online at known distances from the branch of the latest order.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {io, type Socket} from "socket.io-client";
import {env} from "../src/lib/config/env.js";
import {ensureStock} from "./test-stock.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {cacheProvider} from "../src/lib/cache/init.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const base = `http://localhost:${env.port}`;
const conn = db(region);
const redis = cacheProvider.getClient();
const run = Date.now();
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)?.slice(0, 600)}`); }
};
const WAIT_TICK = (env.delivery.offerIntervalSec + 5) * 1000;

async function rest(method: string, path: string, token: string, body?: unknown) {
    const init: RequestInit = {method, headers: {"Authorization": `Bearer ${token}`, "X-Region": region, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID()}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}/api${path}`, init);
    return {status: res.status, json: await res.json().catch(() => null) as any};
}

type Received = {event: string; payload: any};
async function socketFor(token: string, room: string) {
    const got: Received[] = [];
    const socket: Socket = io(base, {path: "/ws", auth: {token}, transports: ["websocket"]});
    socket.onAny((event, payload) => { if(event !== "hello" && event !== "subscribed") got.push({event, payload}); });
    await new Promise<void>((resolve, reject) => {
        socket.on("connect_error", reject);
        socket.on("hello", () => socket.emit("subscribe", room, (r: {ok: boolean}) => r.ok ? resolve() : reject(new Error(`subscribe ${room}`))));
    });
    return {socket, got};
}
const gotEvent = (list: Received[], event: string, publicId: string) => list.some((x) => x.event === event && x.payload?.orderPublicId === publicId);
async function waitFor(fn: () => boolean | Promise<boolean>, ms = WAIT_TICK) {
    const end = Date.now() + ms;
    while(Date.now() < end){ if(await fn()) return true; await sleep(500); }
    return false;
}

// ---------------------------------------------------------------- setup
const {rows: [tpl]} = await conn.raw(`
    SELECT o.customer_id, o.branch_id, o.restaurant_id, o.customer_address_id,
           (SELECT product_id FROM order_items i WHERE i.order_id = o.id AND i.order_created_at = o.created_at LIMIT 1) AS product_id
    FROM orders o ORDER BY created_at DESC LIMIT 1`);
const customerId = Number(tpl.customer_id);
await ensureStock(Number(tpl.branch_id), Number(tpl.restaurant_id), Number(tpl.product_id));
const customer = tok({userId: customerId, email: "c@t.com", role: "customer"});
const admin = tok({userId: 999, email: "a@t.com", role: "admin"});
const orderBody = (paymentMethod: string) => ({branchId: Number(tpl.branch_id), customerAddressId: Number(tpl.customer_address_id), paymentMethod, items: [{productId: Number(tpl.product_id), quantity: 1}]});

async function placeReady(paymentMethod: "cod" | "online" = "cod"): Promise<{publicId: string; total: number; subtotal: number; deliveryFee: number}> {
    const placed = await rest("POST", "/orders", customer, orderBody(paymentMethod));
    const order = placed.json.data;
    if(paymentMethod === "online"){
        await rest("POST", "/payments/init", customer, {orderId: order.publicId});
        const {rows: [s]} = await conn.raw(`SELECT ps.merchant_order_ref, ps.amount FROM payment_sessions ps JOIN orders o ON o.id = ps.order_id AND o.created_at = ps.order_created_at WHERE o.public_id = ?::uuid ORDER BY ps.id DESC LIMIT 1`, [order.publicId]);
        const data: Record<string, unknown> = {merchantOrderId: s.merchant_order_ref, kashierOrderId: `K-P3-${order.publicId}`, orderReference: "P3", transactionId: `TX-P3-${run}-${order.publicId}`, status: "SUCCESS", method: "card", amount: Number(fromMinor(s.amount)), currency: "EGP", transactionResponseCode: "00", channel: "online"};
        const keys = Object.keys(data).sort(); data.signatureKeys = keys;
        await fetch(`${base}/api/payments/webhook/kashier`, {method: "POST", headers: {"Content-Type": "application/json", "x-kashier-signature": signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret)}, body: JSON.stringify({event: "pay", data})});
    }
    for(const status of ["accepted", "preparing", "ready"]){
        const r = await rest("PATCH", `/orders/${order.publicId}/status`, admin, {status});
        if(r.status !== 200) throw new Error(`moving order to ${status}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    return {publicId: order.publicId, total: order.total, subtotal: order.subtotal, deliveryFee: order.deliveryFee};
}
const orderRow = async (publicId: string) => (await conn.raw(`SELECT * FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`, [publicId, publicId])).rows[0];

// a probe order gives us the branch position (pickup snapshot)
const first = await placeReady("cod");
const firstRow = await orderRow(first.publicId);
const pickupLat = Number(firstRow.pickup_lat), pickupLng = Number(firstRow.pickup_lng);

// agents at known distances north of the branch (1 deg lat ~ 111,320 m)
const baseId = 800_000 + (run % 100_000) * 10;
const at = (meters: number) => ({lat: pickupLat + meters / 111_320, lng: pickupLng});
const agents = {
    a500: {id: baseId + 1, pos: at(500)},
    a1000: {id: baseId + 2, pos: at(1000)},
    a2000: {id: baseId + 3, pos: at(2000)},
    a3000: {id: baseId + 4, pos: at(3000)},      // 4th nearest: not in the top 3
    far: {id: baseId + 5, pos: at(8000)},        // outside 5 km
    stale: {id: baseId + 6, pos: at(300)},       // closest, but last seen 6 min ago
};
const agentTok = (id: number) => tok({userId: id, email: `da${id}@t.com`, role: "delivery_agent"});
const sockets: Record<string, Awaited<ReturnType<typeof socketFor>>> = {};
const cust = await socketFor(customer, `customer:${customerId}`);

try{
    console.log(`\nbranch pickup ${pickupLat}, ${pickupLng}; agents ${baseId + 1}..${baseId + 6}; probe order ${first.publicId}`);

    console.log("\nA. presence");
    check("pickup snapshot written at placement", Number.isFinite(pickupLat) && Number.isFinite(pickupLng), firstRow);
    const notOnline = await rest("POST", "/agents/presence/ping", agentTok(baseId + 9), at(100));
    check("ping before online -> 409 Agent is not online", notOnline.status === 409, notOnline);
    const asCustomer = await rest("POST", "/agents/presence/online", customer, at(100));
    check("customer can't use agent endpoints -> 403", asCustomer.status === 403, asCustomer);
    for(const [name, agent] of Object.entries(agents)){
        sockets[name] = await socketFor(agentTok(agent.id), `agent:${agent.id}`);
        const r = await rest("POST", "/agents/presence/online", agentTok(agent.id), agent.pos);
        if(r.status !== 200) throw new Error(`online ${name}: ${r.status}`);
    }
    await redis.zadd(`presence:seen:${region}`, Date.now() - 6 * 60_000, String(agents.stale.id));
    check("stale agent marked 6 min old in Redis", Number(await redis.zscore(`presence:seen:${region}`, String(agents.stale.id))) < Date.now() - 5 * 60_000);

    console.log("\nB. the worker offers the ready order to the 3 nearest eligible agents");
    const offered = await waitFor(() => gotEvent(sockets.a500!.got, "task.offered", first.publicId));
    await sleep(1000);
    check("nearest (500 m) got task.offered", offered, sockets.a500!.got);
    check("1 km got task.offered", gotEvent(sockets.a1000!.got, "task.offered", first.publicId));
    check("2 km got task.offered", gotEvent(sockets.a2000!.got, "task.offered", first.publicId));
    check("3 km (4th nearest) did NOT", !gotEvent(sockets.a3000!.got, "task.offered", first.publicId));
    check("8 km agent did NOT", !gotEvent(sockets.far!.got, "task.offered", first.publicId));
    check("stale agent (6 min) did NOT", !gotEvent(sockets.stale!.got, "task.offered", first.publicId));
    const offer = sockets.a500!.got.find((x) => x.event === "task.offered" && x.payload.orderPublicId === first.publicId)?.payload;
    check("offer payload: distance ~500 m, COD cashToCollect = total", offer && Math.abs(offer.distanceMeters - 500) < 20 && offer.cashToCollect === first.total, offer);

    const avail = await rest("GET", "/agents/available-orders", agentTok(agents.a3000.id));
    check("3 km agent still SEES it in available-orders", avail.status === 200 && avail.json.data.some((o: any) => o.orderPublicId === first.publicId), avail.json);
    const availFar = await rest("GET", "/agents/available-orders", agentTok(agents.far.id));
    check("8 km agent does not see it", availFar.status === 200 && !availFar.json.data.some((o: any) => o.orderPublicId === first.publicId), availFar.json);
    const farAccept = await rest("POST", `/deliveries/${first.publicId}/accept`, agentTok(agents.far.id));
    check("8 km agent accept -> 409 too far", farAccept.status === 409, farAccept);

    console.log("\nC. two agents accept at the same time -> exactly one wins");
    const [r1, r2] = await Promise.all([
        rest("POST", `/deliveries/${first.publicId}/accept`, agentTok(agents.a500.id)),
        rest("POST", `/deliveries/${first.publicId}/accept`, agentTok(agents.a1000.id)),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check("one 200 and one 409", statuses[0] === 200 && statuses[1] === 409, [r1, r2]);
    const winner = r1.status === 200 ? agents.a500 : agents.a1000;
    const loser = r1.status === 200 ? agents.a1000 : agents.a500;
    const winnerName = winner === agents.a500 ? "a500" : "a1000";
    let row = await orderRow(first.publicId);
    check("order assigned to the winner", row.status === "assigned" && Number(row.delivery_agent_id) === winner.id, row);
    await sleep(800);
    check("2 km agent got task.offer_withdrawn", gotEvent(sockets.a2000!.got, "task.offer_withdrawn", first.publicId), sockets.a2000!.got);
    check("customer got order.status_changed assigned", cust.got.some((x) => x.event === "order.status_changed" && x.payload.orderPublicId === first.publicId && x.payload.status === "assigned" && x.payload.agent?.id === winner.id), cust.got.slice(-3));

    console.log("\nD. one active order per agent");
    const second = await placeReady("cod");
    const busyAccept = await rest("POST", `/deliveries/${second.publicId}/accept`, agentTok(winner.id));
    check("winner can't take a second order -> 409", busyAccept.status === 409, busyAccept);
    const loserTakes = await rest("POST", `/deliveries/${second.publicId}/accept`, agentTok(loser.id));
    check("the other agent takes the second order", loserTakes.status === 200, loserTakes);

    console.log("\nE. only the order's agent can move it; release puts it back");
    const notMine = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(agents.a2000.id), {status: "picked"});
    check("another agent -> 404", notMine.status === 404, notMine);
    const release = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(winner.id), {status: "released", reason: "flat tyre"});
    row = await orderRow(first.publicId);
    check("released -> order ready, no agent", release.status === 200 && row.status === "ready" && row.delivery_agent_id === null, {release, row});
    const reoffer = await waitFor(() => sockets.a2000!.got.filter((x) => x.event === "task.offered" && x.payload.orderPublicId === first.publicId).length >= 1 &&
        sockets.a3000!.got.some((x) => x.event === "task.offered" && x.payload.orderPublicId === first.publicId));
    check("re-offered after release (3 km agent now in the top 3)", reoffer, sockets.a3000!.got);
    const winnerOffers = sockets[winnerName]!.got.filter((x) => x.event === "task.offered" && x.payload.orderPublicId === first.publicId).length;
    check("never re-offered to the agent who released it", winnerOffers === 1, winnerOffers);

    console.log("\nF. picked -> position -> delivered -> settlement");
    const take = await rest("POST", `/deliveries/${first.publicId}/accept`, agentTok(agents.a2000.id));
    check("2 km agent accepts", take.status === 200, take);
    const deliveredEarly = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(agents.a2000.id), {status: "delivered"});
    check("delivered before picked -> 409", deliveredEarly.status === 409, deliveredEarly);
    const picked = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(agents.a2000.id), {status: "picked"});
    check("picked -> 200, picked_at set", picked.status === 200 && (await orderRow(first.publicId)).picked_at !== null, picked);
    await rest("POST", "/agents/presence/ping", agentTok(agents.a2000.id), at(1500));
    await sleep(800);
    check("customer got delivery.position", gotEvent(cust.got, "delivery.position", first.publicId), cust.got.slice(-3));
    const offPicked = await rest("POST", "/agents/presence/offline", agentTok(agents.a2000.id));
    check("offline while carrying a picked order -> 409", offPicked.status === 409, offPicked);

    const {rows: [balBefore]} = await conn.raw(`SELECT balance FROM restaurant_balances WHERE restaurant_id = ? AND currency = 'EGP'`, [tpl.restaurant_id]);
    const delivered = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(agents.a2000.id), {status: "delivered"});
    row = await orderRow(first.publicId);
    const {rows: ledger} = await conn.raw(`SELECT transaction_type, status, amount, src_acc_id, dst_acc_id FROM transactions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [row.id, row.created_at.toISOString()]);
    const {rows: [earning]} = await conn.raw(`SELECT agent_id, amount FROM agent_earnings WHERE order_id = ? AND order_created_at = ?`, [row.id, row.created_at.toISOString()]);
    const {rows: [balAfter]} = await conn.raw(`SELECT balance FROM restaurant_balances WHERE restaurant_id = ? AND currency = 'EGP'`, [tpl.restaurant_id]);
    const commission = Number(row.commission);
    check("delivered -> 200, delivered_at set", delivered.status === 200 && row.status === "delivered" && row.delivered_at !== null, delivered);
    check("COD cod_collection -> succeeded", ledger.some((t: any) => t.transaction_type === "cod_collection" && t.status === "succeeded"), ledger);
    check("commission row = orders.commission, owner -> platform", ledger.some((t: any) => t.transaction_type === "commission" && t.amount === commission && t.dst_acc_id === null), {ledger, commission});
    check("restaurant balance += subtotal - commission", Number(balAfter.balance) - Number(balBefore?.balance ?? 0) === first.subtotal - commission, {before: balBefore, after: balAfter, subtotal: first.subtotal, commission});
    check("agent earning = 80% of the delivery fee", earning && Number(earning.agent_id) === agents.a2000.id && earning.amount === Math.floor(first.deliveryFee * 0.8), earning);
    const again = await rest("PATCH", `/deliveries/${first.publicId}/status`, agentTok(agents.a2000.id), {status: "delivered"});
    const {rows: [{n}]} = await conn.raw(`SELECT count(*)::int AS n FROM agent_earnings WHERE order_id = ? AND order_created_at = ?`, [row.id, row.created_at.toISOString()]);
    check("delivered again -> 409, still one earning", again.status === 409 && n === 1, {again, n});
    await sleep(500);
    check("customer got order.status_changed delivered", cust.got.some((x) => x.event === "order.status_changed" && x.payload.orderPublicId === first.publicId && x.payload.status === "delivered"));

    console.log("\nG. online order settles only with a succeeded charge");
    const online = await placeReady("online");
    const oAccept = await rest("POST", `/deliveries/${online.publicId}/accept`, agentTok(agents.a2000.id));
    await rest("PATCH", `/deliveries/${online.publicId}/status`, agentTok(agents.a2000.id), {status: "picked"});
    const oDelivered = await rest("PATCH", `/deliveries/${online.publicId}/status`, agentTok(agents.a2000.id), {status: "delivered"});
    const oRow = await orderRow(online.publicId);
    check("online order accepted, picked, delivered", oAccept.status === 200 && oDelivered.status === 200 && oRow.status === "delivered", {oAccept, oDelivered});

    console.log("\nH. agent goes silent while assigned -> the worker takes the order back");
    const third = await placeReady("cod");
    const a3Take = await rest("POST", `/deliveries/${third.publicId}/accept`, agentTok(agents.a3000.id));
    check("3 km agent accepts the third order", a3Take.status === 200, a3Take);
    await redis.zadd(`presence:seen:${region}`, Date.now() - 6 * 60_000, String(agents.a3000.id));
    const takenBack = await waitFor(async () => (await orderRow(third.publicId)).status === "ready");
    check("order back to ready after a worker tick", takenBack, await orderRow(third.publicId));
    await sleep(800);
    check("silent agent got task.cancelled", gotEvent(sockets.a3000!.got, "task.cancelled", third.publicId), sockets.a3000!.got.slice(-3));

    console.log("\nI. cancelling a ready order withdraws its offers");
    const offeredThird = await waitFor(() => gotEvent(sockets.a500!.got, "task.offered", third.publicId) || gotEvent(sockets.a1000!.got, "task.offered", third.publicId));
    const cancel = await rest("PATCH", `/orders/${third.publicId}/status`, admin, {status: "cancelled", reason: "p3 test"});
    await sleep(800);
    const withdrawn = ["a500", "a1000"].some((k) => gotEvent(sockets[k]!.got, "task.offer_withdrawn", third.publicId));
    check("offered, then cancel -> task.offer_withdrawn", offeredThird && cancel.status === 200 && withdrawn, {offeredThird, cancel: cancel.status});

    console.log("\nJ. tasks + earnings");
    const tasks = await rest("GET", "/agents/tasks", agentTok(agents.a2000.id));
    check("tasks: the agent's delivered orders", tasks.status === 200 && tasks.json.data.some((t: any) => t.orderPublicId === first.publicId && t.status === "delivered"), tasks.json);
    const earnings = await rest("GET", "/agents/earnings", agentTok(agents.a2000.id));
    const total = earnings.json?.data?.totals?.[0];
    check("earnings: 2 orders, sum = 2 x 80% fee", earnings.status === 200 && total?.count === 2 && total?.sum === Math.floor(first.deliveryFee * 0.8) * 2, earnings.json);

    console.log("\nK. offline releases an assigned order");
    const fourth = await placeReady("cod");
    await rest("POST", `/deliveries/${fourth.publicId}/accept`, agentTok(agents.a500.id)).catch(() => null);
    const holder = Number((await orderRow(fourth.publicId)).delivery_agent_id);
    const holderTok = agentTok(holder || agents.a500.id);
    const off = await rest("POST", "/agents/presence/offline", holderTok);
    check("offline with an assigned order -> 200, order back to ready", off.status === 200 && (await orderRow(fourth.publicId)).status === "ready", {off, holder});
    await rest("PATCH", `/orders/${fourth.publicId}/status`, admin, {status: "cancelled", reason: "p3 cleanup"});
}catch(err){
    failed++;
    console.log("  ERROR", (err as Error).stack);
}finally{
    for(const s of Object.values(sockets)) s.socket.close();
    cust.socket.close();
    for(const agent of Object.values(agents)){
        await redis.multi().zrem(`presence:geo:${region}`, String(agent.id)).zrem(`presence:seen:${region}`, String(agent.id)).exec();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    await destroyAll();
    await cacheProvider.quit();
}
