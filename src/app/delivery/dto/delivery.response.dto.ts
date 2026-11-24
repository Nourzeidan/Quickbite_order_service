import type {Order} from "../../order/entity/order.entity.js";
import {OrderStatus, PaymentMethod} from "../../order/enums.js";
import type {PaymentMethod as PaymentMethodType} from "../../order/enums.js";

// what an agent sees for an order: offers (WS task.offered), available list, tasks, accept response
export class AgentTaskResponseDTO {
    orderPublicId!: string;
    status!: OrderStatus;
    pickup!: {lat: number; lng: number} | null;
    dropoff!: {lat: number; lng: number; addressText: string};
    itemsCount!: number;
    total!: number;
    currency!: string;
    paymentMethod!: PaymentMethodType;
    cashToCollect!: number;             // COD: the total, collected at the door; online: 0
    deliveryFee!: number;
    distanceMeters!: number | null;     // agent -> pickup when known
    assignedAt!: string | null;
    createdAt!: string;

    static from(order: Order, itemsCount: number, pickup: {lat: number; lng: number} | null, distanceMeters: number | null): AgentTaskResponseDTO {
        const dto = new AgentTaskResponseDTO();
        dto.orderPublicId = order.publicId;
        dto.status = order.status;
        dto.pickup = pickup;
        dto.dropoff = {lat: order.deliveryLat, lng: order.deliveryLng, addressText: order.deliveryAddressText};
        dto.itemsCount = itemsCount;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.paymentMethod = order.paymentMethod;
        dto.cashToCollect = order.paymentMethod === PaymentMethod.COD ? order.total : 0;
        dto.deliveryFee = order.deliveryFee;
        dto.distanceMeters = distanceMeters;
        dto.assignedAt = order.assignedAt ? order.assignedAt.toISOString() : null;
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}

export class DeliveryStatusResponseDTO {
    orderPublicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: Order): DeliveryStatusResponseDTO {
        const dto = new DeliveryStatusResponseDTO();
        dto.orderPublicId = order.publicId;
        dto.status = order.status;
        dto.updatedAt = order.updatedAt.toISOString();
        return dto;
    }
}

export class PresenceResponseDTO {
    online!: boolean;

    static from(online: boolean): PresenceResponseDTO {
        const dto = new PresenceResponseDTO();
        dto.online = online;
        return dto;
    }
}

export class AgentEarningItemDTO {
    orderPublicId!: string | null;
    amount!: number;
    currency!: string;
    earnedAt!: string;
}

export class AgentEarningsResponseDTO {
    range!: {from: string; to: string};
    totals!: {count: number; sum: number; currency: string}[];
    items!: AgentEarningItemDTO[];
    nextCursor!: string | null;

    static from(range: {from: Date; to: Date}, totals: {count: number; sum: number; currency: string}[], items: AgentEarningItemDTO[], nextCursor: string | null): AgentEarningsResponseDTO {
        const dto = new AgentEarningsResponseDTO();
        dto.range = {from: range.from.toISOString(), to: range.to.toISOString()};
        dto.totals = totals;
        dto.items = items;
        dto.nextCursor = nextCursor;
        return dto;
    }
}
