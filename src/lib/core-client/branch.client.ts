import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreBranch} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {CORE_BATCH_MAX_IDS, chunk, readThroughMany} from "./read-through.js";

@injectable()
export class BranchClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    // many branches: ONE MGET, then ONE core call (GET /api/internal/branches?ids=) per 100 misses.
    // ids core doesn't know are absent from the map.
    getBranches = async (branchIds: number[], correlationId: string): Promise<Map<number, CoreBranch>> => {
        return readThroughMany(this.cacheProvider, branchIds, CORE_CACHE_KEYS.branch, CORE_CACHE_TTL_SEC.branch,
            async (missing) => (await Promise.all(chunk(missing, CORE_BATCH_MAX_IDS).map((ids) =>
                this.coreClient.request<CoreBranch[]>({method: "GET", path: `/api/internal/branches?ids=${ids.join(",")}`, correlationId})
            ))).flat(),
            (branch) => branch.id);
    }

    // one branch = the batch path with one id. null = core says it doesn't exist
    getBranch = async (branchId: number, correlationId: string): Promise<CoreBranch | null> => {
        return (await this.getBranches([branchId], correlationId)).get(branchId) ?? null;
    }
}
