import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import type {Order} from "../entity/order.entity.js";
import {OrderStatus} from "../enums.js";
import {OrderSummaryResponseDTO} from "../dto/order.response.dto.js";

// the agent shown to customers / branches with delivery statuses
export interface AgentSnapshot {
    id: number;
    name: string;
    phone: string | null;
}

// Order events of realtime.md §5. Call after commit.
@injectable()
export class OrderEventsService {
    constructor(
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher
    ){}

    // a new order entered the restaurant's queue: COD at placement, online after the capture
    created = (order: Order, itemsCount: number) => {
        this.ws.publish([Rooms.branch(order.branchId), Rooms.restaurant(order.restaurantId)],
            "order.created", OrderSummaryResponseDTO.from(order, itemsCount));
    }

    // any status change. cancellations go out as order.cancelled (with the reason, to the restaurant too)
    statusChanged = (order: Order, agent: AgentSnapshot | null = null) => {
        if(order.status === OrderStatus.CANCELLED){
            this.ws.publish([Rooms.customer(order.customerId), Rooms.branch(order.branchId), Rooms.restaurant(order.restaurantId)],
                "order.cancelled", {orderPublicId: order.publicId, reason: order.cancelReason, updatedAt: order.updatedAt.toISOString()});
            return;
        }
        this.ws.publish([Rooms.customer(order.customerId), Rooms.branch(order.branchId)],
            "order.status_changed", {orderPublicId: order.publicId, status: order.status, updatedAt: order.updatedAt.toISOString(), agent});
    }
}
