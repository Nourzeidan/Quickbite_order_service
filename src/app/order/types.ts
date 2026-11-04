import type {Currency, OrderStatus, PaymentMethod} from "./enums.js";

export interface InsertOrderInput {
    region: string;
    publicId: string;               // UUIDv7: created_at is derived from it in the insert
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressText: string;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: Currency;
    paymentMethod: PaymentMethod;
}

export interface InsertOrderItemInput {
    region: string;
    orderId: number;
    orderCreatedAt: Date;
    productId: number;
    quantity: number;
    unitPrice: number;
    name: string;
    imageUrl: string | null;
    lineTotal: number;
}

// an order row is addressed by its full PK (id, created_at) so every statement prunes to one partition
export interface OrderRef {
    id: number;
    createdAt: Date;
}

// [from, to) on created_at
export interface DateRange {
    from: Date;
    to: Date;
}

// keyset position: (created_at, public_id) — public_id breaks created_at ties (same millisecond)
export interface OrderCursor {
    createdAt: Date;
    publicId: string;
}

export interface OrderPage {
    cursor: OrderCursor | null;
    limit: number;
}

export interface OrderListFilter {
    customerId?: number;
    branchId?: number;
    restaurantId?: number;          // residual filter: scopes restaurant users to their restaurant
    status?: OrderStatus;
}

export interface PricedItem {
    productId: number;
    name: string;
    imageUrl: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
}

export interface OrderPricing {
    items: PricedItem[];
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
}
