import type {Order} from "../entity/order.entity.js";
import type {OrderItem} from "../entity/order-item.entity.js";
import {Currency, OrderStatus, PaymentMethod} from "../enums.js";

export class OrderItemResponseDTO {
    productId!: number;
    name!: string;
    imageUrl!: string | null;
    quantity!: number;
    unitPrice!: number;
    lineTotal!: number;

    static from(item: OrderItem): OrderItemResponseDTO {
        const dto = new OrderItemResponseDTO();
        dto.productId = item.productId;
        dto.name = item.name;
        dto.imageUrl = item.imageUrl;
        dto.quantity = item.quantity;
        dto.unitPrice = item.unitPrice;
        dto.lineTotal = item.lineTotal;
        return dto;
    }
}

export class OrderResponseDTO {
    publicId!: string;
    region!: string;
    status!: OrderStatus;
    paymentMethod!: PaymentMethod;
    restaurantId!: number;
    branchId!: number;
    deliveryAddress!: {lat: number; lng: number; addressText: string};
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: Currency;
    items!: OrderItemResponseDTO[];
    createdAt!: string;

    static from(order: Order, items: OrderItem[]): OrderResponseDTO {
        const dto = new OrderResponseDTO();
        OrderResponseDTO.fill(dto, order, items);
        return dto;
    }

    protected static fill(dto: OrderResponseDTO, order: Order, items: OrderItem[]) {
        dto.publicId = order.publicId;
        dto.region = order.region;
        dto.status = order.status;
        dto.paymentMethod = order.paymentMethod;
        dto.restaurantId = order.restaurantId;
        dto.branchId = order.branchId;
        dto.deliveryAddress = {lat: order.deliveryLat, lng: order.deliveryLng, addressText: order.deliveryAddressText};
        dto.subtotal = order.subtotal;
        dto.deliveryFee = order.deliveryFee;
        dto.serviceFee = order.serviceFee;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.items = items.map((item) => OrderItemResponseDTO.from(item));
        dto.createdAt = order.createdAt.toISOString();
    }
}

export type PaymentSummaryStatus = "pending" | "succeeded" | "failed" | "refunded" | "partially_refunded";

export interface PaymentSummary {
    method: PaymentMethod;
    status: PaymentSummaryStatus;
    amount: number;
    refundedAmount: number;
    currency: Currency;
}

export interface OrderTimeline {
    acceptedAt?: string;
    rejectedAt?: string;
    readyAt?: string;
    assignedAt?: string;
    pickedAt?: string;
    deliveredAt?: string;
    cancelledAt?: string;
}

// DeliverySummaryResponseDTO lands with Phase 3 (deliveries); until then delivery is always null
export class OrderDetailResponseDTO extends OrderResponseDTO {
    delivery!: null;
    paymentSummary!: PaymentSummary;
    timeline!: OrderTimeline;
    cancelReason!: string | null;

    static fromDetail(order: Order, items: OrderItem[], paymentSummary: PaymentSummary): OrderDetailResponseDTO {
        const dto = new OrderDetailResponseDTO();
        OrderResponseDTO.fill(dto, order, items);
        dto.delivery = null;
        dto.paymentSummary = paymentSummary;
        dto.timeline = buildTimeline(order);
        dto.cancelReason = order.cancelReason;
        return dto;
    }
}

function buildTimeline(order: Order): OrderTimeline {
    const timeline: OrderTimeline = {};
    if(order.acceptedAt) timeline.acceptedAt = order.acceptedAt.toISOString();
    if(order.rejectedAt) timeline.rejectedAt = order.rejectedAt.toISOString();
    if(order.readyAt) timeline.readyAt = order.readyAt.toISOString();
    if(order.assignedAt) timeline.assignedAt = order.assignedAt.toISOString();
    if(order.pickedAt) timeline.pickedAt = order.pickedAt.toISOString();
    if(order.deliveredAt) timeline.deliveredAt = order.deliveredAt.toISOString();
    if(order.cancelledAt) timeline.cancelledAt = order.cancelledAt.toISOString();
    return timeline;
}

export class OrderSummaryResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    total!: number;
    currency!: Currency;
    itemsCount!: number;
    restaurantId!: number;
    branchId!: number;
    createdAt!: string;

    static from(order: Order, itemsCount: number): OrderSummaryResponseDTO {
        const dto = new OrderSummaryResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.itemsCount = itemsCount;
        dto.restaurantId = order.restaurantId;
        dto.branchId = order.branchId;
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}

export class OrderStatusResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: Order): OrderStatusResponseDTO {
        const dto = new OrderStatusResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.updatedAt = order.updatedAt.toISOString();
        return dto;
    }
}
