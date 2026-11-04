export const TOKENS = {
    // services (added by module phases)
    OrderService: Symbol.for("OrderService"),
    OrderStatusService: Symbol.for("OrderStatusService"),
    OrderCacheService: Symbol.for("OrderCacheService"),

    // controllers (added by module phases)
    OrderController: Symbol.for("OrderController"),

    // Lib/info/
    Logger: Symbol.for("Logger"),
    CacheProvider: Symbol.for("CacheProvider"),
    MessageBroker: Symbol.for("MessageBroker"),
    CoreClient: Symbol.for("CoreClient"),
    WsServer: Symbol.for("WsServer"),       // registered by server.ts once the http server exists

    // core-client endpoint wrappers + projections
    BranchClient: Symbol.for("BranchClient"),
    RestaurantClient: Symbol.for("RestaurantClient"),
    AddressClient: Symbol.for("AddressClient"),
    ProductClient: Symbol.for("ProductClient"),
    StockClient: Symbol.for("StockClient"),
    PermissionClient: Symbol.for("PermissionClient"),
    PermissionCacheService: Symbol.for("PermissionCacheService"),
}
