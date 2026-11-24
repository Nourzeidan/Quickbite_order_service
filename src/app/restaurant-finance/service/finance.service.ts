import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import {SystemRole} from "../../../lib/auth/enums.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import {decodeCursor, encodeCursor} from "../../../lib/http/pagination/cursor-pagination.js";
import {isSourceCursors, mergeKeysetPages, type SourceCursors} from "../../../lib/http/pagination/keyset-merge.js";
import {readSourcesForRange} from "../../../lib/knex/read-sources.js";
import type {Transaction} from "../../payment/entity/transaction.entity.js";
import type {RestaurantClient} from "../../../lib/core-client/restaurant.client.js";
import type {Order} from "../../order/entity/order.entity.js";
import {toPaymentRef} from "../../order/payment-ref.js";
import {InvalidCursorError, InvalidDateRangeError} from "../../order/errors.js";
import type {PaymentLedgerService} from "../../payment/service/payment-ledger.service.js";
import {addToBalance, findBalancesByRestaurant, lockBalance, type RestaurantBalance} from "../repository/restaurant-balance.repo.js";
import type {CreatePayoutRequestDTO, RestaurantBalanceQueryDTO, RestaurantPayoutsQueryDTO} from "../dto/finance.request.dto.js";
import {PayoutResponseDTO, RestaurantBalanceResponseDTO} from "../dto/finance.response.dto.js";
import type {BalanceChange, CreditSettlementInput, PayoutCursor, PayoutPage, RefundDebitResult} from "../types.js";
import {InsufficientBalanceError, RestaurantIdRequiredError, RestaurantNotFoundError} from "../errors.js";

const DEFAULT_PAGE = 20;
const DEFAULT_PAYOUT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// restaurant-finance.md. Every balance change happens under the balance row lock (FOR UPDATE) in the
// same transaction as its ledger rows; ledger rows are written through PaymentLedgerService.
// The caller publishes the BalanceChange after commit (publishBalance).
@injectable()
export class FinanceService {
    constructor(
        @inject(TOKENS.PaymentLedgerService) private readonly ledger: PaymentLedgerService,
        @inject(TOKENS.RestaurantClient) private readonly restaurantClient: RestaurantClient,
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher
    ){}

    // ---- writes other modules make inside THEIR transaction ----

    // delivery settlement: balance += subtotal - commission
    creditSettlement = async (data: CreditSettlementInput, trx: Knex): Promise<RestaurantBalance> => {
        await lockBalance(data.restaurantId, data.region, data.currency, trx);
        return addToBalance(data.restaurantId, data.currency, data.amount, trx);
    }

    // §5 — a refund of a delivered (settled) order takes the restaurant's share back.
    //   share     = min(refund, (subtotal - commission) - taken back by earlier refunds)   (never more than it earned)
    //   debited   = min(share, balance)                                                    (balance never < 0)
    //   shortfall = share - debited                                                        (pending adjustment for ops)
    // The delivery-fee part of a refund is the platform's loss. `key` is unique per refund (idempotent rows).
    // The caller holds the order row lock, so settlement and refunds of one order never interleave.
    debitForRefund = async (order: Order, refundAmount: number, key: string, trx: Knex): Promise<RefundDebitResult | null> => {
        const ref = toPaymentRef(order);
        const {ownerId, takenBack} = await this.ledger.refundDebitContext(ref, trx);
        if(ownerId === null){
            logger.error("ALERT refund debit for an order without a commission row", {region: order.region, orderPublicId: order.publicId});
            return null;
        }
        const share = Math.min(refundAmount, Math.max(0, order.subtotal - order.commission - takenBack));
        if(share <= 0){
            return null;                            // the restaurant already gave back everything it earned
        }

        const locked = await lockBalance(order.restaurantId, order.region, order.currency, trx);
        const debited = Math.min(share, locked.balance);
        const shortfall = share - debited;
        await this.ledger.recordRefundDebit(ref, ownerId, debited, shortfall, key, trx);
        const after = debited > 0 ? await addToBalance(order.restaurantId, order.currency, -debited, trx) : locked;
        if(shortfall > 0){
            logger.warn("ALERT refund debit larger than the restaurant balance", {
                region: order.region, orderPublicId: order.publicId, debited, shortfall,
            });
        }
        return {restaurantId: order.restaurantId, currency: order.currency, balance: after.balance, debited, shortfall};
    }

    // after commit only; never throws (WsPublisher logs and swallows)
    publishBalance = (change: BalanceChange | null): void => {
        if(!change) return;
        this.ws.publish([Rooms.restaurant(change.restaurantId)], "restaurant.balance_changed", {
            currency: change.currency, balance: change.balance,
        });
    }

    // ---- endpoints ----

    // §2 GET /restaurant/balance — straight from Postgres, never cached
    getBalance = async (region: string, user: JwtPayload, query: RestaurantBalanceQueryDTO): Promise<RestaurantBalanceResponseDTO> => {
        const restaurantId = restaurantOf(user, query.restaurantId);
        const rows = await findBalancesByRestaurant(restaurantId, db(region));
        return RestaurantBalanceResponseDTO.from(restaurantId, rows, new Date());
    }

    // §3 GET /restaurant/payouts?from=&to= — default last 90 days, newest first
    listPayouts = async (region: string, user: JwtPayload, query: RestaurantPayoutsQueryDTO, correlationId: string): Promise<PayoutPage> => {
        const restaurantId = restaurantOf(user, query.restaurantId);
        const now = new Date();
        const to = query.to ? new Date(query.to) : now;
        const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_PAYOUT_DAYS * DAY_MS);
        if(from.getTime() >= to.getTime() || to.getTime() - from.getTime() > 366 * DAY_MS) throw InvalidDateRangeError;
        const limit = query.limit ?? DEFAULT_PAGE;
        const state = decodeCursor(query.cursor, isPayoutCursorState);
        if(query.cursor && !state) throw InvalidCursorError;

        // payouts are addressed to the owner's user id (ledger account), cached core lookup
        const restaurant = await this.restaurantClient.getRestaurant(restaurantId, correlationId);
        if(!restaurant) throw RestaurantNotFoundError;

        // the default 90 days reach into last year until April: archive + hot then (archival.md §6)
        const range = {from, to: new Date(to.getTime() + 1)};
        const page = await mergeKeysetPages<Transaction, PayoutCursor>({
            sources: readSourcesForRange(region, range),
            state: state ?? {},
            limit,
            fetch: (source, position) => this.ledger.listPayouts(restaurant.ownerId, range,
                position ? {createdAt: new Date(position[0]), id: position[1]} : null, limit, source.conn),
            compare: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
            identity: (row) => String(row.id),
            cursorOf: (row) => [row.createdAt.toISOString(), row.id],
        });
        return {
            data: page.rows.map(({row}) => PayoutResponseDTO.from(row)),
            meta: {nextCursor: page.hasMore ? encodeCursor(page.nextState) : null, hasMore: page.hasMore, count: page.rows.length},
        };
    }

    // §4 POST /restaurant/payouts (admin). idempotencyKey: hash of admin + method + path + Idempotency-Key
    recordPayout = async (region: string, dto: CreatePayoutRequestDTO, idempotencyKey: string, correlationId: string): Promise<PayoutResponseDTO> => {
        // core lookup before the trx: no network call while it is open
        const restaurant = await this.restaurantClient.getRestaurant(dto.restaurantId, correlationId);
        if(!restaurant) throw RestaurantNotFoundError;

        const key = `payout:${idempotencyKey}`;
        const trx = await db(region).transaction();
        let payout;
        let change: BalanceChange | null = null;
        try{
            // replay after the Redis response expired: the same payout, no second debit
            const existing = await this.ledger.findByIdempotencyKey(key, trx);
            if(existing){
                payout = existing;
            }else{
                const balance = await lockBalance(dto.restaurantId, region, dto.currency, trx);
                if(balance.balance < dto.amount){
                    throw InsufficientBalanceError;
                }
                payout = await this.ledger.recordPayout({
                    region,
                    ownerId: restaurant.ownerId,
                    amount: dto.amount,
                    currency: dto.currency,
                    providerReferenceId: dto.providerReferenceId,
                    note: dto.note ?? null,
                    idempotencyKey: key,
                }, trx);
                const after = await addToBalance(dto.restaurantId, dto.currency, -dto.amount, trx);
                change = {restaurantId: dto.restaurantId, currency: dto.currency, balance: after.balance};
            }
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }

        this.publishBalance(change);
        logger.info("payout recorded", {region, restaurantId: dto.restaurantId, payoutId: payout.id, amount: dto.amount, currency: dto.currency, correlationId});
        return PayoutResponseDTO.from(payout);
    }
}

// restaurant users read their own restaurant (JWT); admins must name one
function restaurantOf(user: JwtPayload, requested: number | undefined): number {
    if(user.role === SystemRole.ADMIN){
        if(!requested) throw RestaurantIdRequiredError;
        return requested;
    }
    if(!user.restaurantId) throw RestaurantNotFoundError;
    return Number(user.restaurantId);
}

function isPayoutCursor(value: unknown): value is PayoutCursor {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && !Number.isNaN(Date.parse(value[0])) && Number.isSafeInteger(value[1]);
}

function isPayoutCursorState(value: unknown): value is SourceCursors<PayoutCursor> {
    return isSourceCursors(value, isPayoutCursor);
}
