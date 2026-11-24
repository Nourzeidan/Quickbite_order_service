import type {PaymentSessionStatus, TransactionMethod, TransactionStatus, TransactionType} from "./enums.js";

// what the payment module needs to know about an order (passed in by the order module, never read from its tables)
export interface PaymentOrderRef {
    id: number;
    createdAt: Date;
    publicId: string;
    region: string;
    customerId: number;
    restaurantId: number;
    total: number;
    currency: string;
}

export interface InsertPaymentSessionInput {
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
    rawInitPayload: Record<string, unknown>;
}

export interface InsertTransactionInput {
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
    refundedPaymentId?: number | null;
    idempotencyKey: string | null;
    note?: string | null;
}

export interface InsertWebhookEventInput {
    region: string;
    providerId: number;
    providerEventId: string;
    signature: string;
    payload: unknown;
}
