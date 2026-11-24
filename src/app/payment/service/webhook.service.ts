import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {touchesPriorYear} from "../../../lib/knex/read-sources.js";
import {timeOfUuidV7} from "../../../pkg/utils/uuid.js";
import {logger} from "../../../lib/logger/logger.js";
import {isRegion} from "../../../lib/sharding/regions.js";
import type {IPaymentProvider, ProviderWebhookEvent, WebhookRequest} from "../../../pkg/payments/payment.interface.js";
import type {Order} from "../../order/entity/order.entity.js";
import type {OrderPaymentService} from "../../order/service/order-payment.service.js";
import {
    OPEN_SESSION_STATUSES,
    PaymentProvider,
    PaymentSessionStatus,
    TransactionMethod,
    TransactionStatus,
    TransactionType
} from "../enums.js";
import {InvalidSignatureError} from "../errors.js";
import {findSessionByMerchantOrderRef, updateSessionStatus} from "../repository/payment-session.repo.js";
import {findTransactionByIdempotencyKey, insertTransaction} from "../repository/transaction.repo.js";
import {insertWebhookEventIfNew, markWebhookEventFailed, markWebhookEventProcessed} from "../repository/webhook-event.repo.js";
import {parseMerchantOrderRef} from "./payment.service.js";
import type {RefundService} from "./refund.service.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import {OrderStatus} from "../../order/enums.js";
import type {FinanceService} from "../../restaurant-finance/service/finance.service.js";
import type {BalanceChange} from "../../restaurant-finance/types.js";

const SUPPORTED_PROVIDERS: Record<string, PaymentProvider> = {kashier: PaymentProvider.KASHIER};

// a captured session can't fall back; a failed attempt can still be followed by a success (maxFailureAttempts)
const CAPTURABLE_FROM = [...OPEN_SESSION_STATUSES, PaymentSessionStatus.FAILED, PaymentSessionStatus.EXPIRED, PaymentSessionStatus.CANCELLED];

export type WebhookResult = "processed" | "duplicate" | "ignored";

interface ProcessOutcome {
    note: string | null;
    placedOrder: Order | null;                  // pending_payment -> placed now
    queuedRefundIds: number[];                  // money arrived for an order that can't be placed -> refunds to send
    customerEvent: {event: "payment.captured" | "payment.failed"; customerId: number; payload: unknown} | null;
    balanceChange: BalanceChange | null;        // refund of a delivered order took money back from the restaurant
}

// payments.md §4
@injectable()
export class WebhookService {
    constructor(
        @inject(TOKENS.PaymentProvider) private readonly provider: IPaymentProvider,
        @inject(TOKENS.OrderPaymentService) private readonly orderPayments: OrderPaymentService,
        @inject(TOKENS.RefundService) private readonly refundService: RefundService,
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher,
        @inject(TOKENS.FinanceService) private readonly finance: FinanceService
    ){}

    handle = async (providerName: string, request: WebhookRequest, correlationId: string): Promise<WebhookResult> => {
        const providerId = SUPPORTED_PROVIDERS[providerName];
        if(providerId === undefined){
            throw InvalidSignatureError;
        }

        // 1. signature first: nothing is stored for an unsigned request
        const signature = this.provider.verifyWebhook(request);
        if(!signature){
            logger.warn("ALERT webhook with an invalid signature", {provider: providerName, correlationId});
            throw InvalidSignatureError;
        }

        let event: ProviderWebhookEvent;
        try{
            event = this.provider.parseWebhook(request.body);
        }catch(err){
            // signed but unusable: retrying won't change it -> ack
            logger.error("ALERT signed webhook with an unusable payload", {provider: providerName, correlationId, error: (err as Error).message});
            return "ignored";
        }

        // 2. region from our merchant reference
        const ref = parseMerchantOrderRef(event.merchantOrderRef);
        if(!ref || !isRegion(ref.region)){
            logger.warn("webhook for a reference this service did not create", {provider: providerName, correlationId});
            return "ignored";
        }
        const conn = db(ref.region);

        // 3. dedupe (Q-P7)
        const eventRowId = await insertWebhookEventIfNew({
            region: ref.region,
            providerId,
            providerEventId: event.eventId,
            signature,
            payload: request.body,
        }, conn);
        if(eventRowId === null){
            return "duplicate";
        }

        // 4. one transaction on the order's shard
        let outcome: ProcessOutcome;
        const trx = await conn.transaction();
        try{
            outcome = await this.process(event, ref.publicId, request.body, trx);
            await markWebhookEventProcessed(eventRowId, outcome.note, trx);
            await trx.commit();
        }catch(err){
            await trx.rollback();
            await markWebhookEventFailed(eventRowId, (err as Error).message, conn).catch(() => {});
            logger.error("webhook processing failed", {region: ref.region, eventRowId, correlationId, error: (err as Error).message});
            throw err;                                   // 500 -> the provider retries
        }

        // 5. after commit
        if(outcome.customerEvent){
            this.ws.publish([Rooms.customer(outcome.customerEvent.customerId)], outcome.customerEvent.event, outcome.customerEvent.payload);
        }
        this.finance.publishBalance(outcome.balanceChange);
        if(outcome.placedOrder){
            await this.orderPayments.afterPaid(outcome.placedOrder);
        }
        if(outcome.queuedRefundIds.length > 0){
            // never throws; anything not sent here is sent by the refund sweep
            await this.refundService.sendQueued(ref.region, outcome.queuedRefundIds, correlationId);
        }
        logger.info("webhook processed", {region: ref.region, eventRowId, event: event.rawEvent, status: event.status, note: outcome.note, correlationId});
        return "processed";
    }

    private process = async (event: ProviderWebhookEvent, publicId: string, payload: unknown, trx: Knex): Promise<ProcessOutcome> => {
        const none: ProcessOutcome = {note: null, placedOrder: null, queuedRefundIds: [], customerEvent: null, balanceChange: null};

        if(event.kind === "refund"){
            // lock the order FIRST (settlement locks order -> transactions too): a refund and the
            // delivery settlement of one order run one after the other, so each refund is taken back
            // from the restaurant exactly once — here if already delivered, else by the settlement
            const orderRef = await this.refundService.findOrderRefForRefundEvent(event, trx);
            const order = orderRef ? await this.orderPayments.findByRef(orderRef, trx, true) : null;
            const {note, succeeded} = await this.refundService.applyRefundWebhook(event, trx);
            if(!succeeded || !order || order.status !== OrderStatus.DELIVERED){
                return {...none, note};
            }
            const debit = await this.finance.debitForRefund(order, succeeded.amount, `refund:${succeeded.id}`, trx);
            return {...none, note, balanceChange: debit};
        }
        if(event.kind !== "payment"){
            return {...none, note: `ignored event "${event.rawEvent}"`};
        }

        const session = await findSessionByMerchantOrderRef(event.merchantOrderRef, trx, true);
        const order = session ? await this.orderPayments.findByRef({id: session.orderId, createdAt: session.orderCreatedAt}, trx) : null;
        if(!session || !order || order.publicId !== publicId){
            // a late event for an order the archiver already moved: nothing to change, ack it (archival.md §7)
            if(!session && touchesPriorYear(timeOfUuidV7(publicId))){
                logger.warn("payment webhook for an archived order", {merchantOrderRef: event.merchantOrderRef});
                return {...none, note: "order archived"};
            }
            logger.error("ALERT payment webhook without a matching session", {merchantOrderRef: event.merchantOrderRef});
            return {...none, note: "no matching session"};
        }
        if(event.amountMinor !== session.amount || event.currency !== session.currency){
            logger.error("ALERT payment webhook amount mismatch", {sessionId: session.id, orderPublicId: order.publicId});
            return {...none, note: "amount or currency mismatch"};
        }

        switch(event.status){
            case "pending":
                await updateSessionStatus(session.id, [PaymentSessionStatus.INITIALIZED], PaymentSessionStatus.PENDING, payload, trx);
                return none;

            case "failed":
                await updateSessionStatus(session.id, OPEN_SESSION_STATUSES, PaymentSessionStatus.FAILED, payload, trx);
                await this.insertChargeOnce(event, order, TransactionStatus.FAILED, trx);   // audit; order stays pending_payment
                return {...none, customerEvent: {event: "payment.failed", customerId: order.customerId,
                    payload: {orderPublicId: order.publicId, reason: "payment declined"}}};

            case "succeeded": {
                await updateSessionStatus(session.id, CAPTURABLE_FROM, PaymentSessionStatus.CAPTURED, payload, trx);
                const {charge, created} = await this.insertChargeOnce(event, order, TransactionStatus.SUCCEEDED, trx);
                if(!created){
                    return {...none, note: "charge already recorded for this transaction"};   // e.g. pay + capture of one transaction
                }
                const placed = await this.orderPayments.markPaid(order, trx);
                if(placed){
                    return {...none, placedOrder: placed, customerEvent: {event: "payment.captured", customerId: order.customerId,
                        payload: {orderPublicId: order.publicId, amount: charge.amount, currency: charge.currency}}};
                }
                // cancelled by the sweep / customer, or already paid through another session: money back.
                // the refund is reserved in THIS trx, so it survives a crash right after commit
                logger.warn("payment captured for an order that is not pending payment", {orderPublicId: order.publicId, status: order.status});
                const refundId = await this.refundService.queueChargeRefund(charge,
                    `payment captured while order was ${order.status}`, trx);
                return {...none, note: `captured while order was ${order.status}; refund queued`, queuedRefundIds: refundId === null ? [] : [refundId]};
            }
        }
    }

    // transactions.idempotency_key = provider transaction id + outcome: a reprocessed event, or a second event
    // name (pay / capture) for the same transaction, never writes a second row
    private insertChargeOnce = async (event: ProviderWebhookEvent, order: Order, status: TransactionStatus, trx: Knex) => {
        const idempotencyKey = `kashier-charge:${event.transactionId}:${status}`;
        const existing = await findTransactionByIdempotencyKey(idempotencyKey, trx);
        if(existing){
            return {charge: existing, created: false};
        }
        const charge = await insertTransaction({
            region: order.region,
            orderId: order.id,
            orderCreatedAt: order.createdAt,
            type: TransactionType.CHARGE,
            method: TransactionMethod.ONLINE,
            providerId: PaymentProvider.KASHIER,
            providerReferenceId: event.providerOrderId || null,     // kashierOrderId: what refunds are addressed to
            status,
            amount: event.amountMinor,
            currency: event.currency,
            srcAccId: order.customerId,
            dstAccId: null,
            idempotencyKey,
            note: `kashier transaction ${event.transactionId}`,
        }, trx);
        return {charge, created: true};
    }
}
