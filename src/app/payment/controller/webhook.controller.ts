import type {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens.js";
import {sendSuccess} from "../../../lib/http/response.js";
import type {WebhookService} from "../service/webhook.service.js";

// no auth: the HMAC signature is the authentication. 200 for processed AND duplicate (stops retries).
@injectable()
export class WebhookController {
    constructor(
        @inject(TOKENS.WebhookService) private readonly webhookService: WebhookService
    ){}

    receive = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const result = await this.webhookService.handle(
                String(req.params.provider),
                {headers: req.headers, body: req.body},
                req.correlationId
            );
            sendSuccess(res, {received: true, result});
        }catch(err){
            next(err);
        }
    }

    // where Kashier sends the BROWSER after the payment page (KASHIER_RETURN_URL in dev).
    // Display only: the query string is customer-controlled, so nothing here reads it or changes state.
    // The real outcome arrives through the webhook; the client polls GET /orders/:publicId (WS in Phase 6).
    browserReturn = (req: Request, res: Response) => {
        res.status(200).type("html").send(
            "<!doctype html><meta charset=utf-8><title>QuickBite</title>" +
            "<p>Payment submitted. Your order updates as soon as the payment provider confirms it.</p>"
        );
    }
}
