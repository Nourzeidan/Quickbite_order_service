import {cacheProvider} from "../../cache/init.js";
import {CORE_CACHE_KEYS} from "../../core-client/cache-keys.js";

// restaurant.suspended -> new orders are rejected on the next lookup.
// No admin WS room exists in this milestone (realtime.md §3): admins see suspended restaurants' open orders via REST.
export async function handleRestaurantSuspended(payload: unknown): Promise<void> {
    const {restaurantId} = payload as {restaurantId: number};
    if(!Number.isInteger(restaurantId)){
        throw new Error("restaurant event: restaurantId missing");
    }
    await cacheProvider.del(CORE_CACHE_KEYS.restaurant(restaurantId));
}
