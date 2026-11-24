import {Router} from "express";
import {container} from "../../lib/di/container.js";
import {TOKENS} from "../../lib/di/tokens.js";
import {authenticate} from "../../lib/auth/guard.js";
import {rbac, requireRole} from "../../lib/auth/rbac.js";
import {SystemRole} from "../../lib/auth/enums.js";
import {requireRegion} from "../../lib/sharding/region-resolver.js";
import {idempotency} from "../../lib/idempotency/idempotency.js";
import type {FinanceController} from "./controller/finance.controller.js";

// restaurant-finance.md §8. Balance is never cached (owners must see the exact value).
const controller = container.resolve<FinanceController>(TOKENS.FinanceController);

export const financeRouter = Router();
financeRouter.get("/restaurant/balance",
    authenticate,
    requireRegion(),
    rbac({resource: "order:finance", action: "read"}),
    controller.balance);

financeRouter.get("/restaurant/payouts",
    authenticate,
    requireRegion(),
    rbac({resource: "order:finance", action: "read"}),
    controller.payouts);

financeRouter.post("/restaurant/payouts",
    authenticate,
    requireRegion(),
    requireRole(SystemRole.ADMIN),
    idempotency({strict: true}),
    controller.createPayout);
