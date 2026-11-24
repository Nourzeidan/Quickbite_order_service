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
import {UserClient} from "../core-client/user.client.js";
import {PermissionCacheService} from "../auth/permission-cache.service.js";
import {kashierProvider} from "../payments/init.js";
import {WsPublisher} from "../websocket/ws-publisher.js";

// Order (Phase 1)
import {OrderService} from "../../app/order/service/order.service.js";
import {OrderStatusService} from "../../app/order/service/order-status.service.js";
import {OrderCacheService} from "../../app/order/service/order-cache.service.js";
import {OrderPaymentService} from "../../app/order/service/order-payment.service.js";
import {OrderEventsService} from "../../app/order/service/order-events.service.js";
import {OrderController} from "../../app/order/controller/order.controller.js";

// Payment (Phase 2)
import {PaymentLedgerService} from "../../app/payment/service/payment-ledger.service.js";
import {RefundService} from "../../app/payment/service/refund.service.js";
import {PaymentService} from "../../app/payment/service/payment.service.js";
import {WebhookService} from "../../app/payment/service/webhook.service.js";
import {PaymentSweepService} from "../../app/payment/service/payment-sweep.service.js";
import {PaymentController} from "../../app/payment/controller/payment.controller.js";
import {WebhookController} from "../../app/payment/controller/webhook.controller.js";

// Deliveries & agents (Phase 3)
import {OrderDeliveryService} from "../../app/order/service/order-delivery.service.js";
import {PresenceService} from "../../app/agent/service/presence.service.js";
import {AgentEarningService} from "../../app/agent/service/agent-earning.service.js";
import {AgentService} from "../../app/agent/service/agent.service.js";
import {FinanceService} from "../../app/restaurant-finance/service/finance.service.js";
import {FinanceController} from "../../app/restaurant-finance/controller/finance.controller.js";
import {DeliveryNotifierService} from "../../app/delivery/service/delivery-notifier.service.js";
import {SettlementService} from "../../app/delivery/service/settlement.service.js";
import {DeliveryService} from "../../app/delivery/service/delivery.service.js";
import {OfferService} from "../../app/delivery/service/offer.service.js";
import {DeliveryController} from "../../app/delivery/controller/delivery.controller.js";

// Register Lib

// Archival (Phase 5) — used by the archiver process (src/archiver.ts)
import {ArchivalService} from "../../app/archival/service/archival.service.js";

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
container.registerSingleton<UserClient>(TOKENS.UserClient, UserClient);
container.registerSingleton<PermissionCacheService>(TOKENS.PermissionCacheService, PermissionCacheService);
container.registerInstance(TOKENS.PaymentProvider, kashierProvider);
container.registerInstance(TOKENS.WsPublisher, new WsPublisher());

// Register Services (dependency order: payment ledger/refunds <- order <- payment init/webhook/sweep)
container.registerSingleton<PaymentLedgerService>(TOKENS.PaymentLedgerService, PaymentLedgerService);
container.registerSingleton<RefundService>(TOKENS.RefundService, RefundService);
container.registerSingleton<OrderCacheService>(TOKENS.OrderCacheService, OrderCacheService);
container.registerSingleton<OrderEventsService>(TOKENS.OrderEventsService, OrderEventsService);
container.registerSingleton<OrderStatusService>(TOKENS.OrderStatusService, OrderStatusService);
container.registerSingleton<OrderService>(TOKENS.OrderService, OrderService);
container.registerSingleton<OrderPaymentService>(TOKENS.OrderPaymentService, OrderPaymentService);
container.registerSingleton<PaymentService>(TOKENS.PaymentService, PaymentService);
container.registerSingleton<WebhookService>(TOKENS.WebhookService, WebhookService);
container.registerSingleton<PaymentSweepService>(TOKENS.PaymentSweepService, PaymentSweepService);
container.registerSingleton<DeliveryNotifierService>(TOKENS.DeliveryNotifierService, DeliveryNotifierService);
container.registerSingleton<PresenceService>(TOKENS.PresenceService, PresenceService);
container.registerSingleton<AgentEarningService>(TOKENS.AgentEarningService, AgentEarningService);
container.registerSingleton<FinanceService>(TOKENS.FinanceService, FinanceService);
container.registerSingleton<OrderDeliveryService>(TOKENS.OrderDeliveryService, OrderDeliveryService);
container.registerSingleton<SettlementService>(TOKENS.SettlementService, SettlementService);
container.registerSingleton<DeliveryService>(TOKENS.DeliveryService, DeliveryService);
container.registerSingleton<OfferService>(TOKENS.OfferService, OfferService);
container.registerSingleton<AgentService>(TOKENS.AgentService, AgentService);
container.registerSingleton<ArchivalService>(TOKENS.ArchivalService, ArchivalService);

// Register Controllers
container.registerSingleton<OrderController>(TOKENS.OrderController, OrderController);
container.registerSingleton<PaymentController>(TOKENS.PaymentController, PaymentController);
container.registerSingleton<WebhookController>(TOKENS.WebhookController, WebhookController);
container.registerSingleton<DeliveryController>(TOKENS.DeliveryController, DeliveryController);
container.registerSingleton<FinanceController>(TOKENS.FinanceController, FinanceController);

export {container};
