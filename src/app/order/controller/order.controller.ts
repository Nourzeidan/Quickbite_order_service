import type {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {sendPaginated, sendSuccess} from "../../../lib/http/response.js";
import {validateBody, validateQuery} from "../../../lib/validation/validate.js";
import {
    AdminOrdersQueryDTO,
    CreateOrderRequestDTO,
    CustomerOrdersQueryDTO,
    RestaurantOrdersQueryDTO,
    UpdateOrderStatusRequestDTO
} from "../dto/order.request.dto.js";
import type {OrderService} from "../service/order.service.js";
import type {OrderStatusService} from "../service/order-status.service.js";

// req.user / req.region are guaranteed by authenticate / requireRegion on every route
@injectable()
export class OrderController {
    constructor(
        @inject(TOKENS.OrderService) private readonly orderService: OrderService,
        @inject(TOKENS.OrderStatusService) private readonly orderStatusService: OrderStatusService
    ){}

    create = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(CreateOrderRequestDTO, req.body);
            const result = await this.orderService.place(req.user!, data, req.region, req.idempotency, req.correlationId);
            if(result.replayed){
                res.setHeader("Idempotent-Replayed", "true");
            }
            sendSuccess(res, result.order, 201);
        }catch(err){
            next(err);
        }
    }

    getByPublicId = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const order = await this.orderService.getDetail(req.region!, req.user!, String(req.params.publicId));
            sendSuccess(res, order);
        }catch(err){
            next(err);
        }
    }

    listForCustomer = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(CustomerOrdersQueryDTO, req.query);
            const result = await this.orderService.listForCustomer(req.region!, req.user!, query);
            sendPaginated(res, result.data, result.meta);
        }catch(err){
            next(err);
        }
    }

    listForRestaurant = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(RestaurantOrdersQueryDTO, req.query);
            const result = await this.orderService.listForRestaurant(req.region!, req.user!, query);
            sendPaginated(res, result.data, result.meta);
        }catch(err){
            next(err);
        }
    }

    listForAdmin = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const query = await validateQuery(AdminOrdersQueryDTO, req.query);
            const result = await this.orderService.listForAdmin(req.region!, query);
            sendPaginated(res, result.data, result.meta);
        }catch(err){
            next(err);
        }
    }

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(UpdateOrderStatusRequestDTO, req.body);
            const result = await this.orderStatusService.changeStatus(req.region!, req.user!, String(req.params.publicId), data, req.correlationId);
            sendSuccess(res, result);
        }catch(err){
            next(err);
        }
    }
}
