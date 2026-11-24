export const TOKENS = {
    // services (added by module phases)
    OrderService: Symbol.for("OrderService"),
    OrderStatusService: Symbol.for("OrderStatusService"),
    OrderCacheService: Symbol.for("OrderCacheService"),
    OrderPaymentService: Symbol.for("OrderPaymentService"),
    PaymentService: Symbol.for("PaymentService"),
    PaymentLedgerService: Symbol.for("PaymentLedgerService"),
    RefundService: Symbol.for("RefundService"),
    WebhookService: Symbol.for("WebhookService"),
    PaymentSweepService: Symbol.for("PaymentSweepService"),
    OrderDeliveryService: Symbol.for("OrderDeliveryService"),
    PresenceService: Symbol.for("PresenceService"),
    AgentEarningService: Symbol.for("AgentEarningService"),
    AgentService: Symbol.for("AgentService"),
    FinanceService: Symbol.for("FinanceService"),
    DeliveryNotifierService: Symbol.for("DeliveryNotifierService"),
    SettlementService: Symbol.for("SettlementService"),
    DeliveryService: Symbol.for("DeliveryService"),
    OfferService: Symbol.for("OfferService"),
    ArchivalService: Symbol.for("ArchivalService"),

    // controllers (added by module phases)
    OrderController: Symbol.for("OrderController"),
    PaymentController: Symbol.for("PaymentController"),
    WebhookController: Symbol.for("WebhookController"),
    DeliveryController: Symbol.for("DeliveryController"),
    FinanceController: Symbol.for("FinanceController"),

    // payment providers (pkg/payments, instantiated in lib/payments/init.ts)
    PaymentProvider: Symbol.for("PaymentProvider"),

    // Lib/info/
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    WsServer: Symbol.for("WsServer"),       // registered by server.ts once the http server exists
    WsPublisher: Symbol.for("WsPublisher"), // emits after commit; bound to the WsServer by server.ts
    OrderEventsService: Symbol.for("OrderEventsService"),

    // core-client endpoint wrappers + projections
    BranchClient: Symbol.for("BranchClient"),
    RestaurantClient: Symbol.for("RestaurantClient"),
    AddressClient: Symbol.for("AddressClient"),
    ProductClient: Symbol.for("ProductClient"),
    StockClient: Symbol.for("StockClient"),
    PermissionClient: Symbol.for("PermissionClient"),
    UserClient: Symbol.for("UserClient"),
    PermissionCacheService: Symbol.for("PermissionCacheService"),
}
