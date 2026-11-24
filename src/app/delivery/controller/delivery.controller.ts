import type {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {sendPaginated, sendSuccess} from "../../../lib/http/response.js";
import {validateBody, validateQuery} from "../../../lib/validation/validate.js";
import {AgentEarningsQueryDTO, AgentTasksQueryDTO, PresenceRequestDTO, UpdateDeliveryStatusRequestDTO} from "../dto/delivery.request.dto.js";
import type {DeliveryService} from "../service/delivery.service.js";
import type {AgentService} from "../../agent/service/agent.service.js";

// /deliveries/* and /agents/* — every route is requireRole(delivery_agent) + requireRegion
@injectable()
export class DeliveryController {
    constructor(
        @inject(TOKENS.DeliveryService) private readonly deliveryService: DeliveryService,
        @inject(TOKENS.AgentService) private readonly agentService: AgentService
    ){}

    accept = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const task = await this.deliveryService.accept(req.region!, req.user!, String(req.params.orderPublicId), req.correlationId);
            sendSuccess(res, task);
        }catch(err){
            next(err);
        }
    }

    decline = async (req: Request, res: Response, next: NextFunction) => {
        try{
            await this.deliveryService.decline(req.region!, req.user!, String(req.params.orderPublicId));
            res.status(204).end();
        }catch(err){
            next(err);
        }
    }

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(UpdateDeliveryStatusRequestDTO, req.body);
            const result = await this.deliveryService.updateStatus(req.region!, req.user!, String(req.params.orderPublicId), data, req.correlationId);
            sendSuccess(res, result);
        }catch(err){
            next(err);
        }
    }

    online = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(PresenceRequestDTO, req.body);
            sendSuccess(res, await this.agentService.online(req.region!, req.user!, data));
        }catch(err){
            next(err);
        }
    }

    ping = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(PresenceRequestDTO, req.body);
            sendSuccess(res, await this.agentService.ping(req.region!, req.user!, data));
        }catch(err){
            next(err);
        }
    }

    offline = async (req: Request, res: Response, next: NextFunction) => {
        try{
            sendSuccess(res, await this.agentService.offline(req.region!, req.user!, req.correlationId));
        }catch(err){
            next(err);
        }
    }

    availableOrders = async (req: Request, res: Response, next: NextFunction) => {
        try{
            sendSuccess(res, await this.agentService.availableOrders(req.region!, req.user!, req.correlationId));
        }catch(err){
            next(err);
        }
    }

    tasks = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(AgentTasksQueryDTO, req.query);
            const result = await this.agentService.tasks(req.region!, req.user!, query, req.correlationId);
            sendPaginated(res, result.data, result.meta);
        }catch(err){
            next(err);
        }
    }

    earnings = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(AgentEarningsQueryDTO, req.query);
            sendSuccess(res, await this.agentService.earningsOf(req.region!, req.user!, query));
        }catch(err){
            next(err);
        }
    }
}
