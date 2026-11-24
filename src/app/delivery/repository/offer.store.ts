import type {Redis} from "ioredis";

// Offers in Redis (deliveries.md §1.4), per region + order publicId:
//   offers:<region>:<publicId>    set  agents the order is currently offered to   (TTL OFFER_TTL_SEC)
//   declined:<region>:<publicId>  set  agents who declined / released it (never offered again, 24 h)

const offersKey = (region: string, publicId: string) => `offers:${region}:${publicId}`;
const declinedKey = (region: string, publicId: string) => `declined:${region}:${publicId}`;
const DECLINED_TTL_SEC = 24 * 60 * 60;

// members of the offer + declined sets for many orders, one round trip
export async function getOfferState(redis: Redis, region: string, publicIds: string[]): Promise<Map<string, {offered: Set<number>; declined: Set<number>}>> {
    const result = new Map<string, {offered: Set<number>; declined: Set<number>}>();
    if(publicIds.length === 0) return result;
    const pipeline = redis.pipeline();
    for(const publicId of publicIds){
        pipeline.smembers(offersKey(region, publicId));
        pipeline.smembers(declinedKey(region, publicId));
    }
    const replies = (await pipeline.exec()) ?? [];
    publicIds.forEach((publicId, index) => {
        const offered = (replies[index * 2]?.[1] as string[] | undefined) ?? [];
        const declined = (replies[index * 2 + 1]?.[1] as string[] | undefined) ?? [];
        result.set(publicId, {offered: new Set(offered.map(Number)), declined: new Set(declined.map(Number))});
    });
    return result;
}

// add agents to the offer set; the TTL starts with the first offer of a round (NX)
export async function addOffered(redis: Redis, region: string, publicId: string, agentIds: number[], ttlSec: number): Promise<void> {
    if(agentIds.length === 0) return;
    const key = offersKey(region, publicId);
    await redis.multi().sadd(key, ...agentIds.map(String)).expire(key, ttlSec, "NX").exec();
}

// read and clear the offer set (an agent accepted / the order left `ready`)
export async function takeOffered(redis: Redis, region: string, publicId: string): Promise<number[]> {
    const key = offersKey(region, publicId);
    const [members] = (await redis.multi().smembers(key).del(key).exec()) ?? [];
    return ((members?.[1] as string[] | undefined) ?? []).map(Number);
}

export async function addDeclined(redis: Redis, region: string, publicId: string, agentId: number): Promise<void> {
    const key = declinedKey(region, publicId);
    await redis.multi().sadd(key, String(agentId)).expire(key, DECLINED_TTL_SEC).srem(offersKey(region, publicId), String(agentId)).exec();
}

// offers of a whole worker batch in ONE MULTI (not a round trip per order)
export async function addOfferedMany(redis: Redis, region: string, entries: {publicId: string; agentIds: number[]}[], ttlSec: number): Promise<void> {
    const multi = redis.multi();
    let commands = 0;
    for(const {publicId, agentIds} of entries){
        if(agentIds.length === 0) continue;
        const key = offersKey(region, publicId);
        multi.sadd(key, ...agentIds.map(String)).expire(key, ttlSec, "NX");
        commands++;
    }
    if(commands > 0) await multi.exec();
}

// many (order, agent) declines in ONE MULTI
export async function addDeclinedMany(redis: Redis, region: string, entries: {publicId: string; agentId: number}[]): Promise<void> {
    if(entries.length === 0) return;
    const multi = redis.multi();
    for(const {publicId, agentId} of entries){
        const key = declinedKey(region, publicId);
        multi.sadd(key, String(agentId)).expire(key, DECLINED_TTL_SEC).srem(offersKey(region, publicId), String(agentId));
    }
    await multi.exec();
}
