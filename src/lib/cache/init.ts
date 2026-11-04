import {env} from "../config/env.js";
import {RedisCacheProvider} from "../../pkg/cache/redis.js";

// one Redis connection for the cache, idempotency, core-event dedupe and (via duplicate()) socket.io
export const cacheProvider = new RedisCacheProvider({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password
});
