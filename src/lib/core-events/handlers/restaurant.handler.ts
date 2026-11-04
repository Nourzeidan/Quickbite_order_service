import {cacheProvider} from "../../cache/init.js";
import {CORE_CACHE_KEYS} from "../../core-client/cache-keys.js";

// restaurant.suspended -> new orders are rejected on the next lookup.
// TODO(phase-6): WS alert to admins listing the restaurant's open orders.
export async function handleRestaurantSuspended(payload: unknown): Promise<void> {
    const {restaurantId} = payload as {restaurantId: number};
    if(!Number.isInteger(restaurantId)){
        throw new Error("restaurant event: restaurantId missing");
    }
    await cacheProvider.del(CORE_CACHE_KEYS.restaurant(restaurantId));
}
