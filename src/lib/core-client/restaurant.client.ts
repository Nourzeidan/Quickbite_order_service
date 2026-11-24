import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {CoreClient} from "./core-client.js";
import type {CoreRestaurant} from "./types.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "./cache-keys.js";
import {CORE_BATCH_MAX_IDS, chunk, readThroughMany} from "./read-through.js";

@injectable()
export class RestaurantClient {
    constructor(
        @inject(TOKENS.CoreClient) private readonly coreClient: CoreClient,
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider
    ){}

    // many restaurants: ONE MGET, then ONE core call (GET /api/internal/restaurants?ids=) per 100 misses
    getRestaurants = async (restaurantIds: number[], correlationId: string): Promise<Map<number, CoreRestaurant>> => {
        return readThroughMany(this.cacheProvider, restaurantIds, CORE_CACHE_KEYS.restaurant, CORE_CACHE_TTL_SEC.restaurant,
            async (missing) => (await Promise.all(chunk(missing, CORE_BATCH_MAX_IDS).map((ids) =>
                this.coreClient.request<CoreRestaurant[]>({method: "GET", path: `/api/internal/restaurants?ids=${ids.join(",")}`, correlationId})
            ))).flat(),
            (restaurant) => restaurant.id);
    }

    // one restaurant = the batch path with one id. null = core says it doesn't exist
    getRestaurant = async (restaurantId: number, correlationId: string): Promise<CoreRestaurant | null> => {
        return (await this.getRestaurants([restaurantId], correlationId)).get(restaurantId) ?? null;
    }
}
