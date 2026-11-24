import {injectable} from "tsyringe";
import type {Knex} from "knex";
import {
    PaymentProvider,
    PaymentSessionStatus,
    TransactionMethod,
    TransactionStatus,
    TransactionType
} from "../enums.js";
import type {PaymentOrderRef} from "../types.js";
import type {Transaction} from "../entity/transaction.entity.js";
import {findTransactionByIdempotencyKey, findTransactionsByOrder, insertTransaction, listPayoutsByOwner, updateTransactionStatus} from "../repository/transaction.repo.js";
import {closeOpenSessionsByOrders} from "../repository/payment-session.repo.js";
import {logger} from "../../../lib/logger/logger.js";
import {PaymentNotSettledError} from "../errors.js";

export type LedgerPaymentStatus = "pending" | "succeeded" | "failed" | "refunded" | "partially_refunded";

// a refund debit's two ledger rows share this key prefix (restaurant-finance.md §5)
const REFUND_DEBIT_KEY = "refund-debit:";
const REFUND_SHORTFALL_KEY = "refund-shortfall:";

export interface RecordPayoutInput {
    region: string;
    ownerId: number;
    amount: number;
    currency: string;
    providerReferenceId: string;
    note: string | null;
    idempotencyKey: string;
}

export interface RefundDebitContext {
    ownerId: number | null;             // from the order's commission row (null = never settled)
    takenBack: number;                  // restaurant share already debited / owed by earlier refunds
}

export interface LedgerSummary {
    status: LedgerPaymentStatus;
    refundedAmount: number;
}

// The ledger writes other modules make inside THEIR transaction (payments.md §1: every
// `transactions` write goes through the payment module). No network calls here.
@injectable()
export class PaymentLedgerService {

    // COD placement (orders.md §2, same trx as the order insert)
    recordCodCollection = async (order: PaymentOrderRef, restaurantOwnerId: number, trx: Knex): Promise<Transaction> => {
        return insertTransaction({
            region: order.region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            type: TransactionType.COD_COLLECTION,
            method: TransactionMethod.COD,
            providerId: PaymentProvider.COD,
            providerReferenceId: null,
            status: TransactionStatus.PENDING,
            amount: order.total,
            currency: order.currency,
            srcAccId: order.customerId,
            dstAccId: restaurantOwnerId,
            idempotencyKey: null,
        }, trx);
    }

    // COD cancelled / rejected / voided before delivery: cod_collection -> failed + 0-amount audit adjustment
    voidCodCollection = async (order: PaymentOrderRef, reason: string, trx: Knex): Promise<void> => {
        const [cod] = await findTransactionsByOrder(order, [TransactionType.COD_COLLECTION], trx, true);
        if(!cod){
            return;
        }
        const failed = await updateTransactionStatus(cod.id, [TransactionStatus.PENDING], TransactionStatus.FAILED, {note: reason}, trx);
        if(!failed){
            return;                                     // already settled or voided
        }
        await insertTransaction({
            region: order.region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            type: TransactionType.ADJUSTMENT,
            method: TransactionMethod.SYSTEM,
            providerId: null,
            providerReferenceId: null,
            status: TransactionStatus.SUCCEEDED,
            amount: 0,
            currency: order.currency,
            srcAccId: cod.srcAccId,
            dstAccId: cod.dstAccId,
            idempotencyKey: `cod-void:${order.region}:${order.publicId}`,
            note: `COD voided: ${reason}`,
        }, trx);
    }

    // online order cancelled before it was paid: its open sessions can't be paid any more
    cancelOpenSessions = async (order: PaymentOrderRef, trx: Knex): Promise<void> => {
        await closeOpenSessionsByOrders([order], PaymentSessionStatus.CANCELLED, trx);
    }

    // order detail paymentSummary, from the ledger (Q-P3, one query)
    summarize = async (order: PaymentOrderRef, method: "online" | "cod", voided: boolean, conn: Knex): Promise<LedgerSummary> => {
        const rows = await findTransactionsByOrder(order, [TransactionType.CHARGE, TransactionType.COD_COLLECTION, TransactionType.REFUND], conn);

        if(method === "cod"){
            const cod = rows.find((row) => row.type === TransactionType.COD_COLLECTION);
            if(!cod) return {status: voided ? "failed" : "pending", refundedAmount: 0};
            const status: LedgerPaymentStatus = cod.status === TransactionStatus.SUCCEEDED ? "succeeded"
                : cod.status === TransactionStatus.PENDING ? "pending" : "failed";
            return {status, refundedAmount: 0};
        }

        const charges = rows.filter((row) => row.type === TransactionType.CHARGE && row.status === TransactionStatus.SUCCEEDED);
        if(charges.length === 0){
            return {status: voided ? "failed" : "pending", refundedAmount: 0};
        }
        const charged = charges.reduce((sum, row) => sum + row.amount, 0);
        const refundedAmount = rows
            .filter((row) => row.type === TransactionType.REFUND && row.status === TransactionStatus.SUCCEEDED)
            .reduce((sum, row) => sum + row.amount, 0);
        const status: LedgerPaymentStatus = refundedAmount === 0 ? "succeeded"
            : refundedAmount >= charged ? "refunded" : "partially_refunded";
        return {status, refundedAmount};
    }

    // delivery settlement, inside the settlement trx (deliveries.md §6 steps 2-3):
    //  - COD: the cash was collected at the door -> cod_collection pending -> succeeded
    //  - online: the charge must already be succeeded (else abort: never settle unpaid money)
    //  - commission row: restaurant owner -> platform (0 allowed when the branch has no commission)
    //  - returns the refunds that already succeeded (refunded while the order was on its way): the
    //    settlement takes them back from the restaurant in the same trx
    settleDelivery = async (order: PaymentOrderRef, method: "online" | "cod", restaurantOwnerId: number, commission: number, trx: Knex): Promise<{refundedAmount: number}> => {
        const rows = await findTransactionsByOrder(order, [TransactionType.CHARGE, TransactionType.COD_COLLECTION, TransactionType.REFUND], trx, true);
        if(method === "cod"){
            const cod = rows.find((row) => row.type === TransactionType.COD_COLLECTION);
            const settled = cod && await updateTransactionStatus(cod.id, [TransactionStatus.PENDING], TransactionStatus.SUCCEEDED, {note: "collected at delivery"}, trx);
            if(!settled){
                logger.error("ALERT delivered COD order without a pending cod_collection", {region: order.region, orderPublicId: order.publicId});
                throw PaymentNotSettledError;
            }
        }else if(!rows.some((row) => row.type === TransactionType.CHARGE && row.status === TransactionStatus.SUCCEEDED)){
            logger.error("ALERT delivered online order without a succeeded charge", {region: order.region, orderPublicId: order.publicId});
            throw PaymentNotSettledError;
        }

        await insertTransaction({
            region: order.region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            type: TransactionType.COMMISSION,
            method: TransactionMethod.SYSTEM,
            providerId: null,
            providerReferenceId: null,
            status: TransactionStatus.SUCCEEDED,
            amount: commission,
            currency: order.currency,
            srcAccId: restaurantOwnerId,
            dstAccId: null,
            idempotencyKey: `commission:${order.region}:${order.publicId}`,
            note: "platform commission",
        }, trx);
        const refundedAmount = rows
            .filter((row) => row.type === TransactionType.REFUND && row.status === TransactionStatus.SUCCEEDED)
            .reduce((sum, row) => sum + row.amount, 0);
        return {refundedAmount};
    }

    // ---- restaurant finance (restaurant-finance.md §4-5), always inside the finance trx ----

    // admin payout: a bank transfer operations already made. platform (NULL) -> owner
    recordPayout = async (data: RecordPayoutInput, trx: Knex): Promise<Transaction> => {
        return insertTransaction({
            region: data.region,
            orderId: null,
            orderCreatedAt: null,
            type: TransactionType.PAYOUT,
            method: TransactionMethod.BANK_TRANSFER,
            providerId: null,
            providerReferenceId: data.providerReferenceId,
            status: TransactionStatus.SUCCEEDED,
            amount: data.amount,
            currency: data.currency,
            srcAccId: null,
            dstAccId: data.ownerId,
            idempotencyKey: data.idempotencyKey,
            note: data.note,
        }, trx);
    }

    // uq_transactions_idempotency_key — a payout replayed after its Redis response expired
    findByIdempotencyKey = async (idempotencyKey: string, conn: Knex): Promise<Transaction | null> => {
        return findTransactionByIdempotencyKey(idempotencyKey, conn);
    }

    // Q-F2
    listPayouts = async (ownerId: number, range: {from: Date; to: Date}, cursor: {createdAt: Date; id: number} | null, limit: number, conn: Knex): Promise<Transaction[]> => {
        return listPayoutsByOwner(ownerId, range, cursor, limit, conn);
    }

    // Q-P3 (one query): who the restaurant account is and how much of its share earlier refunds took back
    refundDebitContext = async (order: PaymentOrderRef, trx: Knex): Promise<RefundDebitContext> => {
        const rows = await findTransactionsByOrder(order, [TransactionType.COMMISSION, TransactionType.ADJUSTMENT], trx);
        const commission = rows.find((row) => row.type === TransactionType.COMMISSION);
        const takenBack = rows
            .filter((row) => row.type === TransactionType.ADJUSTMENT && isRefundDebitKey(row.idempotencyKey))
            .reduce((sum, row) => sum + row.amount, 0);
        return {ownerId: commission?.srcAccId ?? null, takenBack};
    }

    // owner -> platform. debited: taken from the balance (succeeded); shortfall: what the balance could
    // not cover, owed by the restaurant (pending, for ops). `key` makes each refund's rows unique.
    recordRefundDebit = async (order: PaymentOrderRef, ownerId: number, debited: number, shortfall: number, key: string, trx: Knex): Promise<void> => {
        const base = {
            region: order.region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            type: TransactionType.ADJUSTMENT,
            method: TransactionMethod.SYSTEM,
            providerId: null,
            providerReferenceId: null,
            currency: order.currency,
            srcAccId: ownerId,
            dstAccId: null,
        };
        if(debited > 0){
            await insertTransaction({...base, status: TransactionStatus.SUCCEEDED, amount: debited,
                idempotencyKey: `${REFUND_DEBIT_KEY}${order.region}:${key}`, note: "refund debit"}, trx);
        }
        if(shortfall > 0){
            await insertTransaction({...base, status: TransactionStatus.PENDING, amount: shortfall,
                idempotencyKey: `${REFUND_SHORTFALL_KEY}${order.region}:${key}`, note: "refund remainder (balance too low)"}, trx);
        }
    }
}

function isRefundDebitKey(key: string | null): boolean {
    return key !== null && (key.startsWith(REFUND_DEBIT_KEY) || key.startsWith(REFUND_SHORTFALL_KEY));
}
