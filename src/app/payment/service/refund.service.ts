import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import {PG_UNIQUE_VIOLATION} from "../../../lib/idempotency/idempotency-key.repo.js";
import {PaymentProviderError, type IPaymentProvider, type ProviderWebhookEvent} from "../../../pkg/payments/payment.interface.js";
import {TransactionStatus, TransactionType} from "../enums.js";
import {
    PaymentNotFoundError,
    PaymentNotRefundableError,
    PaymentProviderRejectedError,
    PaymentProviderUnavailableError,
    RefundExceedsRefundableError
} from "../errors.js";
import type {Transaction} from "../entity/transaction.entity.js";
import type {PaymentOrderRef} from "../types.js";
import {RefundResponseDTO} from "../dto/payment.response.dto.js";
import {
    claimRefundForSending,
    findQueuedRefundIds,
    findRefundsByChargeId,
    findStaleSentRefunds,
    findTransactionById,
    findTransactionByIdempotencyKey,
    findTransactionByProviderReference,
    findTransactionsByOrder,
    insertTransaction,
    updateChargeRefunded,
    updateTransactionProviderReference,
    updateTransactionStatus
} from "../repository/transaction.repo.js";

const RESERVED_STATUSES = [TransactionStatus.PENDING, TransactionStatus.SUCCEEDED];

// the request path normally sends a queued refund within milliseconds; the sweep only takes
// rows older than this so it doesn't race a request that is about to send
const QUEUED_REFUND_MIN_AGE_SEC = 30;
const SWEEP_BATCH = 50;

export interface AdminRefundRequest {
    region: string;
    chargeId: number;
    amount: number | undefined;         // undefined -> everything still refundable
    reason: string;
    idempotencyKey: string;
    correlationId: string;
}

export interface RefundWebhookOutcome {
    note: string | null;                // non-null: handled without a state change
    succeeded: Transaction | null;      // the refund that became succeeded in this webhook (finance debits it)
}

// payments.md §6. A refund is two steps:
//   1. reserve — a `pending` refund row, written in the SAME transaction as the decision to refund
//      (admin request, order cancel, late capture). Nothing is lost if the process dies after commit.
//   2. send    — after commit: claim the row (provider_requested_at = NOW(), exactly once) and call Kashier.
//      Rows still queued after a crash are sent by the sweep (reconcile).
// The final state comes from the refund webhook.
@injectable()
export class RefundService {
    constructor(
        @inject(TOKENS.PaymentProvider) private readonly provider: IPaymentProvider
    ){}

    // POST /payments/:paymentId/refund (admin): provider errors are returned to the admin (502 / 503)
    refundByAdmin = async (request: AdminRefundRequest): Promise<RefundResponseDTO> => {
        const conn = db(request.region);

        const existing = await findTransactionByIdempotencyKey(request.idempotencyKey, conn);
        if(existing){
            return RefundResponseDTO.from(existing);
        }

        let refund: Transaction;
        const trx = await conn.transaction();
        try{
            const charge = await findTransactionById(request.chargeId, trx, true);
            if(!charge || charge.type !== TransactionType.CHARGE){
                throw PaymentNotFoundError;
            }
            refund = await this.reserve(charge, request.amount, request.idempotencyKey, request.reason, trx);
            await trx.commit();
        }catch(err){
            await trx.rollback();
            if((err as {code?: string}).code === PG_UNIQUE_VIOLATION){
                const raced = await findTransactionByIdempotencyKey(request.idempotencyKey, conn);
                if(raced) return RefundResponseDTO.from(raced);
            }
            throw err;
        }

        const sent = await this.send(request.region, refund.id, request.correlationId, true);
        return RefundResponseDTO.from(sent ?? refund);
    }

    // order rejected / cancelled (inside the order's trx): reserve a full refund of every succeeded charge.
    // returns the refund ids to send after commit.
    queueOrderRefunds = async (order: PaymentOrderRef, reason: string, trx: Knex): Promise<number[]> => {
        const charges = (await findTransactionsByOrder(order, [TransactionType.CHARGE], trx, true))
            .filter((charge) => charge.status === TransactionStatus.SUCCEEDED);
        const ids: number[] = [];
        for(const charge of charges){
            const id = await this.queueAutomatic(charge, reason, trx);
            if(id !== null) ids.push(id);
        }
        return ids;
    }

    // money captured for an order that can't be placed (inside the webhook's trx)
    queueChargeRefund = async (charge: Transaction, reason: string, trx: Knex): Promise<number | null> => {
        return this.queueAutomatic(charge, reason, trx);
    }

    // after commit; never throws (a failure leaves the row for the sweep / an alert)
    sendQueued = async (region: string, refundIds: number[], correlationId: string): Promise<void> => {
        for(const id of refundIds){
            try{
                await this.send(region, id, correlationId, false);
            }catch(err){
                logger.error("ALERT refund send failed", {region, refundId: id, correlationId, error: (err as Error).message});
            }
        }
    }

    // refund sweep, one shard (PaymentSweepService):
    //  - queued refunds nobody sent (process died after commit) -> send
    //  - sent refunds with no webhook outcome after REFUND_STALE_ALERT_MIN -> alert (never re-sent:
    //    Kashier may have refunded already; a human checks the Kashier dashboard)
    reconcile = async (region: string, correlationId: string): Promise<void> => {
        const conn = db(region);
        const queued = await findQueuedRefundIds(QUEUED_REFUND_MIN_AGE_SEC, SWEEP_BATCH, conn);
        if(queued.length > 0){
            logger.warn("sending queued refunds", {region, count: queued.length, correlationId});
            await this.sendQueued(region, queued, correlationId);
        }

        const stale = await findStaleSentRefunds(env.payments.refundStaleAlertMin, SWEEP_BATCH, conn);
        for(const refund of stale){
            logger.error("ALERT refund has no outcome from the provider", {
                region, refundId: refund.id, chargeId: refund.refundedPaymentId, sentAt: refund.providerRequestedAt?.toISOString(),
            });
        }
    }

    // the order a refund webhook is about, WITHOUT locks: the webhook locks the order row before
    // anything else (settlement locks order -> transactions; the webhook must use the same order)
    findOrderRefForRefundEvent = async (event: ProviderWebhookEvent, conn: Knex): Promise<{id: number; createdAt: Date} | null> => {
        const row = await findTransactionByProviderReference(event.transactionId, TransactionType.REFUND, conn)
            ?? (event.providerOrderId ? await findTransactionByProviderReference(event.providerOrderId, TransactionType.CHARGE, conn) : null);
        return row && row.orderId !== null && row.orderCreatedAt !== null ? {id: row.orderId, createdAt: row.orderCreatedAt} : null;
    }

    // refund webhook, inside the webhook's transaction (payments.md §4.3)
    applyRefundWebhook = async (event: ProviderWebhookEvent, trx: Knex): Promise<RefundWebhookOutcome> => {
        let refund = await findTransactionByProviderReference(event.transactionId, TransactionType.REFUND, trx, true);
        let charge: Transaction | null = null;

        if(!refund && event.providerOrderId){
            // the webhook can arrive before we stored Kashier's refund id: the oldest pending, already
            // sent refund of that charge with the same amount
            charge = await findTransactionByProviderReference(event.providerOrderId, TransactionType.CHARGE, trx);
            if(charge){
                const refunds = await findRefundsByChargeId(charge.id, trx, true);
                refund = refunds.find((row) =>
                    row.status === TransactionStatus.PENDING && row.amount === event.amountMinor &&
                    row.providerReferenceId === null && row.providerRequestedAt !== null
                ) ?? null;
            }
        }
        if(!refund){
            logger.warn("ALERT refund webhook without a matching refund row", {transactionId: event.transactionId});
            return {note: "unmatched refund (not initiated by this service)", succeeded: null};
        }
        if(refund.amount !== event.amountMinor || refund.currency !== event.currency){
            logger.error("ALERT refund webhook amount mismatch", {refundId: refund.id, transactionId: event.transactionId});
            return {note: "amount or currency mismatch", succeeded: null};
        }
        if(refund.status !== TransactionStatus.PENDING || event.status === "pending"){
            return {note: null, succeeded: null};       // already final, or nothing final yet
        }

        const toStatus = event.status === "succeeded" ? TransactionStatus.SUCCEEDED : TransactionStatus.FAILED;
        const updated = await updateTransactionStatus(refund.id, [TransactionStatus.PENDING], toStatus, {
            providerReferenceId: refund.providerReferenceId ?? event.transactionId,
        }, trx);
        if(!updated || toStatus !== TransactionStatus.SUCCEEDED || refund.refundedPaymentId === null){
            return {note: null, succeeded: null};
        }

        // the charge is "refunded" once its succeeded refunds cover it (invariant 1 keeps it <= amount)
        charge ??= await findTransactionById(refund.refundedPaymentId, trx);
        if(charge){
            const refunded = (await findRefundsByChargeId(charge.id, trx))
                .filter((row) => row.status === TransactionStatus.SUCCEEDED)
                .reduce((sum, row) => sum + row.amount, 0);
            await updateChargeRefunded(charge.id, refunded >= charge.amount, trx);
        }
        // the caller (WebhookService) debits the restaurant if the order was already delivered (settled)
        return {note: null, succeeded: updated};
    }

    // full refund of what is left on the charge; one automatic refund per charge (key), null = nothing to do
    private queueAutomatic = async (charge: Transaction, reason: string, trx: Knex): Promise<number | null> => {
        const key = `auto-refund:charge:${charge.id}`;
        // checked first: a unique violation inside the caller's trx would abort the whole trx
        if(await findTransactionByIdempotencyKey(key, trx)){
            return null;
        }
        try{
            const refund = await this.reserve(charge, undefined, key, reason, trx);
            return refund.id;
        }catch(err){
            if(err === PaymentNotRefundableError){
                return null;                            // already fully refunded by an admin
            }
            throw err;
        }
    }

    // step 1. caller holds the charge row lock (FOR UPDATE) inside `trx`
    private reserve = async (charge: Transaction, amount: number | undefined, idempotencyKey: string, reason: string, trx: Knex): Promise<Transaction> => {
        if(charge.status !== TransactionStatus.SUCCEEDED || !charge.providerReferenceId){
            throw PaymentNotRefundableError;
        }
        // Q-P5 — the charge lock serializes concurrent refunds of the same charge
        const reserved = (await findRefundsByChargeId(charge.id, trx))
            .filter((row) => RESERVED_STATUSES.includes(row.status))
            .reduce((sum, row) => sum + row.amount, 0);
        const refundable = charge.amount - reserved;
        if(refundable <= 0){
            throw PaymentNotRefundableError;
        }
        const refundAmount = amount ?? refundable;
        if(refundAmount > refundable){
            throw RefundExceedsRefundableError;
        }

        return insertTransaction({
            region: charge.region,
            orderId: charge.orderId,
            orderCreatedAt: charge.orderCreatedAt,
            type: TransactionType.REFUND,
            method: charge.method,
            providerId: charge.providerId,
            providerReferenceId: null,
            status: TransactionStatus.PENDING,
            amount: refundAmount,
            currency: charge.currency,
            srcAccId: null,
            dstAccId: charge.srcAccId,
            refundedPaymentId: charge.id,
            idempotencyKey,
            note: reason,
        }, trx);
    }

    // step 2. no trx open. returns the row as it is after the call, or null if someone else sent it.
    private send = async (region: string, refundId: number, correlationId: string, rethrowProviderErrors: boolean): Promise<Transaction | null> => {
        const conn = db(region);
        const refund = await claimRefundForSending(refundId, conn);
        if(!refund){
            return null;                                // already sent (request path vs sweep) or already final
        }
        const charge = refund.refundedPaymentId === null ? null : await findTransactionById(refund.refundedPaymentId, conn);
        if(!charge?.providerReferenceId){
            logger.error("ALERT refund without a refundable charge", {region, refundId, correlationId});
            return updateTransactionStatus(refund.id, [TransactionStatus.PENDING], TransactionStatus.FAILED, {note: "charge has no provider reference"}, conn);
        }

        try{
            const result = await this.provider.refund({
                providerOrderId: charge.providerReferenceId,
                amountMinor: refund.amount,
                reason: refund.note ?? "refund",
            });
            if(result.providerReferenceId){
                await updateTransactionProviderReference(refund.id, result.providerReferenceId, conn);
                refund.providerReferenceId = result.providerReferenceId;
            }
            logger.info("refund sent to provider", {region, refundId: refund.id, chargeId: charge.id, correlationId});
            return refund;
        }catch(err){
            // timeout / 5xx: Kashier may have refunded anyway -> keep `pending`, the webhook decides
            // (the stale-refund alert fires if it never comes). A clear rejection -> `failed`.
            const unavailable = !(err instanceof PaymentProviderError) || err.kind === "unavailable";
            let current: Transaction | null = refund;
            if(!unavailable){
                current = await updateTransactionStatus(refund.id, [TransactionStatus.PENDING], TransactionStatus.FAILED, {
                    note: `${refund.note ?? ""} | provider error: ${(err as Error).message}`,
                }, conn);
            }
            logger.error(unavailable ? "ALERT refund outcome unknown (provider unavailable)" : "ALERT refund rejected by the provider", {
                region, refundId: refund.id, chargeId: charge.id, correlationId, error: (err as Error).message,
            });
            if(!rethrowProviderErrors){
                return current;
            }
            if(err instanceof PaymentProviderError){
                throw err.kind === "unavailable" ? PaymentProviderUnavailableError : PaymentProviderRejectedError;
            }
            throw err;
        }
    }
}
