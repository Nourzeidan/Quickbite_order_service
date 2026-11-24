import type {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {sendSuccess} from "../../../lib/http/response.js";
import {validateBody} from "../../../lib/validation/validate.js";
import {InitPaymentRequestDTO, RefundRequestDTO} from "../dto/payment.request.dto.js";
import type {PaymentService} from "../service/payment.service.js";
import type {RefundService} from "../service/refund.service.js";

// req.user / req.region / req.idempotency are guaranteed by the route's middleware
@injectable()
export class PaymentController {
    constructor(
        @inject(TOKENS.PaymentService) private readonly paymentService: PaymentService,
        @inject(TOKENS.RefundService) private readonly refundService: RefundService
    ){}

    init = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(InitPaymentRequestDTO, req.body);
            const result = await this.paymentService.init(req.region!, req.user!, data, req.idempotency, req.correlationId);
            if(result.replayed){
                res.setHeader("Idempotent-Replayed", "true");
            }
            sendSuccess(res, result.session);
        }catch(err){
            next(err);
        }
    }

    getById = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const payment = await this.paymentService.getById(req.region!, req.user!, Number(req.params.paymentId));
            sendSuccess(res, payment);
        }catch(err){
            next(err);
        }
    }

    refund = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(RefundRequestDTO, req.body);
            const result = await this.refundService.refundByAdmin({
                region: req.region!,
                chargeId: Number(req.params.paymentId),
                amount: data.amount,
                reason: data.reason,
                // hash of user + method + path + Idempotency-Key: unique per admin request
                idempotencyKey: `admin-refund:${req.idempotency!.keyHash.toString("hex")}`,
                correlationId: req.correlationId,
            });
            sendSuccess(res, result, 202);
        }catch(err){
            next(err);
        }
    }
}
