// Kashier v3 shapes used by this service (https://developers.kashier.io).
// Only the fields we read are typed; everything else is ignored.

export interface KashierConfig {
    baseUrl: string;                    // sessions API: https://test-api.kashier.io | https://api.kashier.io
    fepBaseUrl: string;                 // order operations (refund): https://test-fep.kashier.io | https://fep.kashier.io
    merchantId: string;                 // MID-xxxx-xxx
    secretKey: string;                  // Authorization header
    apiKey: string;                     // api-key header
    webhookSecret: string;              // HMAC key of x-kashier-signature (Kashier: the Payment API Key)
    timeoutMs: number;
    webhookAmountUnit: "major" | "minor";
}

// POST /v3/payment/sessions body
export interface KashierCreateSessionBody {
    merchantId: string;
    order: string;
    amount: string;                     // major units, 2 decimals: "100.00"
    currency: string;
    expireAt: string;                   // ISO 8601
    merchantRedirect: string;
    failureRedirect: boolean;
    serverWebhook: string;
    paymentType: "credit";
    type: "one-time";
    allowedMethods: string;
    defaultMethod: string;
    maxFailureAttempts: number;
    display: "en" | "ar";
    description: string;
    customer: {reference: string};
    interactionSource: "ECOMMERCE";
    enable3DS: boolean;
    manualCapture: boolean;
}

export interface KashierCreateSessionResponse {
    _id?: string;
    sessionUrl?: string;
    status?: string;
}

// PUT /v3/orders/:kashierOrderId body
export interface KashierRefundBody {
    apiOperation: "REFUND";
    reason: string;
    transaction: {amount: number};      // major units
}

export type KashierStatus = "SUCCESS" | "FAILURE" | "PENDING";

// webhook: { event, data }
export interface KashierWebhookData {
    merchantOrderId: string;
    kashierOrderId: string;
    orderReference?: string;
    transactionId: string;
    status: KashierStatus | string;
    method?: string;
    amount: number | string;
    currency: string;
    signatureKeys: string[];
    [key: string]: unknown;
}

export interface KashierWebhookBody {
    event: string;                      // pay | authorize | capture | refund | partial_refund | void | reject | reversal | idempotency
    data: KashierWebhookData;
}
