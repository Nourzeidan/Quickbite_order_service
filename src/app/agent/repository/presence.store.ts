import type {Redis} from "ioredis";

// Agent presence in Redis (deliveries.md §1.4), per region:
//   presence:geo:<region>   GEO         agentId -> last ping position
//   presence:seen:<region>  sorted set  agentId -> last ping time (ms)
// Ephemeral by design: rebuilt by pings, pruned by the worker. Never the source of truth for orders.

const geoKey = (region: string) => `presence:geo:${region}`;
const seenKey = (region: string) => `presence:seen:${region}`;

export interface NearbyAgent {
    agentId: number;
    distanceMeters: number;
}

export async function upsertPresence(redis: Redis, region: string, agentId: number, lat: number, lng: number, nowMs: number): Promise<void> {
    await redis.multi()
        .geoadd(geoKey(region), lng, lat, String(agentId))
        .zadd(seenKey(region), nowMs, String(agentId))
        .exec();
}

export async function removePresence(redis: Redis, region: string, agentIds: number[]): Promise<void> {
    if(agentIds.length === 0) return;
    const members = agentIds.map(String);
    await redis.multi().zrem(geoKey(region), ...members).zrem(seenKey(region), ...members).exec();
}

// last ping time + position of one agent, null if not present
export async function getPresence(redis: Redis, region: string, agentId: number): Promise<{seenAtMs: number; lat: number; lng: number} | null> {
    const [seen, positions] = await Promise.all([
        redis.zscore(seenKey(region), String(agentId)),
        redis.geopos(geoKey(region), String(agentId)),
    ]);
    const position = positions[0];
    if(seen === null || !position){
        return null;
    }
    return {seenAtMs: Number(seen), lng: Number(position[0]), lat: Number(position[1])};
}

// GEOSEARCH from a point, nearest first
export async function searchNearby(redis: Redis, region: string, lat: number, lng: number, radiusMeters: number, count: number): Promise<NearbyAgent[]> {
    const rows = await redis.geosearch(geoKey(region), "FROMLONLAT", lng, lat, "BYRADIUS", radiusMeters, "m", "ASC", "COUNT", count, "WITHDIST") as [string, string][];
    return rows.map(([member, distance]) => ({agentId: Number(member), distanceMeters: Math.round(Number(distance))}));
}

// last ping times for many agents in one call (null = not present)
export async function getSeenTimes(redis: Redis, region: string, agentIds: number[]): Promise<(number | null)[]> {
    if(agentIds.length === 0) return [];
    const scores = await redis.zmscore(seenKey(region), ...agentIds.map(String));
    return scores.map((score) => (score === null ? null : Number(score)));
}

// agents whose last ping is older than the cutoff
export async function findStaleAgents(redis: Redis, region: string, cutoffMs: number): Promise<number[]> {
    const members = await redis.zrangebyscore(seenKey(region), "-inf", `(${cutoffMs}`);
    return members.map(Number);
}

// one GEOSEARCH per point, all in ONE pipeline (one round trip for the whole worker batch)
export async function searchNearbyMany(redis: Redis, region: string, points: {lat: number; lng: number}[], radiusMeters: number, count: number): Promise<NearbyAgent[][]> {
    if(points.length === 0) return [];
    const pipeline = redis.pipeline();
    for(const point of points){
        pipeline.geosearch(geoKey(region), "FROMLONLAT", point.lng, point.lat, "BYRADIUS", radiusMeters, "m", "ASC", "COUNT", count, "WITHDIST");
    }
    const replies = (await pipeline.exec()) ?? [];
    return replies.map(([err, rows]) => {
        if(err) throw err;
        return ((rows ?? []) as [string, string][]).map(([member, distance]) => ({agentId: Number(member), distanceMeters: Math.round(Number(distance))}));
    });
}
