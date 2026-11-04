import {registerHandler} from "../consumer.js";
import {handleProductChanged} from "./product.handler.js";
import {handleBranchChanged} from "./branch.handler.js";
import {handleRestaurantSuspended} from "./restaurant.handler.js";
import {handlePermissionsChanged} from "./rbac.handler.js";

// event names = core-service src/lib/events/event-types.ts (also the routing keys)
export function registerCoreEventHandlers() {
    registerHandler("product.price.changed", handleProductChanged);
    registerHandler("product.stock.changed", handleProductChanged);
    registerHandler("branch.updated", handleBranchChanged);
    registerHandler("branch.deactivated", handleBranchChanged);
    registerHandler("restaurant.suspended", handleRestaurantSuspended);
    registerHandler("rbac.permissions_changed", handlePermissionsChanged);
}
