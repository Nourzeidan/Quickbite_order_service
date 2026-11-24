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

// Batched Layer A for N ids: ONE MGET for all keys, then ONE core call for the misses (never a call
// per id). `loadMissing` returns the rows core knows; unknown ids are simply absent from the map.
// Redis errors fall through to core; null / unknown ids are not cached.
export async function readThroughMany<T>(
    cache: ICacheProvider,
    ids: number[],
    keyOf: (id: number) => string,
    ttlSec: number,
    loadMissing: (ids: number[]) => Promise<T[]>,
    idOf: (row: T) => number
): Promise<Map<number, T>> {
    const unique = [...new Set(ids)];
    const found = new Map<number, T>();
    if(unique.length === 0){
        return found;
    }
    let missing = unique;
    try{
        const cached = await cache.getMany(unique.map(keyOf));
        missing = [];
        cached.forEach((value, index) => {
            if(value) found.set(unique[index]!, JSON.parse(value) as T);
            else missing.push(unique[index]!);
        });
    }catch(err){
        logger.warn("core cache read failed", {keys: unique.length, error: (err as Error).message});
    }
    if(missing.length === 0){
        return found;
    }
    for(const row of await loadMissing(missing)){
        const id = idOf(row);
        found.set(id, row);
        cache.set(keyOf(id), JSON.stringify(row), ttlSec).catch((err) => {
            logger.warn("core cache write failed", {key: keyOf(id), error: (err as Error).message});
        });
    }
    return found;
}

// core's batch endpoints take at most 100 ids per call
export const CORE_BATCH_MAX_IDS = 100;

export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for(let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}
