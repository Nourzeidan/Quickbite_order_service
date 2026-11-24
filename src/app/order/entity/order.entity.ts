import {Currency, OrderStatus, PaymentMethod, TERMINAL_STATUSES} from "../enums.js";

export class Order {
    id: number;
    region: string;
    publicId: string;
    countryCode: string;
    restaurantId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressText: string;
    status: OrderStatus;
    cancelReason: string | null;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    commission: number;
    currency: Currency;
    paymentMethod: PaymentMethod;
    deliveryAgentId: number | null;
    pickupLat: number | null;               // branch position snapshotted at placement (Phase 3); null on older orders
    pickupLng: number | null;
    createdAt: Date;
    updatedAt: Date;
    acceptedAt: Date | null;
    rejectedAt: Date | null;
    readyAt: Date | null;
    assignedAt: Date | null;
    pickedAt: Date | null;
    deliveredAt: Date | null;
    cancelledAt: Date | null;

    constructor(data: Partial<Order>){
        this.id = data.id!;
        this.region = data.region!;
        this.publicId = data.publicId!;
        this.countryCode = data.countryCode!;
        this.restaurantId = data.restaurantId!;
        this.branchId = data.branchId!;
        this.customerId = data.customerId!;
        this.customerAddressId = data.customerAddressId!;
        this.deliveryLat = data.deliveryLat!;
        this.deliveryLng = data.deliveryLng!;
        this.deliveryAddressText = data.deliveryAddressText!;
        this.status = data.status!;
        this.cancelReason = data.cancelReason ?? null;
        this.subtotal = data.subtotal!;
        this.deliveryFee = data.deliveryFee!;
        this.serviceFee = data.serviceFee!;
        this.total = data.total!;
        this.commission = data.commission ?? 0;
        this.currency = data.currency!;
        this.paymentMethod = data.paymentMethod!;
        this.deliveryAgentId = data.deliveryAgentId ?? null;
        this.pickupLat = data.pickupLat ?? null;
        this.pickupLng = data.pickupLng ?? null;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
        this.acceptedAt = data.acceptedAt ?? null;
        this.rejectedAt = data.rejectedAt ?? null;
        this.readyAt = data.readyAt ?? null;
        this.assignedAt = data.assignedAt ?? null;
        this.pickedAt = data.pickedAt ?? null;
        this.deliveredAt = data.deliveredAt ?? null;
        this.cancelledAt = data.cancelledAt ?? null;
    }

    isTerminal(): boolean {
        return TERMINAL_STATUSES.includes(this.status);
    }
}
