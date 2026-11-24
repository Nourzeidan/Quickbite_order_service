import {inject, injectable} from "tsyringe";
import {v4 as uuidv4} from "uuid";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {OrderPaymentService} from "../../order/service/order-payment.service.js";
import type {RefundService} from "./refund.service.js";
import {CANCEL_REASON_PAYMENT_TIMEOUT, PaymentSessionStatus} from "../enums.js";
import {closeOpenSessionsByOrders} from "../repository/payment-session.repo.js";

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 20;

// payments.md §5 — every PAYMENT_SWEEP_INTERVAL_SEC, every shard:
//  1. unpaid online orders older than session timeout + grace -> cancelled (FOR UPDATE SKIP LOCKED:
//     safe on every instance). The grace lets a payment finished in the session's last seconds
//     arrive before we cancel (otherwise: cancel + automatic refund).
//  2. refunds: send queued ones nobody sent, alert on sent ones with no outcome (RefundService.reconcile)
@injectable()
export class PaymentSweepService {
    constructor(
        @inject(TOKENS.OrderPaymentService) private readonly orderPayments: OrderPaymentService,
        @inject(TOKENS.RefundService) private readonly refundService: RefundService
    ){}

    run = async () => {
        for(const region of env.regions){
            // one shard down must not stop the others; one step failing must not skip the other
            try{
                await this.sweepRegion(region);
            }catch(err){
                logger.error("payment sweep failed", {region, error: (err as Error).message});
            }
            try{
                await this.refundService.reconcile(region, `refund-sweep:${uuidv4()}`);
            }catch(err){
                logger.error("refund sweep failed", {region, error: (err as Error).message});
            }
        }
    }

    private sweepRegion = async (region: string) => {
        const correlationId = `payment-sweep:${uuidv4()}`;
        const conn = db(region);
        let total = 0;

        for(let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++){
            const trx = await conn.transaction();
            let locked: number;
            let cancelled;
            try{
                ({locked, cancelled} = await this.orderPayments.cancelExpiredUnpaid(
                    env.payments.sessionTimeoutMin + env.payments.sweepGraceMin, BATCH_SIZE, CANCEL_REASON_PAYMENT_TIMEOUT, trx
                ));
                await closeOpenSessionsByOrders(cancelled, PaymentSessionStatus.EXPIRED, trx);
                await trx.commit();
            }catch(err){
                await trx.rollback();
                throw err;
            }

            if(cancelled.length > 0){
                await this.orderPayments.afterSystemCancel(cancelled, correlationId);
                total += cancelled.length;
            }
            if(locked < BATCH_SIZE){
                break;
            }
        }
        if(total > 0){
            logger.info("unpaid orders cancelled", {region, count: total, correlationId});
        }
    }
}
