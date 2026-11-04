import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreRestaurant} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {isNotFound, readThrough} from "./read-through.js";

@injectable()
export class RestaurantClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    getRestaurant = async (restaurantId: number, correlationId: string): Promise<CoreRestaurant | null> => {
        return readThrough(this.cacheProvider, CORE_CACHE_KEYS.restaurant(restaurantId), CORE_CACHE_TTL_SEC.restaurant, async () => {
            try{
                return await this.coreClient.request<CoreRestaurant>({method: "GET", path: `/api/internal/restaurants/${restaurantId}`, correlationId});
            }catch(err){
                if(isNotFound(err)) return null;
                throw err;
            }
        });
    }
}
