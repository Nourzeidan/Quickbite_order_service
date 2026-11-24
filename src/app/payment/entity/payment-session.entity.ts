import {OPEN_SESSION_STATUSES, PaymentSessionStatus} from "../enums.js";

export class PaymentSession {
    id: number;
    region: string;
    orderId: number;
    orderCreatedAt: Date;
    providerId: number;
    providerSessionId: string;
    merchantOrderRef: string;
    redirectUrl: string;
    amount: number;
    currency: string;
    status: PaymentSessionStatus;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<PaymentSession>){
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.orderCreatedAt = data.orderCreatedAt!;
        this.providerId = data.providerId!;
        this.providerSessionId = data.providerSessionId!;
        this.merchantOrderRef = data.merchantOrderRef!;
        this.redirectUrl = data.redirectUrl!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.status = data.status!;
        this.expiresAt = data.expiresAt!;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
    }

    isOpen(now: Date = new Date()): boolean {
        return OPEN_SESSION_STATUSES.includes(this.status) && this.expiresAt.getTime() > now.getTime();
    }
}
