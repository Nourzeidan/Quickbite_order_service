import "reflect-metadata";
import {container} from "tsyringe";
import {TOKENS} from "./tokens.js";

// Lib / Info
import {Logger} from "../logger/logger.js";
import {cacheProvider} from "../cache/init.js";
import {messageBroker} from "../messaging/init.js";
import {coreClient} from "../core-client/core-client.js";
import {BranchClient} from "../core-client/branch.client.js";
import {RestaurantClient} from "../core-client/restaurant.client.js";
import {AddressClient} from "../core-client/address.client.js";
import {ProductClient} from "../core-client/product.client.js";
import {StockClient} from "../core-client/stock.client.js";
import {PermissionClient} from "../core-client/permission.client.js";
import {PermissionCacheService} from "../auth/permission-cache.service.js";

// Order (Phase 1)
import {OrderService} from "../../app/order/service/order.service.js";
import {OrderStatusService} from "../../app/order/service/order-status.service.js";
import {OrderCacheService} from "../../app/order/service/order-cache.service.js";
import {OrderController} from "../../app/order/controller/order.controller.js";

// Register Lib
container.registerSingleton<Logger>(TOKENS.Logger, Logger);
container.registerInstance(TOKENS.CacheProvider, cacheProvider);
container.registerInstance(TOKENS.MessageBroker, messageBroker);
container.registerInstance(TOKENS.CoreClient, coreClient);
container.registerSingleton<BranchClient>(TOKENS.BranchClient, BranchClient);
container.registerSingleton<RestaurantClient>(TOKENS.RestaurantClient, RestaurantClient);
container.registerSingleton<AddressClient>(TOKENS.AddressClient, AddressClient);
container.registerSingleton<ProductClient>(TOKENS.ProductClient, ProductClient);
container.registerSingleton<StockClient>(TOKENS.StockClient, StockClient);
container.registerSingleton<PermissionClient>(TOKENS.PermissionClient, PermissionClient);
container.registerSingleton<PermissionCacheService>(TOKENS.PermissionCacheService, PermissionCacheService);

// Register Services
container.registerSingleton<OrderCacheService>(TOKENS.OrderCacheService, OrderCacheService);
container.registerSingleton<OrderStatusService>(TOKENS.OrderStatusService, OrderStatusService);
container.registerSingleton<OrderService>(TOKENS.OrderService, OrderService);

// Register Controllers
container.registerSingleton<OrderController>(TOKENS.OrderController, OrderController);

export {container};
