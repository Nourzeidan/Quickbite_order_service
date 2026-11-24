import {Router} from "express";
import {container} from "../../lib/di/container.js";
import {TOKENS} from "../../lib/di/tokens.js";
import {authenticate} from "../../lib/auth/guard.js";
import {requireRole} from "../../lib/auth/rbac.js";
import {SystemRole} from "../../lib/auth/enums.js";
import {requireRegion} from "../../lib/sharding/region-resolver.js";
import {idempotency} from "../../lib/idempotency/idempotency.js";
import type {DeliveryController} from "./controller/delivery.controller.js";

// deliveries.md — agents only. Ownership of an order is checked in DeliveryService (else 404).
const controller = container.resolve<DeliveryController>(TOKENS.DeliveryController);
const agentOnly = [authenticate, requireRegion(), requireRole(SystemRole.DELIVERY_AGENT)];

export const deliveryRouter = Router();
deliveryRouter.post("/:orderPublicId/accept", ...agentOnly, idempotency(), controller.accept);
deliveryRouter.post("/:orderPublicId/decline", ...agentOnly, controller.decline);
deliveryRouter.patch("/:orderPublicId/status", ...agentOnly, idempotency(), controller.updateStatus);

export const agentRouter = Router();
agentRouter.post("/presence/online", ...agentOnly, controller.online);
agentRouter.post("/presence/ping", ...agentOnly, controller.ping);
agentRouter.post("/presence/offline", ...agentOnly, controller.offline);
agentRouter.get("/available-orders", ...agentOnly, controller.availableOrders);
agentRouter.get("/tasks", ...agentOnly, controller.tasks);
agentRouter.get("/earnings", ...agentOnly, controller.earnings);
