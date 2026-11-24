import type {PaymentOrderRef} from "../payment/types.js";
import type {Order} from "./entity/order.entity.js";

// the slice of an order the payment module works with
export function toPaymentRef(order: Order): PaymentOrderRef {
    return {
        id: order.id,
        createdAt: order.createdAt,
        publicId: order.publicId,
        region: order.region,
        customerId: order.customerId,
        restaurantId: order.restaurantId,
        total: order.total,
        currency: order.currency,
    };
}
