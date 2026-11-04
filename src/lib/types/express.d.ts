import type {JwtPayload} from "../auth/jwt.js";
import type {IdempotencyContext} from "../idempotency/idempotency.js";

declare global {
    namespace Express {
        interface Request {
            correlationId: string;
            region?: string;            // set by resolveRegion from X-Region ("all" = admin fan-out)
            user?: JwtPayload;
            idempotency?: IdempotencyContext;   // set by idempotency() when the request carries a key
        }
    }
}

export {};
