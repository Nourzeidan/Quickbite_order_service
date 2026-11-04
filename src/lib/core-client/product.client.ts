import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreBranchProduct} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {logger} from "../logger/logger.js";

@injectable()
export class ProductClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    // one MGET for the cart, then ONE batch call to core for the misses.
    // products core doesn't know are simply absent from the result.
    getBranchProducts = async (branchId: number, productIds: number[], correlationId: string): Promise<CoreBranchProduct[]> => {
        const keys = productIds.map((productId) => CORE_CACHE_KEYS.product(branchId, productId));
        const found: CoreBranchProduct[] = [];
        let missing = productIds;

        try{
            const cached = await this.cacheProvider.getMany(keys);
            missing = [];
            cached.forEach((value, index) => {
                if(value) found.push(JSON.parse(value) as CoreBranchProduct);
                else missing.push(productIds[index]!);
            });
        }catch(err){
            logger.warn("core cache read failed", {branchId, error: (err as Error).message});
        }

        if(missing.length === 0){
            return found;
        }

        const fetched = await this.coreClient.request<CoreBranchProduct[]>({
            method: "POST",
            path: `/api/internal/branches/${branchId}/products/batch`,
            body: {productIds: missing},
            correlationId,
            // read-only POST: safe to retry
            idempotencyKey: `products-batch:${branchId}:${missing.join(",")}`,
        });

        for(const product of fetched){
            this.cacheProvider.set(CORE_CACHE_KEYS.product(branchId, product.productId), JSON.stringify(product), CORE_CACHE_TTL_SEC.product)
                .catch(() => {});
        }
        return [...found, ...fetched];
    }
}
