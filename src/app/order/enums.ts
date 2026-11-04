// values mirror the CHECK constraints in 20261104100100_create_orders_table.ts
export enum OrderStatus {
    PENDING_PAYMENT = "pending_payment",
    PLACED = "placed",
    ACCEPTED = "accepted",
    REJECTED = "rejected",
    PREPARING = "preparing",
    READY = "ready",
    ASSIGNED = "assigned",
    PICKED = "picked",
    DELIVERED = "delivered",
    CANCELLED = "cancelled"
}

export enum PaymentMethod {
    ONLINE = "online",
    COD = "cod"
}

export enum Currency {
    EGP = "EGP",
    SAR = "SAR"
}

// who is moving an order (docs/business-logic/orders.md §1.1)
export enum OrderActor {
    CUSTOMER = "customer",
    RESTAURANT = "restaurant",
    ADMIN = "admin",
    SYSTEM = "system",
    AGENT = "agent"
}

// statuses PATCH /orders/:publicId/status accepts; the rest are written by payments / deliveries
export const PATCHABLE_STATUSES = [
    OrderStatus.ACCEPTED,
    OrderStatus.REJECTED,
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.CANCELLED
] as const;

export type PatchableStatus = (typeof PATCHABLE_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlyArray<OrderStatus> = [
    OrderStatus.DELIVERED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED
];

// cancel_reason written when stock reservation fails after the order was committed
export const CANCEL_REASON_OUT_OF_STOCK = "out_of_stock_post_commit";
// ... and when core could not be reached to reserve it (the request is retryable)
export const CANCEL_REASON_STOCK_RESERVATION_FAILED = "stock_reservation_failed";
