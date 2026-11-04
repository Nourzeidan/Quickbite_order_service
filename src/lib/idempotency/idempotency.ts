import crypto from "crypto";
import type {NextFunction, Request, Response} from "express";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import {container} from "../di/container.js";
import {TOKENS} from "../di/tokens.js";
import {AppError} from "../error/AppError.js";
import {daysToMs, msToSecs} from "../../pkg/utils/time.js";
import {
    IdempotencyConflictError,
    IdempotencyInProgressError,
    IdempotencyKeyRequiredError,
    IdempotencyUnavailableError
} from "./errors.js";

const RESPONSE_TTL_SEC = msToSecs(daysToMs(1));
const LOCK_TTL_SEC = 30;
const MAX_KEY_LENGTH = 255;

interface IdempotencyOptions {
    strict?: boolean;
}

interface StoredResponse {
    fingerprint: string;
    statusCode: number;
    body: unknown;
}

function fingerprintOf(body: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

// what the durable store (idempotency_keys, database-design ง4.10) needs from the request
export interface IdempotencyContext {
    key: string;
    keyHash: Buffer;            // sha256(user_id + method + path + Idempotency-Key)
    fingerprint: Buffer;        // sha256 of the body (same value the Redis layer compares)
    ttlSec: number;
}

function buildContext(req: Request, idempotencyKey: string, path: string, fingerprint: string): IdempotencyContext {
    const keyHash = crypto.createHash("sha256")
        .update(`${req.user?.userId ?? "anonymous"}:${req.method}:${path}:${idempotencyKey}`)
        .digest();
    return {key: idempotencyKey, keyHash, fingerprint: Buffer.from(fingerprint, "hex"), ttlSec: RESPONSE_TTL_SEC};
}

// Phase 0: Redis only. POST /orders and POST /payments/init add the durable
// idempotency_keys table in Phase 1/2 (docs/database-design.md ยง4.10).
//
// - key is scoped to the caller + method + path, so one user can't replay another user's response
// - same key + different body -> 409
// - a second request while the first is still running -> 409 (short lock)
// - non-5xx responses are stored for 24h and replayed with their original status
export function idempotency(options: IdempotencyOptions = {}) {
    const {strict = false} = options;

    return async(req: Request, res: Response, next: NextFunction) => {
        if(!["POST", "PATCH", "PUT"].includes(req.method)){
            return next();
        }

        const idempotencyKey = req.headers["idempotency-key"];
        if(typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > MAX_KEY_LENGTH){
            if(strict){
                return next(IdempotencyKeyRequiredError);
            }
            return next();
        }

        try{
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            const path = req.originalUrl.split("?")[0]!;
            const key = `idempotency:${req.region ?? "none"}:${req.user?.userId ?? "anonymous"}:${req.method}:${path}:${idempotencyKey}`;
            const lockKey = `${key}:lock`;
            const fingerprint = fingerprintOf(req.body);
            req.idempotency = buildContext(req, idempotencyKey, path, fingerprint);

            const cached = await cacheProvider.get(key);
            if(cached){
                const stored = JSON.parse(cached) as StoredResponse;
                if(stored.fingerprint !== fingerprint){
                    return next(IdempotencyConflictError);
                }
                res.setHeader("Idempotent-Replayed", "true");
                return res.status(stored.statusCode).json(stored.body);
            }

            const locked = await cacheProvider.trySet(lockKey, "1", LOCK_TTL_SEC);
            if(!locked){
                return next(IdempotencyInProgressError);
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if(res.statusCode < 500){
                    const stored: StoredResponse = {fingerprint, statusCode: res.statusCode, body};
                    cacheProvider.set(key, JSON.stringify(stored), RESPONSE_TTL_SEC).catch(() => {});
                }
                cacheProvider.del(lockKey).catch(() => {});
                return originalJson(body);
            }) as Response["json"];

            next();
        }catch(err){
            if(err instanceof AppError){
                return next(err);
            }
            // Redis down: strict endpoints refuse rather than risk a double write
            if(strict){
                return next(IdempotencyUnavailableError);
            }
            next();
        }
    }
}
