import {inject, injectable} from "tsyringe";
import {isUUID} from "class-validator";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import type {UserClient} from "../../../lib/core-client/user.client.js";
import {distanceMeters} from "../../../pkg/utils/geo.js";
import {OrderActor, OrderStatus} from "../../order/enums.js";
import {InvalidStatusTransitionError, OrderNotFoundError} from "../../order/errors.js";
import type {Order} from "../../order/entity/order.entity.js";
import type {OrderDeliveryService} from "../../order/service/order-delivery.service.js";
import type {AgentSnapshot} from "../../order/service/order-events.service.js";
import type {PresenceService} from "../../agent/service/presence.service.js";
import {AGENT_LOCK_CLASS, DeliveryAction} from "../enums.js";
import {
    AgentHasActiveDeliveryError,
    AgentNotOnlineError,
    AgentTooFarError,
    OrderAlreadyTakenError,
    OrderNotReadyForDeliveryError
} from "../errors.js";
import type {UpdateDeliveryStatusRequestDTO} from "../dto/delivery.request.dto.js";
import {AgentTaskResponseDTO, DeliveryStatusResponseDTO} from "../dto/delivery.response.dto.js";
import type {DeliveryNotifierService} from "./delivery-notifier.service.js";
import type {SettlementService} from "./settlement.service.js";

// deliveries.md §2, §4 — the agent side of a delivery: accept, decline, release, picked, delivered.
@injectable()
export class DeliveryService {
    constructor(
        @inject(TOKENS.OrderDeliveryService) private readonly orders: OrderDeliveryService,
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.DeliveryNotifierService) private readonly notifier: DeliveryNotifierService,
        @inject(TOKENS.SettlementService) private readonly settlement: SettlementService,
        @inject(TOKENS.UserClient) private readonly userClient: UserClient
    ){}

    // POST /deliveries/:orderPublicId/accept — first accept wins
    accept = async (region: string, user: JwtPayload, publicId: string, correlationId: string): Promise<AgentTaskResponseDTO> => {
        const agentId = user.userId;
        const conn = db(region);
        const order = await this.findOrder(publicId, conn);
        if(order.deliveryAgentId === agentId && order.status === OrderStatus.ASSIGNED){
            return this.taskDto(order, null, correlationId);       // a retried tap: already theirs
        }
        if(order.status !== OrderStatus.READY){
            throw order.status === OrderStatus.ASSIGNED || order.status === OrderStatus.PICKED ? OrderAlreadyTakenError : OrderNotReadyForDeliveryError;
        }

        // the agent must be online and near the pickup (their last ping)
        const location = await this.presence.getOnline(region, agentId);
        if(!location){
            throw AgentNotOnlineError;
        }
        const pickup = (await this.orders.pickupOf([order], correlationId)).get(order.id) ?? null;
        const distance = pickup ? distanceMeters(location.lat, location.lng, pickup.lat, pickup.lng) : null;
        if(distance !== null && distance > env.delivery.radiusMeters){
            throw AgentTooFarError;
        }

        let assigned: Order;
        const trx = await conn.transaction();
        try{
            // one order per agent: serialize this agent's accepts (two taps / two devices) on this shard
            await trx.raw("SELECT pg_advisory_xact_lock(?::int, ?::int)", [AGENT_LOCK_CLASS, agentId]);
            if(await this.orders.findActiveByAgent(agentId, trx)){
                throw AgentHasActiveDeliveryError;
            }
            const won = await this.orders.assign(order, agentId, trx);
            if(!won){
                throw OrderAlreadyTakenError;
            }
            assigned = won;
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }

        // after commit
        await this.notifier.withdrawOffers(region, publicId, "taken by another agent", agentId);
        const agent = await this.agentSnapshot(agentId, correlationId);
        await this.orders.afterChange(assigned, agent);
        logger.info("order accepted by agent", {region, orderPublicId: publicId, agentId, correlationId});
        return this.taskDto(assigned, distance, correlationId);
    }

    // POST /deliveries/:orderPublicId/decline — offer only, no order change
    decline = async (region: string, user: JwtPayload, publicId: string): Promise<void> => {
        const order = await this.findOrder(publicId, db(region));
        await this.notifier.markDeclined(region, order.publicId, user.userId);
    }

    // PATCH /deliveries/:orderPublicId/status — only the order's agent
    updateStatus = async (region: string, user: JwtPayload, publicId: string, data: UpdateDeliveryStatusRequestDTO, correlationId: string): Promise<DeliveryStatusResponseDTO> => {
        const agentId = user.userId;
        const conn = db(region);
        const order = await this.findOrder(publicId, conn);
        if(order.deliveryAgentId !== agentId){
            throw OrderNotFoundError;                               // not their order: no existence leak
        }

        switch(data.status){
            case DeliveryAction.PICKED: {
                const trx = await conn.transaction();
                let picked: Order | null;
                try{
                    picked = await this.orders.markPicked(order, agentId, trx);
                    await trx.commit();
                }catch(err){
                    await trx.rollback();
                    throw err;
                }
                if(!picked) throw InvalidStatusTransitionError;
                await this.orders.afterChange(picked, await this.agentSnapshot(agentId, correlationId));
                return DeliveryStatusResponseDTO.from(picked);
            }
            case DeliveryAction.DELIVERED: {
                if(order.status !== OrderStatus.PICKED) throw InvalidStatusTransitionError;
                const {order: delivered} = await this.settlement.settle(order, agentId, correlationId);
                await this.orders.afterChange(delivered, await this.agentSnapshot(agentId, correlationId));
                return DeliveryStatusResponseDTO.from(delivered);
            }
            case DeliveryAction.RELEASED: {
                const released = await this.release(order, agentId, OrderActor.AGENT, data.reason?.trim() || "released by the agent", correlationId);
                if(!released) throw InvalidStatusTransitionError;
                return DeliveryStatusResponseDTO.from(released);
            }
        }
    }

    // assigned -> ready: the agent released it, went offline, or went silent (worker). The agent is
    // never offered this order again. null = it wasn't assigned to them any more.
    release = async (order: Order, agentId: number, actor: OrderActor.AGENT | OrderActor.SYSTEM, reason: string, correlationId: string): Promise<Order | null> => {
        const trx = await db(order.region).transaction();
        let released: Order | null;
        try{
            released = await this.orders.release(order, agentId, actor, trx);
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }
        if(!released){
            return null;
        }
        await this.notifier.markDeclined(order.region, order.publicId, agentId);
        if(actor === OrderActor.SYSTEM){
            this.notifier.taskCancelled(agentId, order.publicId, reason);
        }
        await this.orders.afterChange(released, null);
        logger.info("order released back to ready", {region: order.region, orderPublicId: order.publicId, agentId, actor, reason, correlationId});
        return released;
    }

    agentSnapshot = async (agentId: number, correlationId: string): Promise<AgentSnapshot> => {
        const user = await this.userClient.getUserSafe(agentId, correlationId);
        return {id: agentId, name: user?.name ?? "", phone: user?.phone ?? null};
    }

    private taskDto = async (order: Order, distance: number | null, correlationId: string): Promise<AgentTaskResponseDTO> => {
        const conn = db(order.region);
        const [counts, pickups] = await Promise.all([
            this.orders.countItems([order], conn),
            this.orders.pickupOf([order], correlationId),
        ]);
        return AgentTaskResponseDTO.from(order, counts.get(order.id) ?? 0, pickups.get(order.id) ?? null, distance);
    }

    private findOrder = async (publicId: string, conn: Parameters<OrderDeliveryService["findByPublicId"]>[1]): Promise<Order> => {
        if(!isUUID(publicId)){
            throw OrderNotFoundError;
        }
        const order = await this.orders.findByPublicId(publicId, conn);
        if(!order){
            throw OrderNotFoundError;
        }
        return order;
    }
}
