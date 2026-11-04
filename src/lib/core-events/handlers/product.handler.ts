import {cacheProvider} from "../../cache/init.js";
import {CORE_CACHE_KEYS} from "../../core-client/cache-keys.js";

interface ProductEventPayload {
    branchId: number;
    productId: number;
}

// product.price.changed / product.stock.changed -> drop the cached branch product (integrations §3.4)
export async function handleProductChanged(payload: unknown): Promise<void> {
    const {branchId, productId} = payload as ProductEventPayload;
    if(!Number.isInteger(branchId) || !Number.isInteger(productId)){
        throw new Error("product event: branchId / productId missing");
    }
    await cacheProvider.del(CORE_CACHE_KEYS.product(branchId, productId));
}
