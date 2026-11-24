import "reflect-metadata";
import http from "http";
import {container} from "./lib/di/container.js";
import {TOKENS} from "./lib/di/tokens.js";
import {createApp} from "./app.js";
import {env} from "./lib/config/env.js";
import {logger} from "./lib/logger/logger.js";
import {destroyAll, pingAll} from "./lib/knex/knex.js";
import {cacheProvider} from "./lib/cache/init.js";
import {messageBroker} from "./lib/messaging/init.js";
import {startCoreEventsConsumer} from "./lib/core-events/consumer.js";
import {attachWsServer} from "./lib/websocket/ws-server.js";
import type {WsPublisher} from "./lib/websocket/ws-publisher.js";
import {registerCoreEventHandlers} from "./lib/core-events/handlers/index.js";

const app = createApp();
const server = http.createServer(app);

const io = attachWsServer(server);
container.registerInstance(TOKENS.WsServer, io);
container.resolve<WsPublisher>(TOKENS.WsPublisher).bind(io);

registerCoreEventHandlers();

// background jobs (offers, sweeps, partitions, cleanup) run in the worker process: src/worker.ts

server.listen(env.port, async () => {
    logger.info(`order-service listening on ${env.port}`, {regions: env.regions});

    // non-fatal: a down shard only affects its region
    for(const shard of await pingAll()){
        if(shard.ok) logger.info("shard reachable", {region: shard.region});
        else logger.warn("shard unreachable", {region: shard.region, error: shard.error});
    }

    // the broker client keeps reconnecting in the background; the consumer re-attaches by itself
    startCoreEventsConsumer(messageBroker).catch((err) => {
        logger.error("core-events consumer failed to start", {error: (err as Error).message});
    });
});

let shuttingDown = false;

async function shutdown() {
    if(shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown requested");

    // force exit if something hangs
    setTimeout(() => process.exit(1), 10_000).unref();

    // io.close() also closes the http server
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await messageBroker.close().catch((err) => logger.warn("broker close error", {error: (err as Error).message}));
    await destroyAll().catch((err) => logger.warn("db destroy error", {error: (err as Error).message}));
    await cacheProvider.quit().catch(() => {});
    logger.info("server closed");
    process.exit(0);
}

// ctrl c
process.on("SIGINT", shutdown);
// devops (kubernetes/docker)
process.on("SIGTERM", shutdown);
