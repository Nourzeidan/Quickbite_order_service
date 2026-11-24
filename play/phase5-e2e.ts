// Phase 5 (archival) end-to-end against the running services:
//   core-service: npm run dev
//   order-service: npm run dev  (the API; the archiver itself is started by this script with --once)
//   npx tsx play/phase5-e2e.ts        (~1 min)
//
// There is no real 2025 data, so the suite STAGES it on the hot eg shard: it creates 2025 month
// partitions and copies real delivered orders of this year (with every child row) under new ids,
// 2025 UUIDv7 public ids and 2025 timestamps. Then it runs `src/archiver.ts --once` as a child process
// (the real archiver code path) and checks the clusters and the API.
import "reflect-metadata";
import crypto from "crypto";
import path from "path";
import {spawn} from "child_process";
import jwt from "jsonwebtoken";
import {v7 as uuidv7} from "uuid";
import type {Knex} from "knex";
import {env} from "../src/lib/config/env.js";
import {db, dbArchive, destroyAll} from "../src/lib/knex/knex.js";
import {cacheProvider} from "../src/lib/cache/init.js";
import {loadOrderRows, ensureMonthPartition} from "../src/app/archival/repository/archival.repo.js";
import {ORDER_TABLES, type OrderBatchRows, type Row} from "../src/app/archival/types.js";
import {buildMerchantOrderRef} from "../src/app/payment/service/payment.service.js";
import {buildSignaturePayload, signKashierPayload} from "../src/pkg/payments/kashier/kashier.signature.js";
import {fromMinor} from "../src/pkg/utils/money.js";

const region = "eg";
const base = `http://localhost:${env.port}`;
const hot = db(region);
const archive = dbArchive(region);
const run = Date.now();
const tok = (p: Record<string, unknown>) => jwt.sign(p, env.jwt.accessSecret, {expiresIn: "1h"});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
    if(ok){ passed++; console.log(`  PASS  ${name}`); }
    else{ failed++; console.log(`  FAIL  ${name}  ${JSON.stringify(detail)?.slice(0, 600)}`); }
};
async function rest(method: string, path: string, token: string, body?: unknown) {
    const init: RequestInit = {method, headers: {"Authorization": `Bearer ${token}`, "X-Region": region, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID()}};
    if(body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}/api${path}`, init);
    return {status: res.status, json: await res.json().catch(() => null) as any};
}

// ---------------------------------------------------------------- the archiver, as a real process
type Report = {region: string; skipped: string | null; batches: number; ordersMoved: number; ordersBlocked: number;
    batchesChanged: number; payoutsMoved: number; webhookEventsMoved: number; partitionsDropped: string[]; stuckOrders: number | null};
function archiveOnce(extraEnv: Record<string, string> = {}): {done: Promise<{code: number; reports: Report[]; output: string}>} {
    const cli = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [cli, "src/archiver.ts", "--once"], {
        cwd: path.resolve(import.meta.dirname, ".."), env: {...process.env, ...extraEnv},
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise<{code: number; reports: Report[]; output: string}>((resolve) => child.on("close", (code) => {
        const reports = output.split(/\r?\n/).filter((line) => line.startsWith('{"archivalReport"')).map((line) => JSON.parse(line).archivalReport as Report);
        resolve({code: code ?? -1, reports, output});
    }));
    return {done};
}
const egReport = (reports: Report[]) => reports.find((r) => r.region === region);

// ---------------------------------------------------------------- staging helpers
const ts = (d: Date) => d.toISOString().slice(0, -1);                 // TIMESTAMP literal (UTC, no Z)
const at = (iso: string) => new Date(`${iso}Z`);
const nextId = async (table: string) => Number((await hot.raw(`SELECT nextval(pg_get_serial_sequence(?, 'id')) AS id`, [table])).rows[0].id);
const insertRows = async (table: string, rows: Row[], conn: Knex = hot) => {
    if(rows.length) await conn.raw(`INSERT INTO ?? SELECT * FROM json_populate_recordset(NULL::??, ?::json)`, [table, table, JSON.stringify(rows)]);
};
type OrderRef = {id: number; createdAt: Date};
const rowsOf = (o: OrderRef, conn: Knex = hot) => loadOrderRows([o.id], {from: o.createdAt, to: new Date(o.createdAt.getTime() + 1)}, conn);
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(",")}}`
    : JSON.stringify(v);
const countRows = (rows: OrderBatchRows) => ORDER_TABLES.map((t) => rows[t].length).reduce((a, b) => a + b, 0);

type Staged = OrderRef & {publicId: string; customerId: number; branchId: number; agentId: number | null; chargeId: number | null; merchantRef: string | null; label: string};

// copy a real order of this year with all its children under new ids, created at `createdAt`
async function cloneOrder(label: string, template: OrderRef, createdAt: Date, opts: {status?: string; updatedAt?: Date; children?: boolean} = {}): Promise<Staged> {
    const src = await rowsOf(template);
    const id = await nextId("orders");
    const publicId = uuidv7({msecs: createdAt.getTime()});
    const created = ts(createdAt);
    const updated = ts(opts.updatedAt ?? new Date(createdAt.getTime() + 3_600_000));
    const order: Row = {...src.orders[0]!, id, public_id: publicId, created_at: created, updated_at: updated, ...(opts.status ? {status: opts.status} : {})};
    await insertRows("orders", [order]);
    const items = await Promise.all(src.order_items.map(async (i) => ({...i, id: await nextId("order_items"), order_id: id, order_created_at: created})));
    await insertRows("order_items", items);
    const staged: Staged = {label, id, createdAt, publicId, customerId: Number(order.customer_id), branchId: Number(order.branch_id), agentId: null, chargeId: null, merchantRef: null};
    if(opts.children === false) return staged;

    const sessions = await Promise.all(src.payment_sessions.map(async (s, n) => ({...s, id: await nextId("payment_sessions"), order_id: id, order_created_at: created,
        merchant_order_ref: buildMerchantOrderRef(region, publicId, n + 1), provider_session_id: s.provider_session_id ? `${s.provider_session_id}-p5-${id}` : null})));
    await insertRows("payment_sessions", sessions);
    staged.merchantRef = (sessions[0]?.merchant_order_ref as string) ?? null;
    const idMap = new Map<number, number>();
    for(const t of src.transactions) idMap.set(Number(t.id), await nextId("transactions"));
    const txs: Row[] = src.transactions.map((t) => ({...t, id: idMap.get(Number(t.id)), order_id: id, order_created_at: created,
        refunded_payment_id: t.refunded_payment_id === null ? null : idMap.get(Number(t.refunded_payment_id)) ?? null,
        idempotency_key: t.idempotency_key === null ? null : `${t.idempotency_key}:p5-${id}`}));
    await insertRows("transactions", txs);
    staged.chargeId = (txs.find((t) => t.transaction_type === "charge") as Row | undefined)?.id as number ?? null;
    const earnings: Row[] = await Promise.all(src.agent_earnings.map(async (e) => ({...e, id: await nextId("agent_earnings"), order_id: id, order_created_at: created, earned_at: updated})));
    await insertRows("agent_earnings", earnings);
    staged.agentId = earnings[0] ? Number(earnings[0].agent_id) : null;
    return staged;
}
// an extra ledger row on a staged order, copied from its charge
async function addTransaction(order: Staged, fields: Row): Promise<number> {
    const [charge] = (await rowsOf(order)).transactions.filter((t) => t.transaction_type === "charge");
    const id = await nextId("transactions");
    await insertRows("transactions", [{...charge, id, refunded_payment_id: null, is_refunded: false, provider_requested_at: null, note: null, ...fields}]);
    return id;
}

async function signedPayWebhook(merchantOrderId: string, amountMinor: number) {
    const data: Record<string, unknown> = {
        merchantOrderId, kashierOrderId: `K-P5-${run}`, orderReference: "P5", transactionId: `TX-P5-${run}`,
        status: "SUCCESS", method: "card", amount: env.kashier.webhookAmountUnit === "minor" ? amountMinor : Number(fromMinor(amountMinor)),
        currency: "EGP", transactionResponseCode: "00", channel: "online",
    };
    const keys = Object.keys(data).sort(); data.signatureKeys = keys;
    const res = await fetch(`${base}/api/payments/webhook/kashier`, {method: "POST",
        headers: {"Content-Type": "application/json", "x-kashier-signature": signKashierPayload(buildSignaturePayload(data, keys), env.kashier.webhookSecret)},
        body: JSON.stringify({event: "pay", data})});
    return res.status;
}

// every page of a list endpoint, following nextCursor
async function allPages(pathFor: (cursor: string | null) => string, token: string) {
    const rows: any[] = []; let cursor: string | null = null; let pages = 0; let status = 200;
    do{
        const r = await rest("GET", pathFor(cursor), token);
        status = r.status; if(status !== 200) break;
        rows.push(...(r.json.data?.items ?? r.json.data ?? []));
        cursor = r.json.meta?.nextCursor ?? r.json.data?.nextCursor ?? null; pages++;
    }while(cursor && pages < 50);
    return {rows, pages, status};
}

// ---------------------------------------------------------------- setup
console.log(`\nPhase 5 archival e2e (run ${run})`);
const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as any;
if(!health) throw new Error("order-service API is not running (npm run dev)");
check("health reports the archive shards, without failing on them", Array.isArray(health.archiveShards) && health.archiveShards.some((s: any) => s.region === region && s.ok === true), health);

const tpl = async (where: string): Promise<OrderRef | null> => {
    const {rows: [r]} = await hot.raw(`SELECT o.id, o.created_at FROM orders o WHERE o.created_at >= '2026-01-01' AND o.status = 'delivered' AND ${where} ORDER BY o.created_at DESC LIMIT 1`);
    return r ? {id: Number(r.id), createdAt: r.created_at} : null;
};
const has = (table: string, extra = "") => `EXISTS (SELECT 1 FROM ${table} c WHERE c.order_id = o.id AND c.order_created_at = o.created_at ${extra})`;
const onlineTpl = await tpl(`o.payment_method = 'online' AND ${has("agent_earnings")} AND ${has("payment_sessions")} AND ${has("transactions", "AND c.transaction_type = 'refund' AND c.status = 'succeeded'")}`)
    ?? await tpl(`o.payment_method = 'online' AND ${has("agent_earnings")} AND ${has("payment_sessions")}`);
const codTpl = await tpl(`o.payment_method = 'cod' AND ${has("agent_earnings")}`);
if(!onlineTpl || !codTpl) throw new Error("need a delivered online order and a delivered COD order of this year on eg (run the Phase 3/4 suites first)");

for(const conn of [hot, archive]){
    for(const month of ["2025-03-01", "2025-04-01", "2025-06-01"]){
        await ensureMonthPartition("orders", at(`${month}T00:00:00`), conn);
        await ensureMonthPartition("order_items", at(`${month}T00:00:00`), conn);
    }
}
const old = (iso: string) => at(`${iso}T10:00:00.${String(run % 1000).padStart(3, "0")}`);
const A = await cloneOrder("A online, refunded", onlineTpl, old("2025-03-10"));
const B = await cloneOrder("B cod", codTpl, old("2025-03-12"));
const G = await cloneOrder("G crash leftover", codTpl, old("2025-03-14"));
const R = await cloneOrder("R race", onlineTpl, old("2025-03-16"));
const F = await cloneOrder("F pending shortfall", onlineTpl, old("2025-04-08"));
await addTransaction(F, {transaction_type: "adjustment", status: "pending", amount: 1, src_acc_id: 1, dst_acc_id: null, idempotency_key: `refund-shortfall:eg:p5-${run}`});
const C = await cloneOrder("C pending refund", onlineTpl, old("2025-06-03"));
await addTransaction(C, {transaction_type: "refund", status: "pending", amount: 1, src_acc_id: null, dst_acc_id: C.customerId, refunded_payment_id: C.chargeId, provider_requested_at: ts(old("2025-06-04")), idempotency_key: `p5-pending-refund-${run}`});
const D = await cloneOrder("D still ready", codTpl, old("2025-06-05"), {status: "ready", children: false});
const E = await cloneOrder("E touched 5 days ago", codTpl, old("2025-06-07"), {updatedAt: new Date(Date.now() - 5 * 86_400_000)});
const movable = [A, B, G, R, F];
const staying = [C, D, E];

// a 2025 payout and a 2025 webhook event (rows without an order)
const {rows: [payoutTpl]} = await hot.raw(`SELECT row_to_json(t) AS row FROM transactions t WHERE transaction_type = 'payout' ORDER BY id DESC LIMIT 1`);
const {rows: [eventTpl]} = await hot.raw(`SELECT row_to_json(t) AS row FROM payment_webhook_events t ORDER BY id DESC LIMIT 1`);
if(!payoutTpl || !eventTpl) throw new Error("need a payout and a webhook event on eg (run the Phase 4 suite first)");
const payoutId = await nextId("transactions");
await insertRows("transactions", [{...payoutTpl.row, id: payoutId, created_at: ts(old("2025-05-02")), updated_at: ts(old("2025-05-02")), idempotency_key: `payout:p5-${run}`}]);
const eventId = await nextId("payment_webhook_events");
await insertRows("payment_webhook_events", [{...eventTpl.row, id: eventId, provider_event_id: `p5-${run}`, received_at: ts(old("2025-05-02")), processed_at: ts(old("2025-05-02"))}]);
const payoutOwner = Number(payoutTpl.row.dst_acc_id);

// API views before archival (everything still only in hot)
const customer = tok({userId: A.customerId, email: "c@t.com", role: "customer"});
const admin = tok({userId: 999, email: "a@t.com", role: "admin"});
const agent = A.agentId ? tok({userId: A.agentId, email: "da@t.com", role: "delivery_agent"}) : null;
const detailBefore = await rest("GET", `/orders/${A.publicId}`, customer);
const earningsPath = (c: string | null) => `/agents/earnings?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&limit=2${c ? `&cursor=${c}` : ""}`;
const earningsBefore = agent ? await rest("GET", earningsPath(null), agent) : null;
const {rows: [restaurantOfPayout]} = await hot.raw(`SELECT restaurant_id FROM orders o JOIN transactions t ON t.order_id = o.id AND t.order_created_at = o.created_at WHERE t.transaction_type = 'commission' AND t.src_acc_id = ? LIMIT 1`, [payoutOwner]);

// G: a crash after the archive copy but before the hot delete — its rows are already in the
// archive, with a stale value the next run must overwrite
const gRows = await rowsOf(G);
for(const table of ORDER_TABLES){
    await insertRows(table, table === "orders" ? gRows.orders.map((o) => ({...o, cancel_reason: "stale archive copy"})) : gRows[table], archive);
}

// documented trade-off (archival.md §6): while G is in both clusters its earning is counted twice
if(agent && earningsBefore){
    const during = await rest("GET", earningsPath(null), agent);
    const sum = (r: any) => (r?.json?.data?.totals ?? []).reduce((n: number, t: any) => n + t.count, 0);
    check("earnings totals count a row in both clusters twice until the next run (known, documented)", sum(during) === sum(earningsBefore) + gRows.agent_earnings.length, {before: sum(earningsBefore), during: sum(during)});
}

const snapshot = new Map<number, OrderBatchRows>();
for(const o of [...movable, ...staying]) snapshot.set(o.id, await rowsOf(o));
const balancesBefore = canonical((await hot.raw(`SELECT row_to_json(b) AS row FROM restaurant_balances b ORDER BY restaurant_id, currency`)).rows);
console.log(`  staged ${movable.length + staying.length} orders of 2025 (A ${A.publicId})`);

// ---------------------------------------------------------------- 1. race + lock
console.log("\n1. a refund lands between the copy and the delete; a 2nd archiver runs at the same time");
const first = archiveOnce({ARCHIVE_TEST_PAUSE_MS: "4000"});
// wait until the March batch is in the archive (copied, not deleted yet: the first run is paused)
const copied = await (async () => { for(let i = 0; i < 100; i++){ if((await rowsOf(R, archive)).orders.length) return true; await sleep(200); } return false; })();
const second = await archiveOnce().done;
const lateRefundId = await addTransaction(R, {transaction_type: "refund", status: "succeeded", amount: 1, src_acc_id: null, dst_acc_id: R.customerId, refunded_payment_id: R.chargeId, idempotency_key: `p5-late-refund-${run}`});
const r1 = await first.done;
check("1st archiver copied the March batch and paused before deleting", copied, r1.output.slice(-400));
check("2nd archiver skipped eg: the region lock is held", egReport(second.reports)?.skipped === "locked", second.reports);
check("1st archiver saw the batch change and rolled its delete back", (egReport(r1.reports)?.batchesChanged ?? 0) >= 1, egReport(r1.reports));
check("R is still in hot with the late refund", (await rowsOf(R)).transactions.some((t) => Number(t.id) === lateRefundId));
check("archive copy of R is from before the refund (not deleted, not lost)", !(await rowsOf(R, archive)).transactions.some((t) => Number(t.id) === lateRefundId));

// ---------------------------------------------------------------- 2. normal run
console.log("\n2. archive:once");
const r2 = await archiveOnce().done;
const rep2 = egReport(r2.reports);
check("archiver exited 0 with a report per region", r2.code === 0 && r2.reports.length === env.regions.length, r2.output.slice(-600));
for(const o of movable){
    const inHot = await rowsOf(o);
    const inArchive = await rowsOf(o, archive);
    const expected = o === R ? await rowsOf(R, archive) : snapshot.get(o.id)!;   // R changed after the snapshot
    check(`${o.label}: gone from hot, identical in the archive (${countRows(inArchive)} rows)`,
        countRows(inHot) === 0 && ORDER_TABLES.every((t) => canonical(inArchive[t]) === canonical(expected[t])) && countRows(inArchive) === countRows(snapshot.get(o.id)!) + (o === R ? 1 : 0),
        {hot: countRows(inHot), archive: countRows(inArchive)});
}
check("R: the late refund was archived with it", (await rowsOf(R, archive)).transactions.some((t) => Number(t.id) === lateRefundId));
check("G: the stale archive copy was overwritten with the hot values", (await rowsOf(G, archive)).orders[0]?.cancel_reason === snapshot.get(G.id)!.orders[0]!.cancel_reason);
for(const o of staying){
    check(`${o.label}: stays in hot, not in the archive`, countRows(await rowsOf(o)) === countRows(snapshot.get(o.id)!) && countRows(await rowsOf(o, archive)) === 0);
}
check("C counted as blocked (money pending)", (rep2?.ordersBlocked ?? 0) >= 1, rep2);
check("2025 payout moved", (await hot.raw(`SELECT 1 FROM transactions WHERE id = ?`, [payoutId])).rows.length === 0 && (await archive.raw(`SELECT 1 FROM transactions WHERE id = ?`, [payoutId])).rows.length === 1);
check("2025 webhook event moved", (await hot.raw(`SELECT 1 FROM payment_webhook_events WHERE id = ?`, [eventId])).rows.length === 0 && (await archive.raw(`SELECT 1 FROM payment_webhook_events WHERE id = ?`, [eventId])).rows.length === 1);
const hotParts = (await hot.raw(`SELECT partition_tablename AS name FROM partman.show_partitions('public.orders')`)).rows.map((r: any) => r.name);
check("emptied months dropped on hot (2025-03, 2025-04); 2025-06 kept (C, D, E)",
    !hotParts.includes("orders_p20250301") && !hotParts.includes("orders_p20250401") && hotParts.includes("orders_p20250601"), {hotParts, dropped: rep2?.partitionsDropped});
check("stuck prior-year orders reported (C, D, E)", (rep2?.stuckOrders ?? 0) >= 3, rep2);
check("restaurant balances untouched", canonical((await hot.raw(`SELECT row_to_json(b) AS row FROM restaurant_balances b ORDER BY restaurant_id, currency`)).rows) === balancesBefore);

// ---------------------------------------------------------------- 3. reads
console.log("\n3. reads: prior year = archive + hot");
const detailAfter = await rest("GET", `/orders/${A.publicId}`, customer);
check("order detail of an archived order (with its payment summary) is unchanged", detailAfter.status === 200 && canonical(detailAfter.json.data) === canonical(detailBefore.json.data), {before: detailBefore.json?.data?.payment, after: detailAfter.json?.data?.payment});
const list = await allPages((c) => `/customer/orders?year=2025&limit=2${c ? `&cursor=${c}` : ""}`, customer);
const ids = list.rows.map((o: any) => o.publicId);
const mine = [...movable, ...staying].filter((o) => o.customerId === A.customerId).map((o) => o.publicId);
check("customer ?year=2025 lists archived AND still-hot orders, each once, across pages", list.status === 200 && mine.every((id) => ids.includes(id)) && new Set(ids).size === ids.length && list.pages > 1, {pages: list.pages, ids: ids.length, missing: mine.filter((id) => !ids.includes(id))});
const created = list.rows.map((o: any) => Date.parse(o.createdAt));
check("… newest first", created.every((t: number, i: number) => i === 0 || created[i - 1]! >= t));
// the same row in both clusters (as between a copy and a delete) is shown once
const dRows = await rowsOf(D);
await insertRows("orders", dRows.orders, archive); await insertRows("order_items", dRows.order_items, archive);
const dup = await allPages((c) => `/customer/orders?year=2025&limit=3${c ? `&cursor=${c}` : ""}`, tok({userId: D.customerId, email: "d@t.com", role: "customer"}));
check("an order in both clusters appears once", dup.rows.filter((o: any) => o.publicId === D.publicId).length === 1, dup.rows.length);
await archive.raw(`DELETE FROM orders WHERE id = ? AND created_at = ?`, [D.id, ts(D.createdAt)]);
const restaurant = await allPages((c) => `/restaurant/orders?branchId=${A.branchId}&from=2025-03-01T00:00:00Z&to=2025-03-31T23:59:59Z&limit=50${c ? `&cursor=${c}` : ""}`, admin);
check("restaurant orders, March 2025 range: archived orders listed", restaurant.status === 200 && [A, B, G, R].filter((o) => o.branchId === A.branchId).every((o) => restaurant.rows.some((r: any) => r.publicId === o.publicId)), {status: restaurant.status, n: restaurant.rows.length});
if(agent && earningsBefore){
    const earningsAfter = await rest("GET", earningsPath(null), agent);
    const pages = await allPages(earningsPath, agent);
    check("agent earnings over 2025: same totals as before archival", earningsAfter.status === 200 && canonical(earningsAfter.json.data?.totals) === canonical(earningsBefore.json.data?.totals), {before: earningsBefore.json?.data?.totals, after: earningsAfter.json?.data?.totals});
    check("… and A's earning is listed", pages.rows.some((e: any) => e.orderPublicId === A.publicId), pages.rows.length);
}
if(restaurantOfPayout){
    const payouts = await allPages((c) => `/restaurant/payouts?restaurantId=${restaurantOfPayout.restaurant_id}&from=2025-04-01T00:00:00Z&to=2025-06-01T00:00:00Z${c ? `&cursor=${c}` : ""}`, admin);
    check("payouts list over a 2025 range finds the archived payout", payouts.rows.some((p: any) => Number(p.id) === payoutId), {status: payouts.status, n: payouts.rows.length});
}
if(A.chargeId){
    const payment = await rest("GET", `/payments/${A.chargeId}`, admin);
    check("GET /payments/:id of an archived charge -> 200 (archive fallback)", payment.status === 200 && payment.json.data?.orderPublicId === A.publicId, payment);
}

// ---------------------------------------------------------------- 4. writes
console.log("\n4. writes on archived orders");
const status = await rest("PATCH", `/orders/${A.publicId}/status`, admin, {status: "cancelled"});
check("status change on an archived order -> 404", status.status === 404, status);
if(A.chargeId){
    const refund = await rest("POST", `/payments/${A.chargeId}/refund`, admin, {amount: 1, reason: "phase 5 test"});
    check("refund of an archived charge -> 404", refund.status === 404, refund);
}
if(A.merchantRef){
    const code = await signedPayWebhook(A.merchantRef, 100);
    const {rows: [ev]} = await hot.raw(`SELECT process_error FROM payment_webhook_events WHERE provider_event_id LIKE ? ORDER BY id DESC LIMIT 1`, [`%TX-P5-${run}%`]);
    check("late webhook for an archived order -> 200, recorded as 'order archived'", code === 200 && ev?.process_error === "order archived", {code, ev});
}

// ---------------------------------------------------------------- 5. idempotency
console.log("\n5. run again");
const archiveBefore = canonical(await Promise.all(movable.map((o) => rowsOf(o, archive))));
const r3 = await archiveOnce().done;
const rep3 = egReport(r3.reports);
check("2nd run moves nothing", r3.code === 0 && rep3?.ordersMoved === 0 && rep3?.payoutsMoved === 0 && rep3?.webhookEventsMoved === 0, rep3);
check("… and changes nothing in the archive", canonical(await Promise.all(movable.map((o) => rowsOf(o, archive)))) === archiveBefore);

// ---------------------------------------------------------------- cleanup: the orders that stay hot
for(const o of staying){
    const range = [o.id, ts(o.createdAt)];
    await hot.raw(`DELETE FROM agent_earnings WHERE order_id = ? AND order_created_at = ?`, range);
    await hot.raw(`DELETE FROM transactions WHERE order_id = ? AND order_created_at = ? AND refunded_payment_id IS NOT NULL`, range);
    await hot.raw(`DELETE FROM transactions WHERE order_id = ? AND order_created_at = ?`, range);
    await hot.raw(`DELETE FROM payment_sessions WHERE order_id = ? AND order_created_at = ?`, range);
    await hot.raw(`DELETE FROM orders WHERE id = ? AND created_at = ?`, range);
}

console.log(`\n${passed} passed, ${failed} failed`);
await destroyAll();
await cacheProvider.quit().catch(() => {});
process.exit(failed === 0 ? 0 : 1);
