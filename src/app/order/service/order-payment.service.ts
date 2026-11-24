import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import type {StockClient} from "../../../lib/core-client/stock.client.js";
import {OrderActor, OrderStatus} from "../enums.js";
import type {Order} from "../entity/order.entity.js";
import {
    findOrderByPublicId,
    findOrderByRef,
    lockExpiredPendingPaymentOrders,
    updateOrderStatus,
    updateOrdersStatus
} from "../repository/order.repo.js";
import {isRestaurantMemberOf, type OrderStatusService} from "./order-status.service.js";
import type {OrderCacheService} from "./order-cache.service.js";
import type {OrderEventsService} from "./order-events.service.js";
import {countItemsByOrders} from "../repository/order-item.repo.js";
import {db} from "../../../lib/knex/knex.js";

// What the payment module may do with orders (it never touches the order tables itself).
// Every method that writes takes the caller's trx; side effects run in the after* methods, after commit.
@injectable()
export class OrderPaymentService {
    constructor(
        @inject(TOKENS.OrderStatusService) private readonly orderStatusService: OrderStatusService,
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService,
        @inject(TOKENS.StockClient) private readonly stockClient: StockClient,
        @inject(TOKENS.OrderEventsService) private readonly orderEvents: OrderEventsService
    ){}

    // Q-O1 — always Postgres, never the order cache (payment decisions)
    findByPublicId = async (publicId: string, conn: Knex): Promise<Order | null> => {
        return findOrderByPublicId(publicId, conn);
    }

    // Q-O10
    findByRef = async (ref: {id: number; createdAt: Date}, conn: Knex, forUpdate = false): Promise<Order | null> => {
        return findOrderByRef(ref, conn, forUpdate);
    }

    canRestaurantUserRead = (user: JwtPayload, order: Order): boolean => isRestaurantMemberOf(user, order)

    // verified capture: pending_payment -> placed. null = the order was no longer pending (cancelled / already placed)
    markPaid = async (order: Order, trx: Knex): Promise<Order | null> => {
        this.orderStatusService.assertTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PLACED, OrderActor.SYSTEM);
        return updateOrderStatus(order, [OrderStatus.PENDING_PAYMENT], OrderStatus.PLACED, null, trx);
    }

    // Q-O4 + Q-O8 (batch) — the sweep's part on orders
    cancelExpiredUnpaid = async (timeoutMin: number, limit: number, reason: string, trx: Knex): Promise<{locked: number; cancelled: Order[]}> => {
        const locked = await lockExpiredPendingPaymentOrders(timeoutMin, limit, trx);
        const cancelled = await updateOrdersStatus(locked, [OrderStatus.PENDING_PAYMENT], OrderStatus.CANCELLED, reason, trx);
        return {locked: locked.length, cancelled};
    }

    // the paid order enters the restaurant's queue (payment.captured itself is emitted by the payment module)
    afterPaid = async (order: Order) => {
        await this.orderCache.invalidate(order.region, order.publicId);
        const counts = await countItemsByOrders([order], db(order.region));     // Q-O7
        this.orderEvents.created(order, counts.get(order.id) ?? 0);
        this.orderEvents.statusChanged(order);
    }

    afterSystemCancel = async (orders: Order[], correlationId: string) => {
        if(orders.length === 0){
            return;
        }
        await this.orderCache.invalidateMany(orders.map((order) => ({region: order.region, publicId: order.publicId})));
        // ONE core call for the whole batch (not one per order)
        this.stockClient.releaseStockBatch(orders.map((order) => ({branchId: order.branchId, orderPublicId: order.publicId})), correlationId)
            .catch((err) => {
                logger.error("stock release failed after payment timeout", {
                    orders: orders.length, correlationId, error: (err as Error).message,
                });
            });
        for(const order of orders){
            this.orderEvents.statusChanged(order);                  // order.cancelled
        }
    }
}
