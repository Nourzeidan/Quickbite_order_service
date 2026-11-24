import type {PaymentSession} from "../entity/payment-session.entity.js";
import type {Transaction} from "../entity/transaction.entity.js";
import {PROVIDER_NAMES, type TransactionMethod, type TransactionStatus, type TransactionType} from "../enums.js";

export class PaymentInitResponseDTO {
    sessionId!: number;
    providerSessionId!: string;
    redirectUrl!: string;
    expiresAt!: string;
    amount!: number;
    currency!: string;

    static from(session: PaymentSession): PaymentInitResponseDTO {
        const dto = new PaymentInitResponseDTO();
        dto.sessionId = session.id;
        dto.providerSessionId = session.providerSessionId;
        dto.redirectUrl = session.redirectUrl;
        dto.expiresAt = session.expiresAt.toISOString();
        dto.amount = session.amount;
        dto.currency = session.currency;
        return dto;
    }
}

export class PaymentResponseDTO {
    id!: number;
    orderPublicId!: string | null;
    type!: TransactionType;
    method!: TransactionMethod;
    provider!: "kashier" | "cod" | null;
    providerReferenceId!: string | null;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;
    isRefunded!: boolean;
    refundedPaymentId!: number | null;
    createdAt!: string;
    updatedAt!: string;

    static from(transaction: Transaction, orderPublicId: string | null): PaymentResponseDTO {
        const dto = new PaymentResponseDTO();
        dto.id = transaction.id;
        dto.orderPublicId = orderPublicId;
        dto.type = transaction.type;
        dto.method = transaction.method;
        dto.provider = transaction.providerId === null ? null : PROVIDER_NAMES[transaction.providerId] ?? null;
        dto.providerReferenceId = transaction.providerReferenceId;
        dto.status = transaction.status;
        dto.amount = transaction.amount;
        dto.currency = transaction.currency;
        dto.isRefunded = transaction.isRefunded;
        dto.refundedPaymentId = transaction.refundedPaymentId;
        dto.createdAt = transaction.createdAt.toISOString();
        dto.updatedAt = transaction.updatedAt.toISOString();
        return dto;
    }
}

export class RefundResponseDTO {
    refundId!: number;
    status!: TransactionStatus;
    amount!: number;
    currency!: string;

    static from(refund: Transaction): RefundResponseDTO {
        const dto = new RefundResponseDTO();
        dto.refundId = refund.id;
        dto.status = refund.status;
        dto.amount = refund.amount;
        dto.currency = refund.currency;
        return dto;
    }
}
