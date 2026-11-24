import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreUserContact} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {CORE_BATCH_MAX_IDS, chunk, readThroughMany} from "./read-through.js";
import {logger} from "../logger/logger.js";

// agent name / phone for delivery events and DTOs
@injectable()
export class UserClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    // many users: ONE MGET, then ONE core call (GET /api/internal/users?ids=) per 100 misses
    getUsers = async (userIds: number[], correlationId: string): Promise<Map<number, CoreUserContact>> => {
        return readThroughMany(this.cacheProvider, userIds, CORE_CACHE_KEYS.user, CORE_CACHE_TTL_SEC.user,
            async (missing) => (await Promise.all(chunk(missing, CORE_BATCH_MAX_IDS).map((ids) =>
                this.coreClient.request<CoreUserContact[]>({method: "GET", path: `/api/internal/users?ids=${ids.join(",")}`, correlationId})
            ))).flat(),
            (user) => user.id);
    }

    // never fails a delivery action: a missing name just shows as unknown
    getUserSafe = async (userId: number, correlationId: string): Promise<CoreUserContact | null> => {
        try{
            return (await this.getUsers([userId], correlationId)).get(userId) ?? null;
        }catch(err){
            logger.warn("agent lookup failed", {userId, correlationId, error: (err as Error).message});
            return null;
        }
    }
}
