import type {ConsumeMessage, ConsumerOptions, IMessageBroker} from "../../pkg/messaging/message-broker.interface.js";
import {env} from "../config/env.js";
import {logger} from "../logger/logger.js";
import {cacheProvider} from "../cache/init.js";
import type {CoreEventEnvelope, CoreEventHandler} from "./types.js";

// redelivery window (consumer restart, nack, DLQ replay). Safe to expire: every handler
// is an idempotent cache invalidation, so re-running one is harmless.
const DEDUPE_TTL_SEC = 24 * 60 * 60;

const handlers = new Map<string, CoreEventHandler>();

// modules register their handlers at boot (Phase 1+), e.g. registerHandler("product.price.changed", ...)
export function registerHandler(eventType: string, handler: CoreEventHandler) {
    if(handlers.has(eventType)){
        throw new Error(`Handler already registered for ${eventType}`);
    }
    handlers.set(eventType, handler);
}

export function listRegisteredHandlers(): string[] {
    return [...handlers.keys()];
}

const topology: ConsumerOptions = {
    exchange: env.rabbit.exchange,
    queue: env.rabbit.queue,
    bindingKeys: env.rabbit.bindings,
    deadLetterExchange: env.rabbit.dlx,
    deadLetterQueue: env.rabbit.dlq,
    prefetch: env.rabbit.prefetch,
};

export async function startCoreEventsConsumer(broker: IMessageBroker): Promise<void> {
    await broker.declareTopology(topology);
    await broker.consume(topology, handleMessage);
    logger.info("core-events consumer started", {queue: topology.queue, bindings: topology.bindingKeys});
}

async function handleMessage(msg: ConsumeMessage): Promise<void> {
    const envelope = parseEnvelope(msg);
    if(!envelope){
        logger.error("core-events: malformed message, sending to DLQ", {routingKey: msg.routingKey});
        return msg.nack(false);
    }

    const handler = handlers.get(envelope.eventType);
    if(!handler){
        // unknown types are not poison: ack so they don't pile up in the DLQ
        logger.warn("core-events: no handler, acking", {eventType: envelope.eventType, eventId: envelope.eventId});
        return msg.ack();
    }

    const dedupeKey = `core-events:dedupe:${envelope.eventId}`;
    let fresh = true;
    try{
        fresh = await cacheProvider.trySet(dedupeKey, "1", DEDUPE_TTL_SEC);
    }catch(err){
        // Redis down: run the handler anyway (idempotent) instead of dead-lettering every event
        logger.warn("core-events: dedupe unavailable, processing anyway", {eventId: envelope.eventId, error: (err as Error).message});
    }
    if(!fresh){
        return msg.ack();
    }

    try{
        await handler(envelope.payload);
        msg.ack();
    }catch(err){
        logger.error("core-events: handler failed, sending to DLQ", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
            error: (err as Error).message,
        });
        // let a manual DLQ replay run the handler again
        await cacheProvider.del(dedupeKey).catch(() => {});
        msg.nack(false);
    }
}

function parseEnvelope(msg: ConsumeMessage): CoreEventEnvelope | null {
    try{
        const envelope = JSON.parse(msg.body.toString("utf8")) as Partial<CoreEventEnvelope>;
        if(typeof envelope.eventId !== "string" || typeof envelope.eventType !== "string"){
            return null;
        }
        return envelope as CoreEventEnvelope;
    }catch{
        return null;
    }
}
