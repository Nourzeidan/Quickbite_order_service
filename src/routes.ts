import {Router} from "express";
import {healthRouter} from "./app/health/health.routes.js";
import {orderRouter} from "./app/order/routes.js";

export const routes = Router();
routes.use(healthRouter);
routes.use("/", orderRouter);               // /orders, /customer/orders, /restaurant/orders, /admin/orders
// module routers are mounted here by their phase:
// routes.use("/payments", paymentRouter);  // Phase 2
// routes.use("/deliveries", deliveryRouter); // Phase 3
// routes.use("/agents", agentRouter);      // Phase 4
// routes.use("/", financeRouter);          // Phase 5: /restaurant/balance, /restaurant/payouts
