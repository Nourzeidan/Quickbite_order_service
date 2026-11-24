import {inject, injectable} from "tsyringe";
import {v4 as uuidv4} from "uuid";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import type {Order} from "../../order/entity/order.entity.js";
import type {OrderDeliveryService} from "../../order/service/order-delivery.service.js";
import type {PresenceService} from "../../agent/service/presence.service.js";
import type {NearbyAgent} from "../../agent/repository/presence.store.js";
import {AgentTaskResponseDTO} from "../dto/delivery.response.dto.js";
import type {DeliveryNotifierService} from "./delivery-notifier.service.js";

// deliveries.md §3 — the job the worker runs every OFFER_INTERVAL_SEC on every shard.
// Nothing here assigns an order: it only takes back tasks from silent agents and OFFERS ready orders;
// the agent decides (POST /deliveries/:id/accept). Safe with several workers: conditional updates,
// Redis sets, and an agent seeing the same offer twice is harmless (the app dedupes by orderPublicId).
@injectable()
export class OfferService {
    constructor(
        @inject(TOKENS.OrderDeliveryService) private readonly orders: OrderDeliveryService,
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.DeliveryNotifierService) private readonly notifier: DeliveryNotifierService,
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher
    ){}

    run = async () => {
        for(const region of env.regions){
            const correlationId = `offer-worker:${uuidv4()}`;
            // one shard (or one step) failing must not stop the others
            for(const [step, fn] of [
                ["take back stale tasks", () => this.takeBackStale(region, correlationId)],
                ["offer ready orders", () => this.offerReady(region, correlationId)],
                ["prune presence", () => this.presence.pruneStale(region)],
            ] as const){
                try{
                    await fn();
                }catch(err){
                    logger.error("offer worker step failed", {region, step, correlationId, error: (err as Error).message});
                }
            }
        }
    }

    // 1. assigned orders whose agent stopped pinging -> back to ready, offered to someone else.
    // Whole batch: one presence check, ONE UPDATE, one Redis MULTI, one cache DEL.
    takeBackStale = async (region: string, correlationId: string): Promise<number> => {
        const conn = db(region);
        const assigned = await this.orders.listAssigned(env.delivery.offerBatch, conn);
        const agentIds = [...new Set(assigned.map((order) => order.deliveryAgentId).filter((id): id is number => id !== null))];
        const online = await this.presence.filterOnline(region, agentIds);
        const stale = assigned.filter((order) => order.deliveryAgentId !== null && !online.has(order.deliveryAgentId));
        if(stale.length === 0){
            return 0;
        }
        const heldBy = new Map(stale.map((order) => [order.id, order.deliveryAgentId!]));

        let released: Order[];
        const trx = await conn.transaction();
        try{
            released = await this.orders.releaseMany(stale, trx);
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }

        await this.notifier.markDeclinedMany(region, released.map((order) => ({publicId: order.publicId, agentId: heldBy.get(order.id)!})));
        for(const order of released){
            this.notifier.taskCancelled(heldBy.get(order.id)!, order.publicId, "agent went offline");
        }
        await this.orders.afterChangeMany(released);
        if(released.length > 0) logger.info("stale tasks taken back", {region, count: released.length, correlationId});
        return released.length;
    }

    // 2. offer each ready order to the nearest OFFER_TOP_N eligible agents who don't have it yet.
    // Per tick, not per order: 1 query for the orders, 1 for busy agents, 1 for item counts,
    // 1 pipelined GEOSEARCH round trip, 1 ZMSCORE, 1 offer-state read, 1 offer write.
    offerReady = async (region: string, correlationId: string): Promise<number> => {
        const conn = db(region);
        const ready = await this.orders.listReadyUnassigned(env.delivery.offerBatch, conn);
        if(ready.length === 0){
            return 0;
        }
        const pickups = await this.orders.pickupOf(ready, correlationId);
        const located = ready.filter((order) => pickups.has(order.id));
        const [state, nearbyPerOrder] = await Promise.all([
            this.notifier.offerState(region, located.map((order) => order.publicId)),
            this.presence.findNearbyOnlineMany(region, located.map((order) => pickups.get(order.id)!)),
        ]);

        const candidates = new Map<number, NearbyAgent[]>();
        located.forEach((order, index) => {
            const {offered, declined} = state.get(order.publicId)!;
            candidates.set(order.id, nearbyPerOrder[index]!.filter((agent) => !offered.has(agent.agentId) && !declined.has(agent.agentId)));
        });

        // busy agents: ONE query for every candidate of the tick (Q-O6)
        const allIds = [...new Set([...candidates.values()].flat().map((agent) => agent.agentId))];
        const busy = new Set((await this.orders.findActiveByAgents(allIds, conn)).map((order) => order.deliveryAgentId!));

        const offers = located
            .map((order) => ({order, chosen: candidates.get(order.id)!.filter((agent) => !busy.has(agent.agentId)).slice(0, env.delivery.offerTopN)}))
            .filter(({chosen}) => chosen.length > 0);
        if(offers.length === 0){
            return 0;
        }
        const counts = await this.orders.countItems(offers.map(({order}) => order), conn);
        await this.notifier.recordOffers(region, offers.map(({order, chosen}) => ({publicId: order.publicId, agentIds: chosen.map((agent) => agent.agentId)})), env.delivery.offerTtlSec);

        let sent = 0;
        for(const {order, chosen} of offers){
            const pickup = pickups.get(order.id) ?? null;
            for(const agent of chosen){
                this.ws.publish([Rooms.agent(agent.agentId)], "task.offered",
                    AgentTaskResponseDTO.from(order, counts.get(order.id) ?? 0, pickup, agent.distanceMeters));
                sent++;
            }
        }
        logger.info("offers sent", {region, orders: offers.length, offers: sent, correlationId});
        return sent;
    }
}
