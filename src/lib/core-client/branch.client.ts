import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreBranch} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {isNotFound, readThrough} from "./read-through.js";

@injectable()
export class BranchClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    // null = core says the branch doesn't exist
    getBranch = async (branchId: number, correlationId: string): Promise<CoreBranch | null> => {
        return readThrough(this.cacheProvider, CORE_CACHE_KEYS.branch(branchId), CORE_CACHE_TTL_SEC.branch, async () => {
            try{
                return await this.coreClient.request<CoreBranch>({method: "GET", path: `/api/internal/branches/${branchId}`, correlationId});
            }catch(err){
                if(isNotFound(err)) return null;
                throw err;
            }
        });
    }
}
