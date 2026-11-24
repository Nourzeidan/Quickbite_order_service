import {inject, injectable} from "tsyringe";
import type {Redis} from "ioredis";
import {TOKENS} from "../../../lib/di/tokens.js";
import {logger} from "../../../lib/logger/logger.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import type {RedisCacheProvider} from "../../../pkg/cache/redis.js";
import {addDeclined, addDeclinedMany, addOfferedMany, getOfferState, takeOffered} from "../repository/offer.store.js";

// Offer bookkeeping + the agent-facing task events. No order dependencies, so the order module
// (cancellations) and the delivery services can both use it.
@injectable()
export class DeliveryNotifierService {
    private readonly redis: Redis;

    constructor(
        @inject(TOKENS.CacheProvider) cacheProvider: RedisCacheProvider,
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher
    ){
        this.redis = cacheProvider.getClient();
    }

    offerState = (region: string, publicIds: string[]) => getOfferState(this.redis, region, publicIds)

    // the order left `ready` (accepted by `exceptAgentId`, or cancelled): everyone else loses the offer
    withdrawOffers = async (region: string, publicId: string, reason: string, exceptAgentId: number | null = null) => {
        try{
            const agents = (await takeOffered(this.redis, region, publicId)).filter((id) => id !== exceptAgentId);
            if(agents.length > 0){
                this.ws.publish(agents.map(Rooms.agent), "task.offer_withdrawn", {orderPublicId: publicId, reason});
            }
        }catch(err){
            logger.warn("withdrawing offers failed", {region, orderPublicId: publicId, error: (err as Error).message});
        }
    }

    // never offer this order to this agent again (declined, released, went silent)
    markDeclined = (region: string, publicId: string, agentId: number) => addDeclined(this.redis, region, publicId, agentId)

    markDeclinedMany = (region: string, entries: {publicId: string; agentId: number}[]) => addDeclinedMany(this.redis, region, entries)

    recordOffers = (region: string, entries: {publicId: string; agentIds: number[]}[], ttlSec: number) => addOfferedMany(this.redis, region, entries, ttlSec)

    // the agent's task was taken back or the order cancelled
    taskCancelled = (agentId: number, publicId: string, reason: string) => {
        this.ws.publish([Rooms.agent(agentId)], "task.cancelled", {orderPublicId: publicId, reason});
    }
}
