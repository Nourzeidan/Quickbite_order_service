import {retry} from "../../utils/retry.js";
import {fromMinor, toMinor} from "../../utils/money.js";
import {
    PaymentProviderError,
    type CreatedSession,
    type CreateSessionInput,
    type IPaymentProvider,
    type ProviderOperationStatus,
    type ProviderWebhookEvent,
    type RefundInput,
    type RefundResult,
    type WebhookKind,
    type WebhookRequest
} from "../payment.interface.js";
import {verifyKashierSignature} from "./kashier.signature.js";
import type {
    KashierConfig,
    KashierCreateSessionBody,
    KashierCreateSessionResponse,
    KashierRefundBody,
    KashierWebhookBody
} from "./kashier.types.js";

const SIGNATURE_HEADER = "x-kashier-signature";

const PAYMENT_EVENTS = new Set(["pay", "capture"]);
const REFUND_EVENTS = new Set(["refund", "partial_refund"]);

// 3 tries with backoff on network / 5xx; 4xx is final (integrations.md §4)
const RETRY = {attempts: 3, initialDelayMs: 200, maxDelayMs: 1000};

class HttpError extends Error {
    constructor(readonly status: number, message: string){
        super(message);
    }
}

export class KashierClient implements IPaymentProvider {
    constructor(private readonly config: KashierConfig){}

    createSession = async (input: CreateSessionInput): Promise<CreatedSession> => {
        const body: KashierCreateSessionBody = {
            merchantId: this.config.merchantId,
            order: input.merchantOrderRef,
            amount: fromMinor(input.amountMinor),
            currency: input.currency,
            expireAt: input.expiresAt.toISOString(),
            merchantRedirect: input.returnUrl,
            failureRedirect: true,
            serverWebhook: input.webhookUrl,
            paymentType: "credit",
            type: "one-time",
            allowedMethods: "card,wallet",
            defaultMethod: "card",
            maxFailureAttempts: 3,
            display: "en",
            description: input.description,
            customer: {reference: input.customerReference},
            interactionSource: "ECOMMERCE",
            enable3DS: true,
            manualCapture: false,
        };

        // a duplicate session for the same `order` is harmless: the webhook is matched by merchantOrderId
        const response = await this.call<KashierCreateSessionResponse>(
            `${this.config.baseUrl}/v3/payment/sessions`, "POST", body, true
        );
        if(!response._id || !response.sessionUrl){
            throw new PaymentProviderError("rejected", "Kashier session response without _id / sessionUrl");
        }
        return {
            providerSessionId: response._id,
            redirectUrl: response.sessionUrl,
            requestPayload: {...body},              // no credentials are part of the body
        };
    }

    // never retried: a timed-out refund may have gone through, and a retry would refund twice
    refund = async (input: RefundInput): Promise<RefundResult> => {
        const body: KashierRefundBody = {
            apiOperation: "REFUND",
            reason: input.reason,
            transaction: {amount: Number(fromMinor(input.amountMinor))},
        };
        const response = await this.call<Record<string, any>>(
            `${this.config.fepBaseUrl}/v3/orders/${encodeURIComponent(input.providerOrderId)}`, "PUT", body, false
        );

        // the response shape is not fully documented; read what is there
        const inner = (response.response ?? response) as Record<string, any>;
        const lastTransaction = Array.isArray(inner.transactions) ? inner.transactions[inner.transactions.length - 1] : undefined;
        const providerReferenceId: unknown = inner.transactionId ?? lastTransaction?.transactionId ?? null;
        const status = mapStatus(String(inner.status ?? response.status ?? "PENDING"));
        if(status === "failed"){
            throw new PaymentProviderError("rejected", `Kashier refund answered FAILURE`);
        }
        return {
            providerReferenceId: typeof providerReferenceId === "string" ? providerReferenceId : null,
            status,
        };
    }

    verifyWebhook = (request: WebhookRequest): string | null => {
        const header = request.headers[SIGNATURE_HEADER];
        const signature = Array.isArray(header) ? header[0] : header;
        if(!signature){
            return null;
        }
        const data = (request.body as Partial<KashierWebhookBody> | undefined)?.data;
        if(!data || typeof data !== "object" || !Array.isArray(data.signatureKeys) || data.signatureKeys.length === 0){
            return null;
        }
        const keys = data.signatureKeys.filter((key): key is string => typeof key === "string");
        return verifyKashierSignature(data, keys, signature, this.config.webhookSecret) ? signature : null;
    }

    parseWebhook = (body: unknown): ProviderWebhookEvent => {
        const {event, data} = body as KashierWebhookBody;
        if(typeof event !== "string" || !data || typeof data.merchantOrderId !== "string" || typeof data.transactionId !== "string"){
            throw new Error("Kashier webhook without event / merchantOrderId / transactionId");
        }
        const status = mapStatus(String(data.status));
        const amountMinor = this.config.webhookAmountUnit === "minor"
            ? Number(data.amount)
            : toMinor(String(data.amount));
        if(!Number.isSafeInteger(amountMinor) || amountMinor < 0){
            throw new Error("Kashier webhook with an invalid amount");
        }
        return {
            // Kashier dedupes on transactionId + status; the event name keeps pay/refund apart
            eventId: `${event}:${data.transactionId}:${String(data.status)}`,
            kind: kindOf(event),
            rawEvent: event,
            status,
            merchantOrderRef: data.merchantOrderId,
            providerOrderId: String(data.kashierOrderId ?? ""),
            transactionId: data.transactionId,
            amountMinor,
            currency: String(data.currency),
        };
    }

    private call = async <T>(url: string, method: "POST" | "PUT", body: unknown, retryable: boolean): Promise<T> => {
        const once = async (): Promise<T> => {
            let response: Response;
            try{
                response = await fetch(url, {
                    method,
                    headers: {
                        "Authorization": this.config.secretKey,
                        "api-key": this.config.apiKey,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(this.config.timeoutMs),
                });
            }catch(err){
                throw new PaymentProviderError("unavailable", `Kashier unreachable: ${(err as Error).message}`);
            }
            const text = await response.text();
            if(!response.ok){
                // body may echo request data; keep only the status in the message
                throw new HttpError(response.status, `Kashier answered ${response.status}`);
            }
            try{
                return JSON.parse(text) as T;
            }catch{
                throw new PaymentProviderError("rejected", "Kashier answered with a non-JSON body");
            }
        };

        try{
            return retryable
                ? await retry(once, {...RETRY, isRetryable: isTransient})
                : await once();
        }catch(err){
            if(err instanceof HttpError){
                throw new PaymentProviderError(err.status >= 500 ? "unavailable" : "rejected", err.message, err.status);
            }
            throw err;
        }
    }
}

function isTransient(err: unknown): boolean {
    if(err instanceof HttpError) return err.status >= 500;
    return err instanceof PaymentProviderError && err.kind === "unavailable";
}

function mapStatus(status: string): ProviderOperationStatus {
    switch(status.toUpperCase()){
        case "SUCCESS": return "succeeded";
        case "FAILURE":
        case "FAILED": return "failed";
        default: return "pending";
    }
}

function kindOf(event: string): WebhookKind {
    if(PAYMENT_EVENTS.has(event)) return "payment";
    if(REFUND_EVENTS.has(event)) return "refund";
    return "other";
}
