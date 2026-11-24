import "reflect-metadata";
import {Emitter} from "@socket.io/redis-emitter";
import {container} from "./lib/di/container.js";
import {TOKENS} from "./lib/di/tokens.js";
import {env} from "./lib/config/env.js";
import {logger} from "./lib/logger/logger.js";
import {destroyAll} from "./lib/knex/knex.js";
import {cacheProvider} from "./lib/cache/init.js";
import type {WsPublisher} from "./lib/websocket/ws-publisher.js";
import {startIntervalJob} from "./lib/jobs/interval-job.js";
import {startPartitionMaintenance} from "./lib/jobs/partition-maintenance.js";
import {startIdempotencyCleanup} from "./lib/jobs/idempotency-cleanup.js";
import {SecsToMS} from "./pkg/utils/time.js";
import type {OfferService} from "./app/delivery/service/offer.service.js";
import type {PaymentSweepService} from "./app/payment/service/payment-sweep.service.js";

// The worker: every background job, no HTTP server (`npm run worker`).
// Each job is safe with several worker instances (FOR UPDATE SKIP LOCKED, conditional updates,
// advisory locks, Redis sets). WebSocket events go through a Redis emitter into the same channel the
// API's socket.io adapter listens to, so they reach sockets on every API instance.
container.resolve<WsPublisher>(TOKENS.WsPublisher).bind(new Emitter(cacheProvider.getClient()));

const offerService = container.resolve<OfferService>(TOKENS.OfferService);
const paymentSweepService = container.resolve<PaymentSweepService>(TOKENS.PaymentSweepService);

const jobs = [
    // deliveries.md §3: take back stale tasks, offer ready orders to the nearest agents, prune presence
    startIntervalJob("offer-dispatch", SecsToMS(env.delivery.offerIntervalSec), offerService.run),
    // payments.md §5: unpaid online orders -> cancelled; queued / stale refunds
    startIntervalJob("payment-sweep", SecsToMS(env.payments.sweepIntervalSec), paymentSweepService.run),
    // pg_partman without its background worker: premake monthly partitions
    startPartitionMaintenance(),
    // Q-I2
    startIdempotencyCleanup(),
];
logger.info("worker started", {regions: env.regions, offerIntervalSec: env.delivery.offerIntervalSec});

let shuttingDown = false;

async function shutdown() {
    if(shuttingDown) return;
    shuttingDown = true;
    logger.info("worker shutdown requested");
    setTimeout(() => process.exit(1), 10_000).unref();

    for(const job of jobs) job.stop();
    await destroyAll().catch((err) => logger.warn("db destroy error", {error: (err as Error).message}));
    await cacheProvider.quit().catch(() => {});
    logger.info("worker stopped");
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
