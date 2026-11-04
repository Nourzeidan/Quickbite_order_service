import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import {logger} from "../logger/logger.js";

// Layer A (system-design §4): Redis first, core on a miss. Redis errors never fail the request,
// they just fall through to core. null (core 404) is not cached.
export async function readThrough<T>(cache: ICacheProvider, key: string, ttlSec: number, load: () => Promise<T | null>): Promise<T | null> {
    try{
        const cached = await cache.get(key);
        if(cached){
            return JSON.parse(cached) as T;
        }
    }catch(err){
        logger.warn("core cache read failed", {key, error: (err as Error).message});
    }

    const value = await load();
    if(value !== null){
        cache.set(key, JSON.stringify(value), ttlSec).catch((err) => {
            logger.warn("core cache write failed", {key, error: (err as Error).message});
        });
    }
    return value;
}

export function isNotFound(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as {statusCode?: number}).statusCode === 404;
}
