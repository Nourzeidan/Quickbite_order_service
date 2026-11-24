// Phase 4 (restaurant finance) end-to-end against the running services:
//   core-service: npm run dev + npm run worker (the worker publishes branch.updated)
//   order-service: npm run dev + npm run worker
//   npx tsx play/phase4-e2e.ts        (~1 min)
//
// Refunds: the real Kashier sandbox rejects the made-up kashierOrderIds of test orders, so a refund is
// staged exactly as RefundService leaves it after sending (pending row, provider_requested_at set) and
// then confirmed by a SIGNED refund webhook — the real webhook -> debit path runs end to end.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {io, type Socket} from "socket.io-client";
import {env} from "../src/lib/config/env.js";
import {ensureStock} from "./test-stock.js";
import {db, destroyAll} from "../src/lib/knex/knex.js";
import {cacheProvider} from "../src/lib/cache/init.js";
import {CORE_CACHE_KEYS} from "../src/lib/core-client/cache-keys.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const base = `http://localhost:${env.port}`;
const coreBase = env.core.baseUrl.replace(/\/+$/, "");
const conn = db(region);
const redis = cacheProvider.getClient();
const run = Date.now();
const COMMISSION_BPS = 1000;                       // 10% during the test
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)?.slice(0, 600)}`); }
};

async function rest(method: string, path: string, token: string, body?: unknown, key: string = crypto.randomUUID()) {
    const init: RequestInit = {method, headers: {"Authorization": `Bearer ${token}`, "X-Region": region, "Content-Type": "application/json", "Idempotency-Key": key}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}/api${path}`, init);
    return {status: res.status, json: await res.json().catch(() => null) as any};
}
async function core(method: string, path: string, headers: Record<string, string>, body?: unknown) {
    const init: RequestInit = {method, headers: {"Content-Type": "application/json", ...headers}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${coreBase}/api${path}`, init);
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
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 15_000) {
    const end = Date.now() + ms;
    while(Date.now() < end){ if(await fn()) return true; await sleep(300); }
    return false;
}

// ---------------------------------------------------------------- setup
const {rows: [tpl]} = await conn.raw(`
    SELECT o.customer_id, o.branch_id, o.restaurant_id, o.customer_address_id,
           (SELECT product_id FROM order_items i WHERE i.order_id = o.id AND i.order_created_at = o.created_at LIMIT 1) AS product_id
    FROM orders o ORDER BY created_at DESC LIMIT 1`);
const customerId = Number(tpl.customer_id), branchId = Number(tpl.branch_id), restaurantId = Number(tpl.restaurant_id);
await ensureStock(branchId, restaurantId, Number(tpl.product_id));
const customer = tok({userId: customerId, email: "c@t.com", role: "customer"});
const admin = tok({userId: 999, email: "a@t.com", role: "admin"});
const coreInternal = {"api-key": env.core.internalApiKey};

const [coreRestaurant] = (await core("GET", `/internal/restaurants?ids=${restaurantId}`, coreInternal)).json ?? [];
const coreBranch = (await core("GET", `/internal/branches/${branchId}`, coreInternal)).json;
if(!coreRestaurant?.ownerId || !coreBranch?.id) throw new Error("core-service is not reachable (restaurant / branch lookup)");
const ownerId = Number(coreRestaurant.ownerId);
const originalBps = Number(coreBranch.commission ?? 0);
const owner = tok({userId: ownerId, email: "o@t.com", role: "restaurant_user", restaurantId, restaurantRole: "owner", branchIds: [branchId]});
const manager = tok({userId: 990_001, email: "m@t.com", role: "restaurant_user", restaurantId, restaurantRole: "branch_manager", branchIds: [branchId]});
const staff = tok({userId: 990_002, email: "s@t.com", role: "restaurant_user", restaurantId, restaurantRole: "staff", branchIds: [branchId]});

const agentId = 700_000 + (run % 100_000);
const agent = tok({userId: agentId, email: `da${agentId}@t.com`, role: "delivery_agent"});
const orderBody = (paymentMethod: string) => ({branchId, customerAddressId: Number(tpl.customer_address_id), paymentMethod, items: [{productId: Number(tpl.product_id), quantity: 1}]});
const orderRow = async (publicId: string) => (await conn.raw(`SELECT * FROM orders WHERE public_id = ?::uuid AND created_at = (uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')`, [publicId, publicId])).rows[0];
const balance = async () => Number((await conn.raw(`SELECT balance FROM restaurant_balances WHERE restaurant_id = ? AND currency = 'EGP'`, [restaurantId])).rows[0]?.balance ?? 0);
const ledgerOf = async (publicId: string) => {
    const row = await orderRow(publicId);
    return (await conn.raw(`SELECT id, transaction_type, status, amount, src_acc_id, dst_acc_id, idempotency_key, is_refunded FROM transactions WHERE order_id = ? AND order_created_at = ? ORDER BY id`, [row.id, row.created_at.toISOString()])).rows;
};

async function signedWebhook(event: "pay" | "refund", fields: {merchantOrderId: string; kashierOrderId: string; transactionId: string; amountMinor: number}) {
    const data: Record<string, unknown> = {
        merchantOrderId: fields.merchantOrderId, kashierOrderId: fields.kashierOrderId, orderReference: "P4", transactionId: fields.transactionId,
        status: "SUCCESS", method: "card", amount: env.kashier.webhookAmountUnit === "minor" ? fields.amountMinor : Number(fromMinor(fields.amountMinor)),
        currency: "EGP", transactionResponseCode: "00", channel: "online",
    };
    const keys = Object.keys(data).sort(); data.signatureKeys = keys;
    const res = await fetch(`${base}/api/payments/webhook/kashier`, {method: "POST",
        headers: {"Content-Type": "application/json", "x-kashier-signature": signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret)},
        body: JSON.stringify({event, data})});
    return res.status;
}

type Placed = {publicId: string; total: number; subtotal: number; deliveryFee: number; merchantRef?: string; kashierOrderId?: string};
async function placeReady(paymentMethod: "cod" | "online"): Promise<Placed> {
    const placed = await rest("POST", "/orders", customer, orderBody(paymentMethod));
    if(placed.status !== 201) throw new Error(`place: ${placed.status} ${JSON.stringify(placed.json)}`);
    const order = placed.json.data;
    const result: Placed = {publicId: order.publicId, total: order.total, subtotal: order.subtotal, deliveryFee: order.deliveryFee};
    if(paymentMethod === "online"){
        await rest("POST", "/payments/init", customer, {orderId: order.publicId});
        const {rows: [s]} = await conn.raw(`SELECT ps.merchant_order_ref, ps.amount FROM payment_sessions ps JOIN orders o ON o.id = ps.order_id AND o.created_at = ps.order_created_at WHERE o.public_id = ?::uuid ORDER BY ps.id DESC LIMIT 1`, [order.publicId]);
        result.merchantRef = s.merchant_order_ref;
        result.kashierOrderId = `K-P4-${order.publicId}`;
        await signedWebhook("pay", {merchantOrderId: s.merchant_order_ref, kashierOrderId: result.kashierOrderId, transactionId: `TX-P4-${run}-${order.publicId}`, amountMinor: s.amount});
    }
    for(const status of ["accepted", "preparing", "ready"]){
        const r = await rest("PATCH", `/orders/${order.publicId}/status`, admin, {status});
        if(r.status !== 200) throw new Error(`moving order to ${status}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    return result;
}
async function pick(publicId: string) {
    const a = await rest("POST", `/deliveries/${publicId}/accept`, agent);
    const p = await rest("PATCH", `/deliveries/${publicId}/status`, agent, {status: "picked"});
    if(a.status !== 200 || p.status !== 200) throw new Error(`accept/pick: ${a.status} ${p.status} ${JSON.stringify([a.json, p.json])}`);
}
async function deliver(publicId: string) {
    const d = await rest("PATCH", `/deliveries/${publicId}/status`, agent, {status: "delivered"});
    if(d.status !== 200) throw new Error(`deliver: ${d.status} ${JSON.stringify(d.json)}`);
}
// a refund exactly as RefundService leaves it after sending it to Kashier: pending, sent, no provider id yet
async function stageSentRefund(publicId: string, amount: number): Promise<number> {
    const [charge] = (await ledgerOf(publicId)).filter((t: any) => t.transaction_type === "charge" && t.status === "succeeded");
    const row = await orderRow(publicId);
    const {rows: [r]} = await conn.raw(`
        INSERT INTO transactions (region, order_id, order_created_at, transaction_type, method, provider_id, status, amount, currency,
                                  src_acc_id, dst_acc_id, refunded_payment_id, idempotency_key, note, provider_requested_at)
        VALUES (?, ?, ?, 'refund', 'online', 1, 'pending', ?, 'EGP', NULL, ?, ?, ?, 'p4 e2e refund', NOW()) RETURNING id`,
        [region, row.id, row.created_at.toISOString(), amount, customerId, charge.id, `p4-refund:${run}:${crypto.randomUUID()}`]);
    return Number(r.id);
}
const confirmRefund = (o: Placed, amount: number, tx: string) =>
    signedWebhook("refund", {merchantOrderId: o.merchantRef!, kashierOrderId: o.kashierOrderId!, transactionId: tx, amountMinor: amount});
const balanceEvents = (list: Received[]) => list.filter((x) => x.event === "restaurant.balance_changed");
const expectedCommission = (subtotal: number) => Math.floor(subtotal * COMMISSION_BPS / 10_000);

const rest$ = await socketFor(owner, `restaurant:${restaurantId}`);

try{
    console.log(`\nrestaurant ${restaurantId} (owner ${ownerId}), branch ${branchId} (commission was ${originalBps} bps), agent ${agentId}`);

    console.log("\nA. admin sets the branch commission in core");
    const asOwner = await core("PATCH", `/branches/${branchId}/commission`, {Authorization: `Bearer ${owner}`}, {commissionBps: COMMISSION_BPS});
    check("owner can't set commission (admin only)", asOwner.status !== 200, asOwner);
    const tooBig = await core("PATCH", `/branches/${branchId}/commission`, {Authorization: `Bearer ${admin}`}, {commissionBps: 20_000});
    check("commissionBps > 10000 -> 400", tooBig.status === 400, tooBig);
    // seed the cache with the current (old-commission) snapshot; branch.updated must delete it
    await redis.set(CORE_CACHE_KEYS.branch(branchId), JSON.stringify(coreBranch), "EX", 60);
    const set = await core("PATCH", `/branches/${branchId}/commission`, {Authorization: `Bearer ${admin}`}, {commissionBps: COMMISSION_BPS});
    check("admin sets 1000 bps -> 200", set.status === 200 && set.json?.branch?.commissionBps === COMMISSION_BPS, set);
    const invalidated = await waitFor(async () => JSON.parse((await redis.get(CORE_CACHE_KEYS.branch(branchId))) ?? "{}").commission !== originalBps, 20_000);
    check("branch.updated reached order-service and dropped the cached branch (needs core worker)", invalidated);
    if(!invalidated) await redis.del(CORE_CACHE_KEYS.branch(branchId));

    // agent near the branch
    const probe = await placeReady("cod");
    const probeRow = await orderRow(probe.publicId);
    const pos = {lat: Number(probeRow.pickup_lat) + 200 / 111_320, lng: Number(probeRow.pickup_lng)};
    if((await rest("POST", "/agents/presence/online", agent, pos)).status !== 200) throw new Error("agent online failed");

    console.log("\nB. settlement credits subtotal - commission, live");
    const start = await balance();
    const second = await placeReady("cod");
    let expectedCredit = 0;
    for(const o of [probe, second]){
        await pick(o.publicId);
        await deliver(o.publicId);
        const row = await orderRow(o.publicId);
        check(`order ${o.publicId.slice(-6)}: commission = 10% of subtotal`, Number(row.commission) === expectedCommission(o.subtotal) && Number(row.commission) > 0, {commission: row.commission, subtotal: o.subtotal});
        expectedCredit += o.subtotal - Number(row.commission);
    }
    const afterTwo = await balance();
    check("balance += sum(subtotal - commission) of the 2 orders", afterTwo - start === expectedCredit, {start, afterTwo, expectedCredit});
    await waitFor(() => balanceEvents(rest$.got).length >= 2, 3000);
    const evs = balanceEvents(rest$.got);
    check("restaurant socket got restaurant.balance_changed per settlement, last = DB balance",
        evs.length >= 2 && evs[evs.length - 1]!.payload.balance === afterTwo && evs[evs.length - 1]!.payload.currency === "EGP", evs);

    console.log("\nC. GET /restaurant/balance");
    const bOwner = await rest("GET", "/restaurant/balance", owner);
    const egp = bOwner.json?.data?.balances?.find((b: any) => b.currency === "EGP");
    check("owner reads balance = DB", bOwner.status === 200 && egp?.balance === afterTwo && bOwner.json.data.restaurantId === restaurantId, bOwner.json);
    check("branch manager can read it", (await rest("GET", "/restaurant/balance", manager)).status === 200);
    check("staff -> 403 (no order:finance read)", (await rest("GET", "/restaurant/balance", staff)).status === 403);
    check("customer -> 403", (await rest("GET", "/restaurant/balance", customer)).status === 403);
    check("admin without restaurantId -> 400", (await rest("GET", "/restaurant/balance", admin)).status === 400);
    const bAdmin = await rest("GET", `/restaurant/balance?restaurantId=${restaurantId}`, admin);
    check("admin with restaurantId -> same balance", bAdmin.status === 200 && bAdmin.json.data.balances.some((b: any) => b.currency === "EGP" && b.balance === afterTwo), bAdmin.json);

    console.log("\nD. payouts");
    const payoutBody = (amount: number) => ({restaurantId, amount, currency: "EGP", providerReferenceId: `BANK-${run}-${amount}`, note: "p4 e2e"});
    const over = await rest("POST", "/restaurant/payouts", admin, payoutBody(afterTwo + 1));
    check("payout > balance -> 409 Insufficient balance", over.status === 409 && /Insufficient balance/.test(JSON.stringify(over.json)), over);
    check("owner can't record a payout -> 403", (await rest("POST", "/restaurant/payouts", owner, payoutBody(100))).status === 403);
    const unknown = await rest("POST", "/restaurant/payouts", admin, {...payoutBody(100), restaurantId: 99_999_999});
    check("unknown restaurant -> 404", unknown.status === 404, unknown);
    const key = crypto.randomUUID();
    const beforeEvents = balanceEvents(rest$.got).length;
    const p1 = await rest("POST", "/restaurant/payouts", admin, payoutBody(500), key);
    const p2 = await rest("POST", "/restaurant/payouts", admin, payoutBody(500), key);
    const {rows: [{n: payoutRows}]} = await conn.raw(`SELECT count(*)::int AS n FROM transactions WHERE transaction_type = 'payout' AND provider_reference_id = ?`, [`BANK-${run}-500`]);
    check("payout -> 201", p1.status === 201 && p1.json.data.amount === 500 && p1.json.data.status === "succeeded", p1);
    check("same Idempotency-Key twice -> same payout, one row", p2.json?.data?.id === p1.json?.data?.id && payoutRows === 1, {p2, payoutRows});
    const afterPayout = await balance();
    check("balance -= 500 once", afterTwo - afterPayout === 500, {afterTwo, afterPayout});
    await waitFor(() => balanceEvents(rest$.got).length > beforeEvents, 3000);
    check("restaurant socket got balance_changed after the payout", balanceEvents(rest$.got).slice(beforeEvents).some((x) => x.payload.balance === afterPayout));
    const list = await rest("GET", "/restaurant/payouts", owner);
    check("GET /restaurant/payouts lists it first (newest first)", list.status === 200 && list.json.data[0]?.id === p1.json.data.id && list.json.meta, list.json);
    const badRange = await rest("GET", "/restaurant/payouts?from=2026-12-01T00:00:00Z&to=2026-01-01T00:00:00Z", owner);
    check("from after to -> 400", badRange.status === 400, badRange);

    // Redis keeps the response 24 h; after that the ledger's unique idempotency_key is the guard
    await redis.del(`idempotency:${region}:999:POST:/api/restaurant/payouts:${key}`);
    const p3 = await rest("POST", "/restaurant/payouts", admin, payoutBody(500), key);
    const {rows: [{n: payoutRowsAfter}]} = await conn.raw(`SELECT count(*)::int AS n FROM transactions WHERE transaction_type = 'payout' AND provider_reference_id = ?`, [`BANK-${run}-500`]);
    check("replay after the Redis response expired -> same payout from the ledger, no 2nd row, balance unchanged",
        p3.status === 201 && p3.json?.data?.id === p1.json.data.id && payoutRowsAfter === 1 && await balance() === afterPayout, {p3, payoutRowsAfter});

    // two admins record payouts at the same moment that TOGETHER exceed the balance: the balance row
    // lock (FOR UPDATE) makes the second wait, re-read the balance and fail
    const half = Math.floor(afterPayout / 2) + 1;
    const [c1, c2] = await Promise.all([
        rest("POST", "/restaurant/payouts", admin, payoutBody(half)),
        rest("POST", "/restaurant/payouts", admin, {...payoutBody(half), providerReferenceId: `BANK-${run}-${half}-b`}),
    ]);
    const concurrent = [c1.status, c2.status].sort();
    const afterConcurrent = await balance();
    check("two concurrent payouts > balance together -> one 201, one 409", concurrent[0] === 201 && concurrent[1] === 409, [c1, c2]);
    check("balance -= one payout only (never negative)", afterPayout - afterConcurrent === half && afterConcurrent >= 0, {afterPayout, afterConcurrent, half});

    console.log("\nE. refund of a delivered order debits the balance");
    const online = await placeReady("online");
    await pick(online.publicId);
    await deliver(online.publicId);
    const oRow = await orderRow(online.publicId);
    const share = online.subtotal - Number(oRow.commission);
    const partial = 1000;
    const b0 = await balance();
    const ref1 = await stageSentRefund(online.publicId, partial);
    const beforeRefundEvents = balanceEvents(rest$.got).length;
    const w1 = await confirmRefund(online, partial, `RF-P4-${run}-1`);
    const b1 = await balance();
    let l = await ledgerOf(online.publicId);
    check("refund webhook 200, balance -= refund", w1 === 200 && b0 - b1 === partial, {w1, b0, b1});
    check("ledger: succeeded adjustment owner -> platform, key refund-debit:eg:refund:<id>",
        l.some((t: any) => t.transaction_type === "adjustment" && t.status === "succeeded" && t.amount === partial && Number(t.src_acc_id) === ownerId && t.dst_acc_id === null && t.idempotency_key === `refund-debit:eg:refund:${ref1}`), l);
    await waitFor(() => balanceEvents(rest$.got).length > beforeRefundEvents, 3000);
    check("restaurant socket got balance_changed after the refund debit", balanceEvents(rest$.got).slice(beforeRefundEvents).some((x) => x.payload.balance === b1));
    const dup = await confirmRefund(online, partial, `RF-P4-${run}-1`);
    check("same refund webhook again -> no second debit", dup === 200 && await balance() === b1, {dup});

    const rest2 = online.total - partial;          // the rest of the charge, delivery fee included
    await stageSentRefund(online.publicId, rest2);
    await confirmRefund(online, rest2, `RF-P4-${run}-2`);
    const b2 = await balance();
    l = await ledgerOf(online.publicId);
    check("2nd refund takes back only what is left of the restaurant share (delivery fee stays with the platform)",
        b1 - b2 === share - partial, {b1, b2, share, partial, rest2});
    check("charge marked refunded", l.some((t: any) => t.transaction_type === "charge" && t.status === "succeeded" && t.is_refunded), l);

    console.log("\nF. refund larger than the balance -> balance 0 + pending shortfall");
    const online2 = await placeReady("online");
    await pick(online2.publicId);
    await deliver(online2.publicId);
    const o2Row = await orderRow(online2.publicId);
    const share2 = online2.subtotal - Number(o2Row.commission);
    const drain = (await balance()) - 100;
    const pd = await rest("POST", "/restaurant/payouts", admin, payoutBody(drain));
    check("payout leaves 100 in the balance", pd.status === 201 && await balance() === 100, pd);
    const ref3 = await stageSentRefund(online2.publicId, online2.total);
    await confirmRefund(online2, online2.total, `RF-P4-${run}-3`);
    const l2 = await ledgerOf(online2.publicId);
    check("balance stops at 0 (never negative)", await balance() === 0);
    check("debited 100 (succeeded) + shortfall share-100 (pending)",
        l2.some((t: any) => t.idempotency_key === `refund-debit:eg:refund:${ref3}` && t.status === "succeeded" && t.amount === 100) &&
        l2.some((t: any) => t.idempotency_key === `refund-shortfall:eg:refund:${ref3}` && t.status === "pending" && t.amount === share2 - 100), {l2, share2});

    console.log("\nG. refund confirmed while the order is on its way -> taken back at settlement");
    const online3 = await placeReady("online");
    await pick(online3.publicId);
    const bPicked = await balance();
    const early = 700;
    await stageSentRefund(online3.publicId, early);
    await confirmRefund(online3, early, `RF-P4-${run}-4`);
    check("refund before delivery: balance untouched", await balance() === bPicked);
    await deliver(online3.publicId);
    const o3Row = await orderRow(online3.publicId);
    const l3 = await ledgerOf(online3.publicId);
    check("at delivery: balance += share - refund", (await balance()) - bPicked === online3.subtotal - Number(o3Row.commission) - early, {bPicked, now: await balance()});
    check("adjustment key refund-debit:eg:settlement:<publicId>",
        l3.some((t: any) => t.transaction_type === "adjustment" && t.amount === early && t.idempotency_key === `refund-debit:eg:settlement:${online3.publicId}`), l3);

    console.log("\nH. balance matches the ledger for this run");
    const {rows: [sums]} = await conn.raw(`
        SELECT
          COALESCE(SUM(o.subtotal - o.commission) FILTER (WHERE o.status = 'delivered'), 0)::int AS credits
        FROM orders o WHERE o.public_id = ANY(?::uuid[])`, [[probe, second, online, online2, online3].map((o) => o.publicId)]);
    const {rows: [moves]} = await conn.raw(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'payout' AND provider_reference_id LIKE ?), 0)::int AS payouts,
          COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'adjustment' AND status = 'succeeded' AND idempotency_key LIKE 'refund-debit:%'
                                       AND created_at >= to_timestamp(?) AT TIME ZONE 'UTC'), 0)::int AS debits
        FROM transactions WHERE src_acc_id = ? OR dst_acc_id = ?`, [`BANK-${run}-%`, Math.floor(run / 1000) - 5, ownerId, ownerId]);
    const endBalance = await balance();
    check("end - start = credits - payouts - refund debits", endBalance - start === sums.credits - moves.payouts - moves.debits, {start, endBalance, sums, moves});
}catch(err){
    failed++;
    console.log("  ERROR", (err as Error).stack);
}finally{
    const restore = await core("PATCH", `/branches/${branchId}/commission`, {Authorization: `Bearer ${admin}`}, {commissionBps: originalBps});
    console.log(`\ncommission restored to ${originalBps} bps: ${restore.status}`);
    await redis.del(CORE_CACHE_KEYS.branch(branchId));
    await rest("POST", "/agents/presence/offline", agent).catch(() => null);
    rest$.socket.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    await destroyAll();
    await cacheProvider.quit();
}
