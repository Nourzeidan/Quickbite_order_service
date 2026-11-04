import {env} from "../config/env.js";
import {AppError} from "../error/AppError.js";
import {retry} from "../../pkg/utils/retry.js";
import {CoreServiceUnavailableError, coreUpstreamError} from "./errors.js";
import type {CoreClientRequest} from "./types.js";

// Base sync HTTP client to core-service. Endpoint wrappers (branch, product, address, permission,
// stock clients) are added by the phase that needs them and call request<T>().
export class CoreClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly timeoutMs: number
    ){}

    async request<T>(req: CoreClientRequest): Promise<T> {
        const url = new URL(req.path, this.baseUrl);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "api-key": this.apiKey,
        };
        if(req.correlationId) headers["X-Correlation-ID"] = req.correlationId;
        if(req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;

        // only GETs and calls carrying an Idempotency-Key are safe to send twice
        const canRetry = req.method === "GET" || Boolean(req.idempotencyKey);

        return retry(async () => {
            let res: globalThis.Response;
            try{
                res = await fetch(url, {
                    method: req.method,
                    headers,
                    body: req.body === undefined ? null : JSON.stringify(req.body),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            }catch{
                // network error or timeout
                throw CoreServiceUnavailableError;
            }

            if(res.status >= 500){
                throw CoreServiceUnavailableError;
            }
            if(!res.ok){
                const body = await res.json().catch(() => ({})) as {error?: string};
                throw coreUpstreamError(res.status, body.error ?? res.statusText);
            }
            if(res.status === 204){
                return undefined as T;
            }
            return await res.json() as T;
        }, {
            attempts: canRetry ? 3 : 1,
            initialDelayMs: 50,
            maxDelayMs: 500,
            isRetryable: (err) => err instanceof AppError && err.statusCode === 503,
        });
    }
}

export const coreClient = new CoreClient(env.core.baseUrl, env.core.internalApiKey, env.core.timeoutMs);
