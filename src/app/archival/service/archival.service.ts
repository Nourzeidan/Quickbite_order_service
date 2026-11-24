import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {env} from "../../../lib/config/env.js";
import {db, dbArchive} from "../../../lib/knex/knex.js";
import {logger} from "../../../lib/logger/logger.js";
import {daysToMs, startOfUtcYear} from "../../../pkg/utils/time.js";
import type {OrderCacheService} from "../../order/service/order-cache.service.js";
import {
    deleteOrderRows,
    deleteRowsById,
    dropMonthPartitions,
    ensureMonthPartition,
    findArchiveCandidates,
    findOrdersWithOpenMoney,
    findStuckOrders,
    isTableEmpty,
    listMonthPartitions,
    loadOrderlessRows,
    loadOrderRows,
    loadRowsById,
    lockOrderRows,
    lockRowsById,
    tableColumns,
    upsertRows,
    withAdvisoryLock,
    type TimeRange
} from "../repository/archival.repo.js";
import {
    ORDER_TABLES,
    ORDERLESS_TABLES,
    type ArchivalRegionReport,
    type ArchivedTable,
    type OrderBatchRows,
    type OrderKey,
    type Row
} from "../types.js";

const STUCK_SAMPLE = 20;

// what one batch did
type BatchOutcome = "moved" | "changed";

// the archive must have exactly the hot schema, or a copy could lose a column
class ArchiveSchemaMismatchError extends Error {}
// rows read back from the archive differ from what was written: stop the region, hot is untouched
class ArchiveVerifyError extends Error {}

// docs/business-logic/archival.md — moves prior-year, finished orders (and everything attached to
// them), payouts and webhook events from the hot cluster to the archive cluster of each region.
// Runs in its own process (src/archiver.ts, `npm run archiver`).
//
// The two clusters are different databases: no transaction covers both. Safety comes from the order
// of the steps — copy, verify, then delete from hot only what is proven to be in the archive. At
// every moment a row is in hot, in the archive or (briefly) in both; never in neither.
@injectable()
export class ArchivalService {
    // per region: column lists, checked against the archive once by this process
    private readonly columnsByRegion = new Map<string, Record<ArchivedTable, string[]>>();

    constructor(@inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService){}

    // one pass over every region. ignoreWindow: `npm run archive:once` (tests, ops after an outage)
    run = async (options: {ignoreWindow?: boolean} = {}): Promise<ArchivalRegionReport[]> => {
        const now = new Date();
        if(!options.ignoreWindow && !inWindow(now)){
            return [];
        }
        const reports: ArchivalRegionReport[] = [];
        for(const region of env.regions){
            try{
                const report = await this.runRegion(region, now);
                reports.push(report);
                logger.info("archival run done", {...report});
            }catch(err){
                // one region failing must not stop the others; hot data is never deleted unverified
                logger.error("ALERT archival failed", {region, error: (err as Error).message});
            }
        }
        return reports;
    }

    private runRegion = async (region: string, now: Date): Promise<ArchivalRegionReport> => {
        const report: ArchivalRegionReport = {
            region, skipped: null, batches: 0, ordersMoved: 0, ordersBlocked: 0, batchesChanged: 0,
            payoutsMoved: 0, webhookEventsMoved: 0, partitionsDropped: [], stuckOrders: null,
        };
        const hot = db(region);
        const archive = dbArchive(region);

        // one archiver per region (§4): a second process gets null and skips
        const done = await withAdvisoryLock(`archival:${region}`, hot, async () => {
            const columns = await this.checkSchema(region, hot, archive);

            const cutoff = startOfUtcYear(now.getUTCFullYear());                 // Jan 1 of this year
            const untouchedSince = new Date(now.getTime() - daysToMs(env.archival.minAgeDays));
            let budget = env.archival.maxBatchesPerRun;

            // 1. orders, oldest month first; then the default partition (only if maintenance stopped)
            const orderMonths = (await listMonthPartitions("orders", hot)).filter((part) => part.end <= cutoff);
            const partitionsToScan = [...orderMonths.map((part) => part.name), "orders_default"];
            for(const partition of partitionsToScan){
                let afterId = 0;
                while(budget > 0){
                    const candidates = await findArchiveCandidates(partition, cutoff, untouchedSince, afterId, env.archival.batchSize, hot);
                    if(candidates.length === 0) break;
                    afterId = candidates[candidates.length - 1]!.id;
                    budget -= 1;
                    report.batches += 1;

                    const blocked = await findOrdersWithOpenMoney(candidates.map((order) => order.id), rangeOf(candidates), hot);
                    const batch = candidates.filter((order) => !blocked.has(order.id));
                    report.ordersBlocked += candidates.length - batch.length;
                    if(batch.length > 0){
                        const outcome = await this.moveOrderBatch(region, batch, columns, hot, archive);
                        if(outcome === "moved") report.ordersMoved += batch.length;
                        else report.batchesChanged += 1;
                    }
                    if(candidates.length < env.archival.batchSize) break;
                }
            }

            // 2. rows without an order (§5.3): same copy -> verify -> guarded delete
            const orderlessBefore = new Date(Math.min(cutoff.getTime(), untouchedSince.getTime()));
            report.payoutsMoved = await this.moveOrderless("transactions", orderlessBefore, columns, hot, archive);
            report.webhookEventsMoved = await this.moveOrderless("payment_webhook_events", orderlessBefore, columns, hot, archive);

            // 3. emptied prior-year months: drop their partitions (§5.4)
            const itemMonths = new Map((await listMonthPartitions("order_items", hot)).map((part) => [part.start.getTime(), part.name]));
            for(const part of orderMonths){
                const itemsPartition = itemMonths.get(part.start.getTime()) ?? null;
                if(!(await isTableEmpty(part.name, hot))) continue;
                if(itemsPartition && !(await isTableEmpty(itemsPartition, hot))) continue;
                try{
                    await inTransaction(hot, (trx) => dropMonthPartitions(part.name, itemsPartition, trx));
                    report.partitionsDropped.push(part.name);
                }catch(err){
                    // lock_timeout on a busy moment: tried again next run
                    logger.warn("archival: partition drop skipped", {region, partition: part.name, error: (err as Error).message});
                }
            }

            // 4. prior-year orders still hot long after the cutoff -> someone should look (§3)
            if(now.getTime() >= cutoff.getTime() + daysToMs(env.archival.stuckAlertDays)){
                const stuck = await findStuckOrders(cutoff, STUCK_SAMPLE, hot);
                report.stuckOrders = stuck.count;
                if(stuck.count > 0){
                    logger.warn("ALERT archival.stuck_orders", {region, count: stuck.count, sample: stuck.publicIds});
                }
            }
            return true;
        });
        if(done === null){
            report.skipped = "locked";
        }
        return report;
    }

    // §5.1 steps 2–6 for one batch of eligible orders
    private moveOrderBatch = async (
        region: string,
        batch: OrderKey[],
        columns: Record<ArchivedTable, string[]>,
        hot: Knex,
        archive: Knex
    ): Promise<BatchOutcome> => {
        const ids = batch.map((order) => order.id);
        const range = rangeOf(batch);

        // 2. load the orders and their children, as stored
        const copied = await loadOrderRows(ids, range, hot);

        // 3. the archive gets the month partitions first (pg_partman premakes only future months)
        for(const month of monthsOf(batch)){
            await ensureMonthPartition("orders", month, archive);
            await ensureMonthPartition("order_items", month, archive);
        }

        // 4. one archive transaction, FK order: orders -> items -> sessions -> transactions -> earnings
        await inTransaction(archive, async (trx) => {
            for(const table of ORDER_TABLES){
                await upsertRows(table, copied[table], columns[table], trx);
            }
        });

        // 5. verify: what the archive holds now is exactly what was read from hot
        const stored = await loadOrderRows(ids, range, archive);
        for(const table of ORDER_TABLES){
            if(!sameRows(copied[table], stored[table])){
                throw new ArchiveVerifyError(`archive rows of ${table} differ from hot after the copy (${ids.length} orders)`);
            }
        }

        if(env.archival.testPauseMs > 0){
            await new Promise((resolve) => setTimeout(resolve, env.archival.testPauseMs));
        }

        // 6. guarded delete: lock, re-read with a NEW statement (READ COMMITTED: a statement that
        // waited for a lock keeps its old snapshot; the next one sees what the other trx committed),
        // and delete only if nothing changed since the copy
        const outcome = await inTransaction(hot, async (trx): Promise<BatchOutcome> => {
            await lockOrderRows(ids, range, trx);
            const current = await loadOrderRows(ids, range, trx);
            if(!ORDER_TABLES.every((table) => sameRows(copied[table], current[table]))){
                return "changed";
            }
            await deleteOrderRows(ids, range, trx);
            return "moved";
        });

        if(outcome === "changed"){
            // e.g. an admin refund committed between the copy and the delete: the next run copies the
            // batch again (upsert refreshes the archive) and then deletes it
            logger.warn("archival: batch changed during copy, retried next run", {region, orders: ids.length});
            return outcome;
        }
        // after commit: drop the 5 s order cache entries (one DEL for the whole batch)
        await this.orderCache.invalidateMany(batch.map((order) => ({region, publicId: order.publicId})));
        return outcome;
    }

    // payouts / non-order adjustments and webhook events, batch by batch
    private moveOrderless = async (
        table: "transactions" | "payment_webhook_events",
        before: Date,
        columns: Record<ArchivedTable, string[]>,
        hot: Knex,
        archive: Knex
    ): Promise<number> => {
        let moved = 0;
        let afterId = 0;
        for(;;){
            const rows = await loadOrderlessRows(table, before, afterId, env.archival.batchSize, hot);
            if(rows.length === 0) break;
            const ids = rows.map((row) => Number(row.id));
            afterId = ids[ids.length - 1]!;

            await inTransaction(archive, (trx) => upsertRows(table, rows, columns[table], trx));
            if(!sameRows(rows, await loadRowsById(table, ids, archive))){
                throw new ArchiveVerifyError(`archive rows of ${table} differ from hot after the copy (${ids.length} rows)`);
            }
            const deleted = await inTransaction(hot, async (trx) => {
                await lockRowsById(table, ids, trx);
                if(!sameRows(rows, await loadRowsById(table, ids, trx))) return false;
                await deleteRowsById(table, ids, trx);
                return true;
            });
            if(deleted) moved += ids.length;
            if(rows.length < env.archival.batchSize) break;
        }
        return moved;
    }

    // Both clusters must have identical columns for every archived table, otherwise the copy could
    // drop data. Checked once per region per process; the fix is `npm run migrate:archive`.
    private checkSchema = async (region: string, hot: Knex, archive: Knex): Promise<Record<ArchivedTable, string[]>> => {
        const known = this.columnsByRegion.get(region);
        if(known) return known;
        const tables = [...new Set<ArchivedTable>([...ORDER_TABLES, ...ORDERLESS_TABLES])];
        const columns = {} as Record<ArchivedTable, string[]>;
        for(const table of tables){
            const [hotColumns, archiveColumns] = await Promise.all([tableColumns(table, hot), tableColumns(table, archive)]);
            if([...hotColumns].sort().join(",") !== [...archiveColumns].sort().join(",")){
                throw new ArchiveSchemaMismatchError(`archive table ${table} differs from hot in region "${region}": run npm run migrate:archive`);
            }
            columns[table] = hotColumns;
        }
        this.columnsByRegion.set(region, columns);
        return columns;
    }
}

// explicit transaction, project style (commit / rollback), returning the callback's value
async function inTransaction<T>(conn: Knex, fn: (trx: Knex) => Promise<T>): Promise<T> {
    const trx = await conn.transaction();
    try{
        const result = await fn(trx);
        await trx.commit();
        return result;
    }catch(err){
        await trx.rollback();
        throw err;
    }
}

function inWindow(now: Date): boolean {
    const hour = now.getUTCHours();
    return hour >= env.archival.windowUtc.fromHour && hour < env.archival.windowUtc.toHour;
}

// [min created_at, max created_at + 1 ms): prunes orders / order_items to the batch's partition(s)
function rangeOf(orders: OrderKey[]): TimeRange {
    const times = orders.map((order) => order.createdAt.getTime());
    return {from: new Date(Math.min(...times)), to: new Date(Math.max(...times) + 1)};
}

function monthsOf(orders: OrderKey[]): Date[] {
    const months = new Set(orders.map((order) => Date.UTC(order.createdAt.getUTCFullYear(), order.createdAt.getUTCMonth(), 1)));
    return [...months].map((time) => new Date(time));
}

// same rows, same values: compared as canonical JSON (keys sorted), both lists ordered by id
function sameRows(a: Row[], b: Row[]): boolean {
    if(a.length !== b.length) return false;
    return a.every((row, index) => canonical(row) === canonical(b[index]!));
}

function canonical(value: unknown): string {
    if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if(value !== null && typeof value === "object"){
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
