import {Redis} from "ioredis";
import type {ICacheProvider} from "./cache.interface.js";

export interface RedisConfig {
    host: string;
    port: number;
    password: string;
}

export class RedisCacheProvider implements ICacheProvider {
    private readonly client: Redis;

    constructor(private readonly config: RedisConfig){
        this.client = new Redis({
            host: config.host,
            port: config.port,
            ...(config.password ? {password: config.password} : {}),
            lazyConnect: true,
            maxRetriesPerRequest: 3
        });

        this.client.on("error", (err) => {console.error("Redis error", err.message);});
        this.client.connect().catch((err) => {console.error("Redis connect error:", err.message);});
    }

    // raw connection for integrations that need it (socket.io redis adapter).
    // the adapter subscriber must use getClient().duplicate(): a subscribed connection can't run get/set.
    getClient(): Redis {
        return this.client;
    }

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async getMany(keys: string[]): Promise<(string | null)[]> {
        if(keys.length === 0){
            return [];
        }
        return this.client.mget(...keys);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if(ttlSeconds){
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async delMany(keys: string[]): Promise<number> {
        if(keys.length === 0) return 0;
        return this.client.del(...keys);
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const result = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return result === "OK";
    }

    async quit(): Promise<void> {
        await this.client.quit();
    }
}
