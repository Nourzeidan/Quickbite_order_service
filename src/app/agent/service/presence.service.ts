import {inject, injectable} from "tsyringe";
import type {Redis} from "ioredis";
import {TOKENS} from "../../../lib/di/tokens.js";
import {env} from "../../../lib/config/env.js";
import type {RedisCacheProvider} from "../../../pkg/cache/redis.js";
import {SecsToMS} from "../../../pkg/utils/time.js";
import {
    findStaleAgents,
    getPresence,
    getSeenTimes,
    removePresence,
    searchNearby,
    searchNearbyMany,
    upsertPresence,
    type NearbyAgent
} from "../repository/presence.store.js";

export interface AgentLocation {
    lat: number;
    lng: number;
    seenAtMs: number;
}

// how many GEOSEARCH hits to look at before filtering (stale / declined / busy / already offered)
const SEARCH_WINDOW = 20;

// Online = present in Redis AND pinged within AGENT_STALE_SEC (the 5-minute cutoff). deliveries.md §1.4
@injectable()
export class PresenceService {
    private readonly redis: Redis;

    constructor(
        @inject(TOKENS.CacheProvider) cacheProvider: RedisCacheProvider
    ){
        this.redis = cacheProvider.getClient();
    }

    private cutoffMs = (now = Date.now()) => now - SecsToMS(env.delivery.agentStaleSec);

    markSeen = (region: string, agentId: number, lat: number, lng: number) =>
        upsertPresence(this.redis, region, agentId, lat, lng, Date.now())

    remove = (region: string, agentId: number) => removePresence(this.redis, region, [agentId])

    // null = offline or stale
    getOnline = async (region: string, agentId: number): Promise<AgentLocation | null> => {
        const presence = await getPresence(this.redis, region, agentId);
        if(!presence || presence.seenAtMs < this.cutoffMs()){
            return null;
        }
        return presence;
    }

    // fresh agents near a point, nearest first (busy / declined filtering is the caller's job)
    findNearbyOnline = async (region: string, lat: number, lng: number): Promise<NearbyAgent[]> => {
        const hits = await searchNearby(this.redis, region, lat, lng, env.delivery.radiusMeters, SEARCH_WINDOW);
        const seen = await getSeenTimes(this.redis, region, hits.map((hit) => hit.agentId));
        const cutoff = this.cutoffMs();
        return hits.filter((_, index) => (seen[index] ?? 0) >= cutoff);
    }

    // fresh agents near MANY points: one pipelined GEOSEARCH round trip + one ZMSCORE for all hits
    findNearbyOnlineMany = async (region: string, points: {lat: number; lng: number}[]): Promise<NearbyAgent[][]> => {
        const perPoint = await searchNearbyMany(this.redis, region, points, env.delivery.radiusMeters, SEARCH_WINDOW);
        const online = await this.filterOnline(region, [...new Set(perPoint.flat().map((hit) => hit.agentId))]);
        return perPoint.map((hits) => hits.filter((hit) => online.has(hit.agentId)));
    }

    // which of these agents are fresh (one call)
    filterOnline = async (region: string, agentIds: number[]): Promise<Set<number>> => {
        const seen = await getSeenTimes(this.redis, region, agentIds);
        const cutoff = this.cutoffMs();
        return new Set(agentIds.filter((_, index) => (seen[index] ?? 0) >= cutoff));
    }

    // worker: drop agents that stopped pinging
    pruneStale = async (region: string): Promise<number> => {
        const stale = await findStaleAgents(this.redis, region, this.cutoffMs());
        await removePresence(this.redis, region, stale);
        return stale.length;
    }
}
