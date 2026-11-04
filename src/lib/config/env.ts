import {config} from "dotenv";
import path from "path";
import {z} from "zod";

config({path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true}); // order-service/.env (quiet: dotenv 17 logs to stdout)

const envSchema = z.object({
    PORT: z.string().default("4000"),
    NODE_ENV: z.string().default("development"),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),

    ACCESS_SECRET: z.string().min(1),

    REGIONS: z.string().min(1),
    DB_POOL_MAX: z.string().default("10"),
    DB_MIGRATION_DIR: z.string().default("src/migrations"),
    DB_MIGRATION_EXTENSION: z.string().default("ts"),
    PARTMAN_MAINTENANCE_INTERVAL_MIN: z.string().default("60"),     // 0 = off (pg_partman_bgw does it)
    IDEMPOTENCY_CLEANUP_INTERVAL_MIN: z.string().default("60"),

    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.string().default("6379"),
    REDIS_PASSWORD: z.string().default(""),

    RABBITMQ_URL: z.string().min(1),
    RABBITMQ_CORE_EVENTS_EXCHANGE: z.string().default("core.events"),
    RABBITMQ_CORE_EVENTS_QUEUE: z.string().default("order-service.core-events"),
    RABBITMQ_CORE_EVENTS_BINDINGS: z.string().default("product.#,branch.#,restaurant.#,rbac.#"),
    RABBITMQ_CORE_EVENTS_DLX: z.string().default("core.events.dlx"),
    RABBITMQ_CORE_EVENTS_DLQ: z.string().default("order-service.core-events.dlq"),
    RABBITMQ_PREFETCH: z.string().default("32"),

    CORE_SERVICE_BASE_URL: z.string().min(1),
    CORE_INTERNAL_API_KEY: z.string().min(1),
    CORE_TIMEOUT_MS: z.string().default("800"),

    SERVICE_FEE_BPS: z.string().default("0"),
    CUSTOMER_CANCEL_WINDOW_SEC: z.string().default("60"),

    WS_HEARTBEAT_SEC: z.string().default("30")
});

const parsed = envSchema.parse(process.env);

export interface ShardConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
}

function splitList(raw: string): string[] {
    return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

// DB_eg_HOST, DB_eg_PORT, ... (prefix "DB") or ARCHIVE_DB_eg_HOST, ... (prefix "ARCHIVE_DB")
function readShardConfig(region: string, prefix: "DB" | "ARCHIVE_DB"): ShardConfig | null {
    const key = (name: string) => `${prefix}_${region}_${name}`;
    const host = process.env[key("HOST")];
    const port = process.env[key("PORT")];
    const user = process.env[key("USERNAME")];
    const name = process.env[key("NAME")];

    if(!host && !port && !user && !name){
        return null;
    }
    if(!host || !port || !user || !name){
        throw new Error(`Incomplete ${prefix} env for region "${region}". Expected ${key("HOST")}, ${key("PORT")}, ${key("USERNAME")}, ${key("PASSWORD")}, ${key("NAME")}`);
    }
    return {
        host,
        port: Number(port),
        user,
        password: process.env[key("PASSWORD")] ?? "",
        name
    };
}

const regions = splitList(parsed.REGIONS).map((region) => region.toLowerCase());
const hotShards: Record<string, ShardConfig> = {};
const archiveShards: Record<string, ShardConfig> = {};

for(const region of regions){
    const hot = readShardConfig(region, "DB");
    if(!hot){
        throw new Error(`Missing DB env for region "${region}" (DB_${region}_HOST, ...)`);
    }
    hotShards[region] = hot;

    // archive clusters are optional until Phase 7
    const archive = readShardConfig(region, "ARCHIVE_DB");
    if(archive){
        archiveShards[region] = archive;
    }
}

export const env = {
    port: Number(parsed.PORT),
    app: {
        nodeEnv: parsed.NODE_ENV,
    },
    isProduction: parsed.NODE_ENV === "production",
    cors: {
        origin: splitList(parsed.CORS_ORIGINS),
    },
    jwt: {
        accessSecret: parsed.ACCESS_SECRET,
    },
    db: {
        poolMax: Number(parsed.DB_POOL_MAX),
        migrationDir: path.resolve(import.meta.dirname, "../../../", parsed.DB_MIGRATION_DIR),
        migrationExtension: parsed.DB_MIGRATION_EXTENSION,
        partmanMaintenanceIntervalMin: Number(parsed.PARTMAN_MAINTENANCE_INTERVAL_MIN),
        idempotencyCleanupIntervalMin: Number(parsed.IDEMPOTENCY_CLEANUP_INTERVAL_MIN),
    },
    regions,
    hotShards,
    archiveShards,
    redis: {
        host: parsed.REDIS_HOST,
        port: Number(parsed.REDIS_PORT),
        password: parsed.REDIS_PASSWORD,
    },
    rabbit: {
        url: parsed.RABBITMQ_URL,
        exchange: parsed.RABBITMQ_CORE_EVENTS_EXCHANGE,
        queue: parsed.RABBITMQ_CORE_EVENTS_QUEUE,
        bindings: splitList(parsed.RABBITMQ_CORE_EVENTS_BINDINGS),
        dlx: parsed.RABBITMQ_CORE_EVENTS_DLX,
        dlq: parsed.RABBITMQ_CORE_EVENTS_DLQ,
        prefetch: Number(parsed.RABBITMQ_PREFETCH),
    },
    core: {
        baseUrl: parsed.CORE_SERVICE_BASE_URL,
        internalApiKey: parsed.CORE_INTERNAL_API_KEY,
        timeoutMs: Number(parsed.CORE_TIMEOUT_MS),
    },
    orders: {
        serviceFeeBps: Number(parsed.SERVICE_FEE_BPS),
        customerCancelWindowSec: Number(parsed.CUSTOMER_CANCEL_WINDOW_SEC),
    },
    ws: {
        heartbeatSec: Number(parsed.WS_HEARTBEAT_SEC),
    }
};
