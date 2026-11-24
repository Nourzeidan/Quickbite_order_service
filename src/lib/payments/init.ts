import {env} from "../config/env.js";
import {KashierClient} from "../../pkg/payments/kashier/kashier.client.js";
import type {IPaymentProvider} from "../../pkg/payments/payment.interface.js";

// the only place Kashier config leaves env
export const kashierProvider: IPaymentProvider = new KashierClient({
    baseUrl: env.kashier.baseUrl,
    fepBaseUrl: env.kashier.fepBaseUrl,
    merchantId: env.kashier.merchantId,
    secretKey: env.kashier.secretKey,
    apiKey: env.kashier.apiKey,
    webhookSecret: env.kashier.webhookSecret,
    timeoutMs: env.kashier.timeoutMs,
    webhookAmountUnit: env.kashier.webhookAmountUnit,
});
