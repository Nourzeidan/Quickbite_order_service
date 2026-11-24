import type {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {sendPaginated, sendSuccess} from "../../../lib/http/response.js";
import {validateBody, validateQuery} from "../../../lib/validation/validate.js";
import {CreatePayoutRequestDTO, RestaurantBalanceQueryDTO, RestaurantPayoutsQueryDTO} from "../dto/finance.request.dto.js";
import type {FinanceService} from "../service/finance.service.js";

// /restaurant/balance, /restaurant/payouts (restaurant-finance.md §2-4)
@injectable()
export class FinanceController {
    constructor(
        @inject(TOKENS.FinanceService) private readonly financeService: FinanceService
    ){}

    balance = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(RestaurantBalanceQueryDTO, req.query);
            sendSuccess(res, await this.financeService.getBalance(req.region!, req.user!, query));
        }catch(err){
            next(err);
        }
    }

    payouts = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(RestaurantPayoutsQueryDTO, req.query);
            const result = await this.financeService.listPayouts(req.region!, req.user!, query, req.correlationId);
            sendPaginated(res, result.data, result.meta);
        }catch(err){
            next(err);
        }
    }

    createPayout = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(CreatePayoutRequestDTO, req.body);
            // hash of admin + method + path + Idempotency-Key: one payout per admin request
            const payout = await this.financeService.recordPayout(req.region!, data, req.idempotency!.keyHash.toString("hex"), req.correlationId);
            sendSuccess(res, payout, 201);
        }catch(err){
            next(err);
        }
    }
}
