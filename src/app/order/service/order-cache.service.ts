import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {logger} from "../../../lib/logger/logger.js";
import type {ICacheProvider} from "../../../pkg/cache/cache.interface.js";
import {Order} from "../entity/order.entity.js";
import {OrderItem} from "../entity/order-item.entity.js";
import {findOrderByPublicId} from "../repository/order.repo.js";
import {findItemsByOrders} from "../repository/order-item.repo.js";

// short: the key is deleted on every change, the TTL only covers a missed delete
const ORDER_CACHE_TTL_SEC = 5;

const ORDER_DATE_FIELDS = [
    "createdAt", "updatedAt", "acceptedAt", "rejectedAt", "readyAt",
    "assignedAt", "pickedAt", "deliveredAt", "cancelledAt"
] as const;

export interface OrderSnapshot {
    order: Order;
    items: OrderItem[];
}

// Read-through cache of the order DATA (row + items) for GET /orders/:publicId.
// One key per order, shared by every caller: authorization runs on each request in the service,
// never in the cache. Status changes and money decisions always read Postgres, never this.
@injectable()
export class OrderCacheService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider){}

    // null = no such order (not cached, so a just-created order is never hidden)
    getOrLoad = async (region: string, publicId: string, conn: Knex): Promise<OrderSnapshot | null> => {
        const key = orderCacheKey(region, publicId);

        try{
            const cached = await this.cacheProvider.get(key);
            if(cached){
                return revive(JSON.parse(cached));
            }
        }catch(err){
            // Redis down -> Postgres
            logger.warn("order cache read failed", {region, orderPublicId: publicId, error: (err as Error).message});
        }

        const order = await findOrderByPublicId(publicId, conn);
        if(!order){
            return null;
        }
        const items = await findItemsByOrders([order], conn);

        this.cacheProvider.set(key, JSON.stringify({order, items}), ORDER_CACHE_TTL_SEC).catch((err) => {
            logger.warn("order cache write failed", {region, orderPublicId: publicId, error: (err as Error).message});
        });
        return {order, items};
    }

    // call AFTER the change is committed
    invalidate = async (region: string, publicId: string): Promise<void> => {
        try{
            await this.cacheProvider.del(orderCacheKey(region, publicId));
        }catch(err){
            // the 5 s TTL bounds the staleness
            logger.warn("order cache invalidation failed", {region, orderPublicId: publicId, error: (err as Error).message});
        }
    }
}

function orderCacheKey(region: string, publicId: string): string {
    return `${region}:order:${publicId}`;
}

// JSON turns Dates into ISO strings: turn them back so the DTOs work the same on hit and miss
function revive(raw: {order: Record<string, unknown>; items: Record<string, unknown>[]}): OrderSnapshot {
    const orderData: Record<string, unknown> = {...raw.order};
    for(const field of ORDER_DATE_FIELDS){
        const value = orderData[field];
        orderData[field] = typeof value === "string" ? new Date(value) : null;
    }
    return {
        order: new Order(orderData as Partial<Order>),
        items: raw.items.map((item) => new OrderItem({...item, createdAt: new Date(item.createdAt as string)} as Partial<OrderItem>)),
    };
}
