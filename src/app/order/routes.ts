import {Router} from "express";
import {container} from "../../lib/di/container.js";
import {TOKENS} from "../../lib/di/tokens.js";
import {authenticate} from "../../lib/auth/guard.js";
import {rbac, requireBranchAccess, requireRole} from "../../lib/auth/rbac.js";
import {SystemRole} from "../../lib/auth/enums.js";
import {requireRegion} from "../../lib/sharding/region-resolver.js";
import {idempotency} from "../../lib/idempotency/idempotency.js";
import {withCache} from "../../lib/cache/withCache.js";
import type {OrderController} from "./controller/order.controller.js";

export const orderRouter = Router();
const orderController = container.resolve<OrderController>(TOKENS.OrderController);

// no requireRegion: the region may be derived from the branch (must match X-Region if sent)
orderRouter.post("/orders",
    authenticate,
    requireRole(SystemRole.CUSTOMER),
    idempotency({strict: true}),
    orderController.create);

orderRouter.get("/customer/orders",
    authenticate,
    requireRegion(),
    requireRole(SystemRole.CUSTOMER),
    orderController.listForCustomer);

orderRouter.get("/restaurant/orders",
    authenticate,
    requireRegion(),
    rbac({resource: "order:order", action: "read"}),
    requireBranchAccess("branchId"),
    withCache(10),
    orderController.listForRestaurant);

orderRouter.get("/admin/orders",
    authenticate,
    requireRegion({allowAll: true}),
    requireRole(SystemRole.ADMIN),
    orderController.listForAdmin);

// ownership / permission per target status is checked in OrderStatusService
orderRouter.patch("/orders/:publicId/status",
    authenticate,
    requireRegion(),
    idempotency({strict: true}),
    orderController.updateStatus);

orderRouter.get("/orders/:publicId",
    authenticate,
    requireRegion(),
    orderController.getByPublicId);
