import type {TransactionMethod, TransactionStatus, TransactionType} from "../enums.js";

export class Transaction {
    id: number;
    region: string;
    orderId: number | null;
    orderCreatedAt: Date | null;
    type: TransactionType;
    method: TransactionMethod;
    providerId: number | null;
    providerReferenceId: string | null;
    status: TransactionStatus;
    amount: number;
    currency: string;
    srcAccId: number | null;
    dstAccId: number | null;
    isRefunded: boolean;
    refundedPaymentId: number | null;
    idempotencyKey: string | null;
    note: string | null;
    providerRequestedAt: Date | null;       // refund: sent to the provider at (null = queued, not sent yet)
    createdAt: Date;
    updatedAt: Date;

    constructor(data: Partial<Transaction>){
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId ?? null;
        this.orderCreatedAt = data.orderCreatedAt ?? null;
        this.type = data.type!;
        this.method = data.method!;
        this.providerId = data.providerId ?? null;
        this.providerReferenceId = data.providerReferenceId ?? null;
        this.status = data.status!;
        this.amount = data.amount!;
        this.currency = data.currency!;
        this.srcAccId = data.srcAccId ?? null;
        this.dstAccId = data.dstAccId ?? null;
        this.isRefunded = data.isRefunded ?? false;
        this.refundedPaymentId = data.refundedPaymentId ?? null;
        this.idempotencyKey = data.idempotencyKey ?? null;
        this.note = data.note ?? null;
        this.providerRequestedAt = data.providerRequestedAt ?? null;
        this.createdAt = data.createdAt!;
        this.updatedAt = data.updatedAt!;
    }
}
