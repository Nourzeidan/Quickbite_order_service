import {inject, injectable} from "tsyringe";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import type {BranchClient} from "../../../lib/core-client/branch.client.js";
import {boundingBox} from "../../../pkg/utils/geo.js";
import {startOfUtcYear} from "../../../pkg/utils/time.js";
import {OrderActor, OrderStatus} from "../enums.js";
import type {Order} from "../entity/order.entity.js";
import type {OrderRef} from "../types.js";
import {
    assignOrderToAgent,
    findActiveOrdersByAgents,
    findOrderByPublicId,
    findOrdersByRefs,
    listOrders,
    listOrdersForDispatch,
    listReadyOrdersInBox,
    releaseOrderFromAgent,
    releaseOrdersFromAgents,
    updateOrderStatusByAgent
} from "../repository/order.repo.js";
import {countItemsByOrders} from "../repository/order-item.repo.js";
import {assertTransition} from "./order-status.service.js";
import type {OrderCacheService} from "./order-cache.service.js";
import type {AgentSnapshot, OrderEventsService} from "./order-events.service.js";

export interface PickupPoint {
    lat: number;
    lng: number;
}

// What the delivery / agent modules may do with orders (deliveries.md). They never touch the order
// tables themselves. Writes take the caller's trx; afterChange() runs after commit.
@injectable()
export class OrderDeliveryService {
    constructor(
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService,
        @inject(TOKENS.OrderEventsService) private readonly orderEvents: OrderEventsService,
        @inject(TOKENS.BranchClient) private readonly branchClient: BranchClient
    ){}

    // Q-O1 — always Postgres (delivery decisions)
    findByPublicId = (publicId: string, conn: Knex): Promise<Order | null> => findOrderByPublicId(publicId, conn)

    findByRefs = (refs: OrderRef[], conn: Knex): Promise<Order[]> => findOrdersByRefs(refs, conn)

    // Q-O5
    listReadyUnassigned = (limit: number, conn: Knex): Promise<Order[]> => listOrdersForDispatch(OrderStatus.READY, limit, conn)
    listAssigned = (limit: number, conn: Knex): Promise<Order[]> => listOrdersForDispatch(OrderStatus.ASSIGNED, limit, conn)

    // Q-O5 + pickup box: ready orders around a point (caller checks the exact distance)
    listReadyNear = (lat: number, lng: number, radiusMeters: number, limit: number, conn: Knex): Promise<Order[]> =>
        listReadyOrdersInBox(boundingBox(lat, lng, radiusMeters), limit, conn)

    // Q-O6 — orders held by these agents (assigned / picked)
    findActiveByAgents = (agentIds: number[], conn: Knex): Promise<Order[]> => findActiveOrdersByAgents(agentIds, conn)

    findActiveByAgent = async (agentId: number, conn: Knex): Promise<Order | null> =>
        (await findActiveOrdersByAgents([agentId], conn))[0] ?? null

    // Q-O7 — items per order for task DTOs, one grouped query
    countItems = (orders: Order[], conn: Knex): Promise<Map<number, number>> => countItemsByOrders(orders, conn)

    // Q-O6 via the list query: an agent's orders this year, newest first, keyset page
    listForAgent = (agentId: number, status: OrderStatus | undefined, cursor: {createdAt: Date; publicId: string} | null, limit: number, conn: Knex): Promise<Order[]> => {
        const now = new Date();
        const filter: {deliveryAgentId: number; status?: OrderStatus} = {deliveryAgentId: agentId};
        if(status) filter.status = status;
        return listOrders(filter, {from: startOfUtcYear(now.getUTCFullYear()), to: new Date(now.getTime() + 1)}, {cursor, limit}, conn);
    }

    // where the agent picks the order up: the snapshot on the row, or (orders placed before Phase 3) the cached branch
    pickupOf = async (orders: Order[], correlationId: string): Promise<Map<number, PickupPoint>> => {
        const result = new Map<number, PickupPoint>();
        const missingBranches = new Set<number>();
        for(const order of orders){
            if(order.pickupLat !== null && order.pickupLng !== null) result.set(order.id, {lat: order.pickupLat, lng: order.pickupLng});
            else missingBranches.add(order.branchId);
        }
        if(missingBranches.size > 0){
            // all branches at once: one MGET + one core call for the misses
            const branches = await this.branchClient.getBranches([...missingBranches], correlationId);
            for(const order of orders){
                const branch = branches.get(order.branchId);
                if(!result.has(order.id) && branch) result.set(order.id, {lat: branch.lat, lng: branch.lng});
            }
        }
        return result;
    }

    // ready -> assigned (the agent accepted). null = someone else was faster / it's no longer ready
    assign = (order: Order, agentId: number, trx: Knex): Promise<Order | null> => {
        assertTransition(OrderStatus.READY, OrderStatus.ASSIGNED, OrderActor.AGENT);
        return assignOrderToAgent(order, agentId, trx);
    }

    // assigned -> ready (agent released it, went offline, or went silent)
    release = (order: Order, agentId: number, actor: OrderActor.AGENT | OrderActor.SYSTEM, trx: Knex): Promise<Order | null> => {
        assertTransition(OrderStatus.ASSIGNED, OrderStatus.READY, actor);
        return releaseOrderFromAgent(order, agentId, trx);
    }

    // many assigned orders back to ready in ONE statement (the worker's stale take-back)
    releaseMany = (orders: Order[], trx: Knex): Promise<Order[]> => {
        assertTransition(OrderStatus.ASSIGNED, OrderStatus.READY, OrderActor.SYSTEM);
        return releaseOrdersFromAgents(orders.filter((order) => order.deliveryAgentId !== null)
            .map((order) => ({id: order.id, createdAt: order.createdAt, agentId: order.deliveryAgentId!})), trx);
    }

    markPicked = (order: Order, agentId: number, trx: Knex): Promise<Order | null> => {
        assertTransition(OrderStatus.ASSIGNED, OrderStatus.PICKED, OrderActor.AGENT);
        return updateOrderStatusByAgent(order, agentId, OrderStatus.ASSIGNED, OrderStatus.PICKED, null, trx);
    }

    markDelivered = (order: Order, agentId: number, commission: number, trx: Knex): Promise<Order | null> => {
        assertTransition(OrderStatus.PICKED, OrderStatus.DELIVERED, OrderActor.AGENT);
        return updateOrderStatusByAgent(order, agentId, OrderStatus.PICKED, OrderStatus.DELIVERED, commission, trx);
    }

    // after commit, many orders without an agent: ONE cache DEL, then the events
    afterChangeMany = async (orders: Order[]) => {
        await this.orderCache.invalidateMany(orders.map((order) => ({region: order.region, publicId: order.publicId})));
        for(const order of orders) this.orderEvents.statusChanged(order, null);
    }

    // after commit: cache + order.status_changed (with the agent) to customer and branch
    afterChange = async (order: Order, agent: AgentSnapshot | null) => {
        await this.orderCache.invalidate(order.region, order.publicId);
        this.orderEvents.statusChanged(order, agent);
    }
}
