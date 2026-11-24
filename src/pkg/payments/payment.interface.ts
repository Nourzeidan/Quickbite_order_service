// Provider-agnostic payment port. Implementations live next to this file (kashier/), get their config
// through the constructor and never read env or import lib/ / app/.

export interface CreateSessionInput {
    amountMinor: number;
    currency: string;
    merchantOrderRef: string;           // our unique reference, echoed back in every webhook
    expiresAt: Date;
    returnUrl: string;                  // browser redirect (cosmetic, never settles anything)
    webhookUrl: string;                 // server-to-server notifications
    customerReference: string;
    description: string;
}

export interface CreatedSession {
    providerSessionId: string;
    redirectUrl: string;
    requestPayload: Record<string, unknown>;   // what was sent, without credentials (stored as raw_init_payload)
}

export interface RefundInput {
    providerOrderId: string;            // the provider's id of the paid order (Kashier: kashierOrderId)
    amountMinor: number;
    reason: string;
}

export type ProviderOperationStatus = "succeeded" | "failed" | "pending";

export interface RefundResult {
    providerReferenceId: string | null; // provider's id of the refund transaction, when the response carries it
    status: ProviderOperationStatus;
}

export type WebhookKind = "payment" | "refund" | "other";

// a verified notification, normalized
export interface ProviderWebhookEvent {
    eventId: string;                    // stable dedupe key across redeliveries
    kind: WebhookKind;
    rawEvent: string;                   // provider's event name (pay, refund, ...)
    status: ProviderOperationStatus;
    merchantOrderRef: string;
    providerOrderId: string;            // charge reference used for refunds
    transactionId: string;
    amountMinor: number;
    currency: string;
}

export interface WebhookRequest {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

export interface IPaymentProvider {
    createSession(input: CreateSessionInput): Promise<CreatedSession>;
    refund(input: RefundInput): Promise<RefundResult>;
    // signature check only; returns the signature that was verified, or null when invalid / missing
    verifyWebhook(request: WebhookRequest): string | null;
    // call only after verifyWebhook succeeded; throws on an unusable payload
    parseWebhook(body: unknown): ProviderWebhookEvent;
}

// "unavailable": network / timeout / 5xx after retries -> 503
// "rejected": the provider refused the request (4xx, or a FAILURE answer) -> 502
export class PaymentProviderError extends Error {
    constructor(
        readonly kind: "unavailable" | "rejected",
        message: string,
        readonly httpStatus: number | null = null
    ){
        super(message);
        this.name = "PaymentProviderError";
    }
}
