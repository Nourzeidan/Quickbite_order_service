import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {BranchClient} from "../../../lib/core-client/branch.client.js";
import type {RestaurantClient} from "../../../lib/core-client/restaurant.client.js";
import {applyBps} from "../../../pkg/utils/money.js";
import {InvalidStatusTransitionError} from "../../order/errors.js";
import type {Order} from "../../order/entity/order.entity.js";
import {toPaymentRef} from "../../order/payment-ref.js";
import type {OrderDeliveryService} from "../../order/service/order-delivery.service.js";
import type {PaymentLedgerService} from "../../payment/service/payment-ledger.service.js";
import type {FinanceService} from "../../restaurant-finance/service/finance.service.js";
import type {AgentEarningService} from "../../agent/service/agent-earning.service.js";
import {OrderNotReadyForDeliveryError} from "../errors.js";

export interface SettlementResult {
    order: Order;
    commission: number;
    restaurantCredit: number;
    agentEarning: number;
}

// deliveries.md §6 — picked -> delivered and all the money that follows, in ONE transaction.
// Any failure rolls back everything: no partial settlement.
@injectable()
export class SettlementService {
    constructor(
        @inject(TOKENS.OrderDeliveryService) private readonly orders: OrderDeliveryService,
        @inject(TOKENS.PaymentLedgerService) private readonly ledger: PaymentLedgerService,
        @inject(TOKENS.FinanceService) private readonly finance: FinanceService,
        @inject(TOKENS.AgentEarningService) private readonly earnings: AgentEarningService,
        @inject(TOKENS.BranchClient) private readonly branchClient: BranchClient,
        @inject(TOKENS.RestaurantClient) private readonly restaurantClient: RestaurantClient
    ){}

    settle = async (order: Order, agentId: number, correlationId: string): Promise<SettlementResult> => {
        // core data first: no network call inside the transaction
        const [branch, restaurant] = await Promise.all([
            this.branchClient.getBranch(order.branchId, correlationId),
            this.restaurantClient.getRestaurant(order.restaurantId, correlationId),
        ]);
        if(!branch || !restaurant){
            logger.error("ALERT settlement without branch / restaurant data", {region: order.region, orderPublicId: order.publicId});
            throw OrderNotReadyForDeliveryError;
        }
        const commission = Math.min(applyBps(order.subtotal, branch.commission), order.subtotal);
        const restaurantCredit = order.subtotal - commission;
        const agentEarning = applyBps(order.deliveryFee, env.delivery.agentShareBps);

        const trx = await db(order.region).transaction();
        let delivered: Order;
        let balance: number;
        try{
            // 1. the transition itself (only once, only by this agent)
            const moved = await this.orders.markDelivered(order, agentId, commission, trx);
            if(!moved){
                throw InvalidStatusTransitionError;
            }
            delivered = moved;
            const ref = toPaymentRef(delivered);
            // 2-3. COD collected / online charge checked + commission row
            const {refundedAmount} = await this.ledger.settleDelivery(ref, delivered.paymentMethod, restaurant.ownerId, commission, trx);
            // 4. restaurant balance
            const credited = await this.finance.creditSettlement({
                restaurantId: delivered.restaurantId, region: delivered.region, currency: delivered.currency, amount: restaurantCredit,
            }, trx);
            balance = credited.balance;
            // 4b. refunds that succeeded while the order was on its way: take the restaurant's share back now
            //     (later refunds are taken back by the refund webhook; the order row lock keeps the two apart)
            if(refundedAmount > 0){
                const debit = await this.finance.debitForRefund(delivered, refundedAmount, `settlement:${delivered.publicId}`, trx);
                if(debit) balance = debit.balance;
            }
            // 5. agent earning (unique per order)
            await this.earnings.record({region: delivered.region, agentId, order: delivered, amount: agentEarning}, trx);
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }

        this.finance.publishBalance({restaurantId: delivered.restaurantId, currency: delivered.currency, balance});
        logger.info("order settled", {
            region: delivered.region, orderPublicId: delivered.publicId, commission, restaurantCredit, agentEarning, correlationId,
        });
        return {order: delivered, commission, restaurantCredit, agentEarning};
    }
}
