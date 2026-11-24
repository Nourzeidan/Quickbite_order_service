export interface ICacheProvider {
    get(key: string): Promise<string | null>;
    getMany(keys: string[]): Promise<(string | null)[]>;      // one round trip (MGET), same order as keys
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<number>;
    delMany(keys: string[]): Promise<number>;                 // one DEL for many keys

    // atomic "set if absent": true if the key was newly set, false if it already existed.
    // used for dedupe and short locks.
    trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
}
