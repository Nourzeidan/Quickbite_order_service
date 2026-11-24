import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {archiveSource, hotSource} from "../../../lib/knex/read-sources.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import {RestaurantRole, SystemRole} from "../../../lib/auth/enums.js";
import {IdempotencyConflictError} from "../../../lib/idempotency/errors.js";
import type {IdempotencyContext} from "../../../lib/idempotency/idempotency.js";
import {
    findIdempotencyKeyByHash,
    insertIdempotencyKey,
    PG_UNIQUE_VIOLATION
} from "../../../lib/idempotency/idempotency-key.repo.js";
import {PaymentProviderError, type IPaymentProvider} from "../../../pkg/payments/payment.interface.js";
import {MinsToMS, SecsToMS} from "../../../pkg/utils/time.js";
import {OrderStatus, PaymentMethod} from "../../order/enums.js";
import {OrderNotFoundError} from "../../order/errors.js";
import type {OrderPaymentService} from "../../order/service/order-payment.service.js";
import {PaymentProvider, PaymentSessionStatus} from "../enums.js";
import {
    OrderNotPendingPaymentError,
    PaymentNotFoundError,
    PaymentProviderRejectedError,
    PaymentProviderUnavailableError
} from "../errors.js";
import type {InitPaymentRequestDTO} from "../dto/payment.request.dto.js";
import {PaymentInitResponseDTO, PaymentResponseDTO} from "../dto/payment.response.dto.js";
import {findSessionsByOrder, insertPaymentSession} from "../repository/payment-session.repo.js";
import {findTransactionById} from "../repository/transaction.repo.js";

// a session that would expire this soon is not worth opening (the sweep is about to cancel the order)
const MIN_SESSION_LIFETIME_MS = SecsToMS(60);

export interface PaymentInitResult {
    session: PaymentInitResponseDTO;
    replayed: boolean;
}

// Kashier "order" = our merchant reference. Kashier wants it unique per merchant, so a second
// session for the same order gets a suffix; the webhook parses the region + publicId back out.
export function buildMerchantOrderRef(region: string, publicId: string, attempt: number): string {
    return attempt <= 1 ? `${region}_${publicId}` : `${region}_${publicId}_${attempt}`;
}

const MERCHANT_REF_PATTERN = /^([a-z]+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_\d+)?$/i;

export function parseMerchantOrderRef(ref: string): {region: string; publicId: string} | null {
    const match = MERCHANT_REF_PATTERN.exec(ref);
    if(!match) return null;
    return {region: match[1]!.toLowerCase(), publicId: match[2]!.toLowerCase()};
}

@injectable()
export class PaymentService {
    constructor(
        @inject(TOKENS.PaymentProvider) private readonly provider: IPaymentProvider,
        @inject(TOKENS.OrderPaymentService) private readonly orderPayments: OrderPaymentService
    ){}

    // POST /payments/init — payments.md §3
    init = async (
        region: string,
        user: JwtPayload,
        data: InitPaymentRequestDTO,
        idempotency: IdempotencyContext | undefined,
        correlationId: string
    ): Promise<PaymentInitResult> => {
        const conn = db(region);

        if(idempotency){
            const replay = await findReplay(idempotency, conn);
            if(replay) return replay;
        }

        const order = await this.orderPayments.findByPublicId(data.orderId, conn);
        if(!order || order.customerId !== user.userId){
            throw OrderNotFoundError;
        }
        if(order.status !== OrderStatus.PENDING_PAYMENT || order.paymentMethod !== PaymentMethod.ONLINE){
            throw OrderNotPendingPaymentError;
        }

        // domain-level idempotency: a live session is handed back (Q-P2)
        const sessions = await findSessionsByOrder(order, conn);
        const open = sessions.find((session) => session.isOpen());
        if(open){
            return {session: PaymentInitResponseDTO.from(open), replayed: false};
        }

        const expiresAt = new Date(order.createdAt.getTime() + MinsToMS(env.payments.sessionTimeoutMin));
        if(expiresAt.getTime() - Date.now() < MIN_SESSION_LIFETIME_MS){
            throw OrderNotPendingPaymentError;
        }
        const merchantOrderRef = buildMerchantOrderRef(region, order.publicId, sessions.length + 1);

        // network call, no transaction open
        let created;
        try{
            created = await this.provider.createSession({
                amountMinor: order.total,
                currency: order.currency,
                merchantOrderRef,
                expiresAt,
                returnUrl: env.kashier.returnUrl,
                webhookUrl: env.kashier.webhookUrl,
                customerReference: String(order.customerId),
                description: `QuickBite order ${order.publicId}`,
            });
        }catch(err){
            if(err instanceof PaymentProviderError){
                logger.error(err.kind === "rejected" ? "ALERT payment provider rejected session" : "payment provider unavailable", {
                    region, orderPublicId: order.publicId, correlationId, error: err.message, httpStatus: err.httpStatus,
                });
                throw err.kind === "rejected" ? PaymentProviderRejectedError : PaymentProviderUnavailableError;
            }
            throw err;
        }

        const trx = await conn.transaction();
        try{
            const session = await insertPaymentSession({
                region,
                orderId: order.id,
                orderCreatedAt: order.createdAt,
                providerId: PaymentProvider.KASHIER,
                providerSessionId: created.providerSessionId,
                merchantOrderRef,
                redirectUrl: created.redirectUrl,
                amount: order.total,
                currency: order.currency,
                status: PaymentSessionStatus.INITIALIZED,
                expiresAt,
                rawInitPayload: created.requestPayload,
            }, trx);
            const response = PaymentInitResponseDTO.from(session);
            if(idempotency){
                await insertIdempotencyKey({
                    keyHash: idempotency.keyHash,
                    region,
                    userId: user.userId,
                    fingerprint: idempotency.fingerprint,
                    responseStatus: 200,
                    responseBody: response,
                    ttlSec: idempotency.ttlSec,
                }, trx);
            }
            await trx.commit();
            logger.info("payment session created", {region, orderPublicId: order.publicId, sessionId: session.id, correlationId});
            return {session: response, replayed: false};
        }catch(err){
            await trx.rollback();
            if((err as {code?: string}).code === PG_UNIQUE_VIOLATION){
                // same Idempotency-Key committed first -> its response; a concurrent init with another key
                // took the same merchant reference -> the session it created
                if(idempotency){
                    const replay = await findReplay(idempotency, conn);
                    if(replay) return replay;
                }
                const winner = (await findSessionsByOrder(order, conn)).find((session) => session.isOpen());
                if(winner) return {session: PaymentInitResponseDTO.from(winner), replayed: false};
            }
            throw err;
        }
    }

    // GET /payments/:paymentId — admin, or a restaurant user (order:payment read, checked by the route) of that order
    getById = async (region: string, user: JwtPayload, paymentId: number): Promise<PaymentResponseDTO> => {
        if(!Number.isSafeInteger(paymentId) || paymentId <= 0){
            throw PaymentNotFoundError;
        }
        // the id carries no date: hot first, then the archive (archival.md §6)
        let conn = hotSource(region).conn;
        let transaction = await findTransactionById(paymentId, conn);
        if(!transaction){
            conn = archiveSource(region).conn;
            transaction = await findTransactionById(paymentId, conn);
        }
        if(!transaction){
            throw PaymentNotFoundError;
        }
        const order = transaction.orderId !== null && transaction.orderCreatedAt !== null
            ? await this.orderPayments.findByRef({id: transaction.orderId, createdAt: transaction.orderCreatedAt}, conn)
            : null;

        if(user.role !== SystemRole.ADMIN){
            const allowed = order
                ? this.orderPayments.canRestaurantUserRead(user, order)
                // order-less rows (payouts): only the restaurant owner the money moved for
                : user.restaurantRole === RestaurantRole.OWNER &&
                  (transaction.srcAccId === user.userId || transaction.dstAccId === user.userId);
            if(!allowed){
                throw PaymentNotFoundError;
            }
        }
        return PaymentResponseDTO.from(transaction, order?.publicId ?? null);
    }
}

async function findReplay(idempotency: IdempotencyContext, conn: Knex): Promise<PaymentInitResult | null> {
    const stored = await findIdempotencyKeyByHash(idempotency.keyHash, conn);
    if(!stored){
        return null;
    }
    if(!stored.fingerprint.equals(idempotency.fingerprint)){
        throw IdempotencyConflictError;
    }
    return {session: stored.responseBody as PaymentInitResponseDTO, replayed: true};
}
