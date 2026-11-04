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
import {OrderActor, OrderStatus, type PatchableStatus} from "../enums.js";
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
    [OrderStatus.READY]: {
        [OrderStatus.ASSIGNED]: [SYSTEM, ADMIN],
        [OrderStatus.CANCELLED]: [RESTAURANT, ADMIN],
    },
    [OrderStatus.ASSIGNED]: {
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
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService
    ){}

    // the source statuses from which `actor` may move an order to `to` (for the conditional UPDATE)
    allowedSources = (to: OrderStatus, actor: OrderActor): OrderStatus[] => {
        return (Object.keys(TRANSITIONS) as OrderStatus[])
            .filter((from) => TRANSITIONS[from]?.[to]?.includes(actor));
    }

    assertTransition = (from: OrderStatus, to: OrderStatus, actor: OrderActor) => {
        if(!TRANSITIONS[from]?.[to]?.includes(actor)){
            throw InvalidStatusTransitionError;
        }
    }

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

        // conditional write (Q-O8): only from the status we validated against
        const updated = await updateOrderStatus(order, [order.status], data.status, needsReason ? reason : null, conn);
        if(!updated){
            throw InvalidStatusTransitionError;
        }

        // after commit. refunds (Phase 2), delivery cancel (Phase 3), WS + list caches (Phase 6) hook in here.
        await this.orderCache.invalidate(region, updated.publicId);
        if(updated.status === OrderStatus.REJECTED || updated.status === OrderStatus.CANCELLED){
            this.stockClient.releaseStock(updated.branchId, updated.publicId, correlationId).catch((err) => {
                logger.error("stock release failed after cancel", {
                    region, orderPublicId: updated.publicId, correlationId, error: (err as Error).message,
                });
            });
        }

        return OrderStatusResponseDTO.from(updated);
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
