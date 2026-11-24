// values mirror the CHECK constraints in the Phase 2 migrations
export enum PaymentSessionStatus {
    INITIALIZED = "initialized",
    PENDING = "pending",
    AUTHORIZED = "authorized",
    CAPTURED = "captured",
    FAILED = "failed",
    EXPIRED = "expired",
    CANCELLED = "cancelled"
}

export enum TransactionType {
    CHARGE = "charge",
    REFUND = "refund",
    COMMISSION = "commission",
    PAYOUT = "payout",
    COD_COLLECTION = "cod_collection",
    ADJUSTMENT = "adjustment"
}

export enum TransactionMethod {
    ONLINE = "online",
    COD = "cod",
    BANK_TRANSFER = "bank_transfer",
    SYSTEM = "system"
}

export enum TransactionStatus {
    PENDING = "pending",
    SUCCEEDED = "succeeded",
    FAILED = "failed",
    REVERSED = "reversed"
}

// fixed ids, seeded on every shard (create_payment_providers_table)
export enum PaymentProvider {
    KASHIER = 1,
    COD = 2
}

export const PROVIDER_NAMES: Record<number, "kashier" | "cod"> = {
    [PaymentProvider.KASHIER]: "kashier",
    [PaymentProvider.COD]: "cod",
};

// a session the customer can still pay through
export const OPEN_SESSION_STATUSES = [PaymentSessionStatus.INITIALIZED, PaymentSessionStatus.PENDING];

// cancel_reason written by the payment sweep
export const CANCEL_REASON_PAYMENT_TIMEOUT = "payment_timeout";
