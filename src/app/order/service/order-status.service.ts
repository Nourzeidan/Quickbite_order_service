import {inject, injectable} from "tsyringe";
import {isUUID} from "class-validator";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import {RestaurantRole, SystemRole} from "../../../lib/auth/enums.js";
import {unAuthorizedError} from "../../../lib/auth/errors.js";
import type {PermissionCacheService} from "../../../lib/auth/permission-cache.service.js";
import type {StockClient} from "../../../lib/core-client/stock.client.js";
import {SecsToMS} from "../../../pkg/utils/time.js";
import {OrderActor, OrderStatus, PaymentMethod, type PatchableStatus} from "../enums.js";
import {
    CancellationWindowExpiredError,
    InvalidStatusTransitionError,
    OrderNotFoundError,
    ReasonRequiredError
} from "../errors.js";
import type {Order} from "../entity/order.entity.js";
import type {UpdateOrderStatusRequestDTO} from "../dto/order.request.dto.js";
import {OrderStatusResponseDTO} from "../dto/order.response.dto.js";
import {findOrderByPublicId, updateOrderStatus} from "../repository/order.repo.js";
import type {OrderCacheService} from "./order-cache.service.js";
import type {OrderEventsService} from "./order-events.service.js";
import type {DeliveryNotifierService} from "../../delivery/service/delivery-notifier.service.js";
import type {PaymentLedgerService} from "../../payment/service/payment-ledger.service.js";
import type {RefundService} from "../../payment/service/refund.service.js";
import {toPaymentRef} from "../payment-ref.js";

const {CUSTOMER, RESTAURANT, ADMIN, SYSTEM, AGENT} = OrderActor;

// docs/business-logic/orders.md §1.1 — who may move an order from -> to.
// admin can do every restaurant transition; system also cancels unpaid / un-reservable orders.
const TRANSITIONS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, OrderActor[]>>>> = {
    [OrderStatus.PENDING_PAYMENT]: {
        [OrderStatus.PLACED]: [SYSTEM],
        [OrderStatus.CANCELLED]: [CUSTOMER, ADMIN, SYSTEM],
    },
    [OrderStatus.PLACED]: {
        [OrderStatus.ACCEPTED]: [RESTAURANT, ADMIN],
        [OrderStatus.REJECTED]: [RESTAURANT, ADMIN],
        [OrderStatus.CANCELLED]: [CUSTOMER, RESTAURANT, ADMIN, SYSTEM],
    },
    [OrderStatus.ACCEPTED]: {
        [OrderStatus.PREPARING]: [RESTAURANT, ADMIN],
        [OrderStatus.CANCELLED]: [RESTAURANT, ADMIN],
    },
    [OrderStatus.PREPARING]: {
        [OrderStatus.READY]: [RESTAURANT, ADMIN],
        [OrderStatus.CANCELLED]: [RESTAURANT, ADMIN],
    },
    // Phase 3: agents choose orders (deliveries.md §2). Nobody assigns an agent except the agent.
    [OrderStatus.READY]: {
        [OrderStatus.ASSIGNED]: [AGENT],
        [OrderStatus.CANCELLED]: [RESTAURANT, ADMIN],
    },
    [OrderStatus.ASSIGNED]: {
        [OrderStatus.READY]: [AGENT, SYSTEM],           // released by the agent, or taken back from a silent agent
        [OrderStatus.PICKED]: [AGENT],
        [OrderStatus.CANCELLED]: [ADMIN],
    },
    [OrderStatus.PICKED]: {
        [OrderStatus.DELIVERED]: [AGENT],
    },
};

// the restaurant permission each PATCH target needs (rbac.md §4)
const RESTAURANT_ACTION: Record<PatchableStatus, string> = {
    [OrderStatus.ACCEPTED]: "accept",
    [OrderStatus.REJECTED]: "accept",
    [OrderStatus.PREPARING]: "update",
    [OrderStatus.READY]: "update",
    [OrderStatus.CANCELLED]: "cancel",
};

@injectable()
export class OrderStatusService {
    constructor(
        @inject(TOKENS.PermissionCacheService) private readonly permissionCache: PermissionCacheService,
        @inject(TOKENS.StockClient) private readonly stockClient: StockClient,
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService,
        @inject(TOKENS.PaymentLedgerService) private readonly ledger: PaymentLedgerService,
        @inject(TOKENS.RefundService) private readonly refundService: RefundService,
        @inject(TOKENS.OrderEventsService) private readonly orderEvents: OrderEventsService,
        @inject(TOKENS.DeliveryNotifierService) private readonly deliveryNotifier: DeliveryNotifierService
    ){}

    // the source statuses from which `actor` may move an order to `to` (for the conditional UPDATE)
    allowedSources = (to: OrderStatus, actor: OrderActor): OrderStatus[] => allowedSources(to, actor)

    assertTransition = (from: OrderStatus, to: OrderStatus, actor: OrderActor) => assertTransition(from, to, actor)

    // PATCH /orders/:publicId/status
    changeStatus = async (region: string, user: JwtPayload, publicId: string, data: UpdateOrderStatusRequestDTO, correlationId: string) => {
        if(!isUUID(publicId)){
            throw OrderNotFoundError;
        }
        // transitions always read Postgres, never the order cache
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if(!order){
            throw OrderNotFoundError;
        }

        const actor = await this.resolveActor(user, order, data.status, correlationId);
        const reason = data.reason?.trim() || null;
        const needsReason = data.status === OrderStatus.REJECTED || data.status === OrderStatus.CANCELLED;
        if(needsReason && !reason && actor !== CUSTOMER){
            throw ReasonRequiredError;
        }

        this.assertTransition(order.status, data.status, actor);
        if(actor === CUSTOMER){
            this.assertCustomerCanCancel(order);
        }

        // conditional write (Q-O8): only from the status we validated against.
        // reject / cancel also void the payment side in the same transaction (orders.md §5).
        const voiding = needsReason;
        let updated: Order | null;
        let refundIds: number[] = [];
        const trx = await conn.transaction();
        try{
            updated = await updateOrderStatus(order, [order.status], data.status, needsReason ? reason : null, trx);
            if(!updated){
                throw InvalidStatusTransitionError;
            }
            if(voiding){
                const ref = toPaymentRef(updated);
                const voidReason = `order ${data.status} by ${actor}${reason ? `: ${reason}` : ""}`;
                if(updated.paymentMethod === PaymentMethod.COD){
                    await this.ledger.voidCodCollection(ref, voidReason, trx);
                }else{
                    await this.ledger.cancelOpenSessions(ref, trx);
                    // paid online order: the refund is reserved in this trx (survives a crash after commit)
                    refundIds = await this.refundService.queueOrderRefunds(ref, voidReason, trx);
                }
            }
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }
        const changed: Order = updated;

        // after commit
        await this.orderCache.invalidate(region, changed.publicId);
        this.orderEvents.statusChanged(changed);
        if(changed.status === OrderStatus.CANCELLED || changed.status === OrderStatus.REJECTED){
            // agents: a ready order loses its open offers, an assigned one is taken from its agent
            if(order.status === OrderStatus.READY){
                await this.deliveryNotifier.withdrawOffers(region, changed.publicId, "order cancelled");
            }else if(order.status === OrderStatus.ASSIGNED && order.deliveryAgentId !== null){
                this.deliveryNotifier.taskCancelled(order.deliveryAgentId, changed.publicId, "order cancelled");
            }
        }
        if(voiding){
            this.stockClient.releaseStock(changed.branchId, changed.publicId, correlationId).catch((err) => {
                logger.error("stock release failed after cancel", {
                    region, orderPublicId: changed.publicId, correlationId, error: (err as Error).message,
                });
            });
            // send the reserved refunds to Kashier; not awaited (the PATCH doesn't wait for Kashier),
            // never throws, and the refund sweep sends anything this misses
            if(refundIds.length > 0){
                void this.refundService.sendQueued(region, refundIds, correlationId);
            }
        }

        return OrderStatusResponseDTO.from(changed);
    }

    // who the caller is for THIS order. Not related to the order -> 404 (no existence leak).
    private resolveActor = async (user: JwtPayload, order: Order, target: PatchableStatus, correlationId: string): Promise<OrderActor> => {
        switch(user.role){
            case SystemRole.ADMIN:
                return ADMIN;

            case SystemRole.CUSTOMER:
                if(order.customerId !== user.userId){
                    throw OrderNotFoundError;
                }
                if(target !== OrderStatus.CANCELLED){
                    throw unAuthorizedError;
                }
                return CUSTOMER;

            case SystemRole.RESTAURANT_USER: {
                if(!isRestaurantMemberOf(user, order)){
                    throw OrderNotFoundError;
                }
                const allowed = await this.permissionCache.hasPermission(user.restaurantRole, "order:order", RESTAURANT_ACTION[target], correlationId);
                if(!allowed){
                    throw unAuthorizedError;
                }
                return RESTAURANT;
            }

            default:
                throw OrderNotFoundError;
        }
    }

    // pending_payment: any time. placed: within the window and before the restaurant accepted.
    private assertCustomerCanCancel = (order: Order) => {
        if(order.status === OrderStatus.PENDING_PAYMENT){
            return;
        }
        const windowEndsAt = order.createdAt.getTime() + SecsToMS(env.orders.customerCancelWindowSec);
        if(order.acceptedAt !== null || Date.now() > windowEndsAt){
            throw CancellationWindowExpiredError;
        }
    }
}

// restaurant_user sees orders of their restaurant; non-owners only of their branches (rbac.md §5)
export function isRestaurantMemberOf(user: JwtPayload, order: Order): boolean {
    if(Number(user.restaurantId) !== order.restaurantId){
        return false;
    }
    if(user.restaurantRole === RestaurantRole.OWNER){
        return true;
    }
    return (user.branchIds ?? []).map(Number).includes(order.branchId);
}


// the source statuses from which `actor` may move an order to `to` (for conditional UPDATEs)
export function allowedSources(to: OrderStatus, actor: OrderActor): OrderStatus[] {
    return (Object.keys(TRANSITIONS) as OrderStatus[])
        .filter((from) => TRANSITIONS[from]?.[to]?.includes(actor));
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor) {
    if(!TRANSITIONS[from]?.[to]?.includes(actor)){
        throw InvalidStatusTransitionError;
    }
}
