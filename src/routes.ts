import {Router} from "express";
import {healthRouter} from "./app/health/health.routes.js";
import {orderRouter} from "./app/order/routes.js";
import {paymentRouter} from "./app/payment/routes.js";
import {agentRouter, deliveryRouter} from "./app/delivery/routes.js";
import {financeRouter} from "./app/restaurant-finance/routes.js";

export const routes = Router();
routes.use(healthRouter);
routes.use("/", orderRouter);               // /orders, /customer/orders, /restaurant/orders, /admin/orders
routes.use("/payments", paymentRouter);     // /payments/init, /payments/webhook/:provider, /payments/:id[/refund]
routes.use("/deliveries", deliveryRouter); // /deliveries/:orderPublicId/accept|decline|status
routes.use("/agents", agentRouter);         // /agents/presence/*, /agents/available-orders, /agents/tasks, /agents/earnings
routes.use("/", financeRouter);             // /restaurant/balance, /restaurant/payouts
