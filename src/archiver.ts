import "reflect-metadata";
import {container} from "./lib/di/container.js";
import {TOKENS} from "./lib/di/tokens.js";
import {env} from "./lib/config/env.js";
import {logger} from "./lib/logger/logger.js";
import {destroyAll} from "./lib/knex/knex.js";
import {cacheProvider} from "./lib/cache/init.js";
import {startIntervalJob, type IntervalJob} from "./lib/jobs/interval-job.js";
import {MinsToMS} from "./pkg/utils/time.js";
import type {ArchivalService} from "./app/archival/service/archival.service.js";

// The archiver: moves prior-year rows from the hot cluster to the archive cluster of each region
// (docs/business-logic/archival.md). Its own process on purpose — the worker's jobs (offers every
// 10 s, the payment sweep) are short and time-critical; this one is long, heavy and never urgent, so
// it gets its own DB pools and event loop and can never delay an offer.
//
//   npm run archiver        every ARCHIVE_INTERVAL_MIN, works only inside ARCHIVE_WINDOW_UTC
//   npm run archive:once    one pass now, ignoring the window (tests, ops after an outage), then exits
//
// Several archivers are safe: each region is guarded by an advisory lock (the others skip it).
const archival = container.resolve<ArchivalService>(TOKENS.ArchivalService);
const once = process.argv.includes("--once");

let job: IntervalJob | null = null;
let shuttingDown = false;

async function shutdown(code: number) {
    if(shuttingDown) return;
    shuttingDown = true;
    // a batch in flight is cut off at a safe point: every step is a committed transaction, and the
    // next run finishes whatever was copied but not yet deleted
    setTimeout(() => process.exit(1), 10_000).unref();
    job?.stop();
    await destroyAll().catch((err) => logger.warn("db destroy error", {error: (err as Error).message}));
    await cacheProvider.quit().catch(() => {});
    logger.info("archiver stopped");
    process.exit(code);
}

if(once){
    const reports = await archival.run({ignoreWindow: true});
    // one JSON line per region on stdout, so scripts (play/phase5-e2e.ts) can read the result
    for(const report of reports){
        console.log(JSON.stringify({archivalReport: report}));
    }
    await shutdown(reports.length === env.regions.length ? 0 : 1);
}else{
    job = startIntervalJob("archival", MinsToMS(env.archival.intervalMin), async () => {
        await archival.run();
    });
    logger.info("archiver started", {regions: env.regions, intervalMin: env.archival.intervalMin, windowUtc: env.archival.windowUtc});
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
}
