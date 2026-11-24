import type {Knex} from "knex";
import {Transaction} from "../entity/transaction.entity.js";
import {TransactionStatus, TransactionType} from "../enums.js";
import type {InsertTransactionInput} from "../types.js";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

const TRANSACTION_COLUMNS = [
    "id", "region", "order_id", "order_created_at", "transaction_type", "method", "provider_id", "provider_reference_id",
    "status", "amount", "currency", "src_acc_id", "dst_acc_id", "is_refunded", "refunded_payment_id",
    "idempotency_key", "note", "provider_requested_at", "created_at", "updated_at"
];

interface OrderKey {
    id: number;
    createdAt: Date;
}

function nullableNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
}

function toEntity(row: any): Transaction {
    return new Transaction({
        id: Number(row.id),
        region: row.region,
        orderId: nullableNumber(row.order_id),
        orderCreatedAt: row.order_created_at,
        type: row.transaction_type,
        method: row.method,
        providerId: row.provider_id,
        providerReferenceId: row.provider_reference_id,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        srcAccId: nullableNumber(row.src_acc_id),
        dstAccId: nullableNumber(row.dst_acc_id),
        isRefunded: row.is_refunded,
        refundedPaymentId: nullableNumber(row.refunded_payment_id),
        idempotencyKey: row.idempotency_key,
        note: row.note,
        providerRequestedAt: row.provider_requested_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

// a duplicate idempotency_key fails with 23505 (uq_transactions_idempotency_key)
export async function insertTransaction(data: InsertTransactionInput, conn: Knex): Promise<Transaction> {
    const [row] = await conn("transactions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_created_at: data.orderCreatedAt ? toUtcTimestamp(data.orderCreatedAt) : null,
            transaction_type: data.type,
            method: data.method,
            provider_id: data.providerId,
            provider_reference_id: data.providerReferenceId,
            status: data.status,
            amount: data.amount,
            currency: data.currency,
            src_acc_id: data.srcAccId,
            dst_acc_id: data.dstAccId,
            refunded_payment_id: data.refundedPaymentId ?? null,
            idempotency_key: data.idempotencyKey,
            note: data.note ?? null,
        })
        .returning(TRANSACTION_COLUMNS);
    return toEntity(row);
}

// PK (GET /payments/:id, refunds lock the charge)
export async function findTransactionById(id: number, conn: Knex, forUpdate = false): Promise<Transaction | null> {
    const query = conn("transactions").select(TRANSACTION_COLUMNS).where("id", id);
    if(forUpdate) query.forUpdate();
    const [row] = await query;
    if(!row){
        return null;
    }
    return toEntity(row);
}

// uq_transactions_idempotency_key — the row an idempotent write already created
export async function findTransactionByIdempotencyKey(idempotencyKey: string, conn: Knex): Promise<Transaction | null> {
    const [row] = await conn("transactions").select(TRANSACTION_COLUMNS).where("idempotency_key", idempotencyKey);
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-P3 — the ledger of one order [optionally of some types], oldest first
export async function findTransactionsByOrder(order: OrderKey, types: TransactionType[] | null, conn: Knex, forUpdate = false): Promise<Transaction[]> {
    const query = conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("order_id", order.id)
        .andWhere("order_created_at", toUtcTimestamp(order.createdAt));
    if(types) query.whereIn("transaction_type", types);
    if(forUpdate) query.forUpdate();
    const rows = await query.orderBy("id", "asc");
    return rows.map(toEntity);
}

// Q-P4 — refund webhook: the refund row Kashier's refund transaction id was stored on, or the charge by kashierOrderId
export async function findTransactionByProviderReference(
    providerReferenceId: string,
    type: TransactionType,
    conn: Knex,
    forUpdate = false
): Promise<Transaction | null> {
    const query = conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("provider_reference_id", providerReferenceId)
        .andWhere("transaction_type", type)
        .orderBy("id", "desc")
        .limit(1);
    if(forUpdate) query.forUpdate();
    const [row] = await query;
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-P5 — every refund of a charge
export async function findRefundsByChargeId(chargeId: number, conn: Knex, forUpdate = false): Promise<Transaction[]> {
    const query = conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("refunded_payment_id", chargeId)
        .andWhere("transaction_type", TransactionType.REFUND)
        .orderBy("id", "asc");
    if(forUpdate) query.forUpdate();
    const rows = await query;
    return rows.map(toEntity);
}

// PK — conditional status move; 0 rows -> null
export async function updateTransactionStatus(
    id: number,
    fromStatuses: TransactionStatus[],
    toStatus: TransactionStatus,
    changes: {providerReferenceId?: string | null; note?: string | null},
    conn: Knex
): Promise<Transaction | null> {
    const update: Record<string, unknown> = {status: toStatus, updated_at: conn.fn.now()};
    if(changes.providerReferenceId !== undefined) update.provider_reference_id = changes.providerReferenceId;
    if(changes.note !== undefined) update.note = changes.note;
    const [row] = await conn("transactions")
        .update(update)
        .where("id", id)
        .whereIn("status", fromStatuses)
        .returning(TRANSACTION_COLUMNS);
    if(!row){
        return null;
    }
    return toEntity(row);
}

// PK — claim a queued refund for sending: exactly one caller wins (the others get null), so a refund
// is sent to the provider at most once even with N instances and the sweep racing the request path
export async function claimRefundForSending(id: number, conn: Knex): Promise<Transaction | null> {
    const [row] = await conn("transactions")
        .update({provider_requested_at: conn.fn.now(), updated_at: conn.fn.now()})
        .where("id", id)
        .andWhere("transaction_type", TransactionType.REFUND)
        .andWhere("status", TransactionStatus.PENDING)
        .whereNull("provider_requested_at")
        .returning(TRANSACTION_COLUMNS);
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-P8 — queued refunds (never sent) older than `olderThanSec`: the request path crashed or is still running
export async function findQueuedRefundIds(olderThanSec: number, limit: number, conn: Knex): Promise<number[]> {
    const rows = await conn("transactions")
        .select("id")
        .where("transaction_type", TransactionType.REFUND)
        .andWhere("status", TransactionStatus.PENDING)
        .whereNull("provider_requested_at")
        .andWhere("created_at", "<", conn.raw("NOW() - make_interval(secs => ?)", [olderThanSec]))
        .orderBy("created_at", "asc")
        .limit(limit);
    return rows.map((row: {id: string}) => Number(row.id));
}

// Q-P8 — refunds sent long ago with no webhook outcome: need a human (Kashier dashboard)
export async function findStaleSentRefunds(olderThanMin: number, limit: number, conn: Knex): Promise<Transaction[]> {
    const rows = await conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("transaction_type", TransactionType.REFUND)
        .andWhere("status", TransactionStatus.PENDING)
        .whereNotNull("provider_requested_at")
        .andWhere("created_at", "<", conn.raw("NOW() - make_interval(mins => ?)", [olderThanMin]))
        .orderBy("created_at", "asc")
        .limit(limit);
    return rows.map(toEntity);
}

// PK — refund id from the provider's answer (stored after the network call)
export async function updateTransactionProviderReference(id: number, providerReferenceId: string, conn: Knex): Promise<void> {
    await conn("transactions")
        .update({provider_reference_id: providerReferenceId, updated_at: conn.fn.now()})
        .where("id", id)
        .whereNull("provider_reference_id");
}

// PK
export async function updateChargeRefunded(id: number, isRefunded: boolean, conn: Knex): Promise<void> {
    await conn("transactions").update({is_refunded: isRefunded, updated_at: conn.fn.now()}).where("id", id);
}

// Q-F2 — payouts of one restaurant owner, newest first, keyset on (created_at, id)
// supported by idx_transactions_dst_acc_type_created_at (dst_acc_id, transaction_type, created_at DESC)
export async function listPayoutsByOwner(
    ownerId: number,
    range: {from: Date; to: Date},
    cursor: {createdAt: Date; id: number} | null,
    limit: number,
    conn: Knex
): Promise<Transaction[]> {
    const query = conn("transactions")
        .select(TRANSACTION_COLUMNS)
        .where("dst_acc_id", ownerId)
        .andWhere("transaction_type", TransactionType.PAYOUT)
        .andWhere("created_at", ">=", toUtcTimestamp(range.from))
        .andWhere("created_at", "<", toUtcTimestamp(range.to));
    if(cursor){
        query.whereRaw("(created_at, id) < (?, ?)", [toUtcTimestamp(cursor.createdAt), cursor.id]);
    }
    const rows = await query.orderBy([{column: "created_at", order: "desc"}, {column: "id", order: "desc"}]).limit(limit + 1);
    return rows.map(toEntity);
}
