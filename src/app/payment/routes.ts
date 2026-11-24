import {Router} from "express";
import {container} from "../../lib/di/container.js";
import {TOKENS} from "../../lib/di/tokens.js";
import {authenticate} from "../../lib/auth/guard.js";
import {rbac, requireRole} from "../../lib/auth/rbac.js";
import {SystemRole} from "../../lib/auth/enums.js";
import {requireRegion} from "../../lib/sharding/region-resolver.js";
import {idempotency} from "../../lib/idempotency/idempotency.js";
import type {PaymentController} from "./controller/payment.controller.js";
import type {WebhookController} from "./controller/webhook.controller.js";

export const paymentRouter = Router();
const paymentController = container.resolve<PaymentController>(TOKENS.PaymentController);
const webhookController = container.resolve<WebhookController>(TOKENS.WebhookController);

paymentRouter.post("/init",
    authenticate,
    requireRegion(),
    requireRole(SystemRole.CUSTOMER),
    idempotency({strict: true}),
    paymentController.init);

// Kashier -> us. No JWT, no X-Region: HMAC signature + region from the merchant reference
paymentRouter.post("/webhook/:provider",
    webhookController.receive);

// browser landing page after Kashier's payment page (cosmetic, changes nothing). Before /:paymentId.
paymentRouter.get("/return",
    webhookController.browserReturn);

paymentRouter.get("/:paymentId",
    authenticate,
    requireRegion(),
    rbac({resource: "order:payment", action: "read"}),
    paymentController.getById);

paymentRouter.post("/:paymentId/refund",
    authenticate,
    requireRegion(),
    requireRole(SystemRole.ADMIN),
    idempotency({strict: true}),
    paymentController.refund);
