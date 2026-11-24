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

    // Kashier v3 (Phase 2)
    KASHIER_BASE_URL: z.string().default("https://test-api.kashier.io"),
    KASHIER_FEP_BASE_URL: z.string().default("https://test-fep.kashier.io"),
    KASHIER_MERCHANT_ID: z.string().min(1),
    KASHIER_SECRET_KEY: z.string().min(1),
    KASHIER_API_KEY: z.string().min(1),
    KASHIER_WEBHOOK_SECRET: z.string().min(1),
    KASHIER_RETURN_URL: z.string().min(1),
    KASHIER_WEBHOOK_URL: z.string().min(1),
    KASHIER_TIMEOUT_MS: z.string().default("5000"),
    KASHIER_WEBHOOK_AMOUNT_UNIT: z.enum(["major", "minor"]).default("major"),
    PAYMENT_SESSION_TIMEOUT_MIN: z.string().default("15"),
    PAYMENT_SWEEP_INTERVAL_SEC: z.string().default("60"),
    PAYMENT_SWEEP_GRACE_MIN: z.string().default("3"),
    REFUND_STALE_ALERT_MIN: z.string().default("60"),

    // deliveries & agents (Phase 3)
    OFFER_INTERVAL_SEC: z.string().default("10"),
    OFFER_TOP_N: z.string().default("3"),
    OFFER_TTL_SEC: z.string().default("60"),
    OFFER_BATCH: z.string().default("100"),
    ASSIGNMENT_RADIUS_METERS: z.string().default("5000"),
    AGENT_STALE_SEC: z.string().default("300"),
    AGENT_SHARE_BPS: z.string().default("8000"),

    // archival (Phase 5) — read by the archiver process (npm run archiver), docs/business-logic/archival.md §9
    ARCHIVE_INTERVAL_MIN: z.string().default("60"),
    ARCHIVE_WINDOW_UTC: z.string().regex(/^\d{1,2}-\d{1,2}$/).default("0-5"),   // "<from>-<to>" hours, to exclusive; 0-24 = always
    ARCHIVE_BATCH_SIZE: z.string().default("500"),
    ARCHIVE_MAX_BATCHES_PER_RUN: z.string().default("200"),
    ARCHIVE_MIN_AGE_DAYS: z.string().default("30"),
    ARCHIVE_STUCK_ALERT_DAYS: z.string().default("60"),
    ARCHIVE_TEST_PAUSE_MS: z.string().default("0"),   // dev/test only: pause between copy and delete (race test); ignored in production

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

    // every region has an archive cluster for prior-year rows (Phase 5, archival.md §8)
    const archive = readShardConfig(region, "ARCHIVE_DB");
    if(!archive){
        throw new Error(`Missing ARCHIVE_DB env for region "${region}" (ARCHIVE_DB_${region}_HOST, ...)`);
    }
    archiveShards[region] = archive;
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
    kashier: {
        baseUrl: parsed.KASHIER_BASE_URL.replace(/\/+$/, ""),
        fepBaseUrl: parsed.KASHIER_FEP_BASE_URL.replace(/\/+$/, ""),
        merchantId: parsed.KASHIER_MERCHANT_ID,
        secretKey: parsed.KASHIER_SECRET_KEY,
        apiKey: parsed.KASHIER_API_KEY,
        webhookSecret: parsed.KASHIER_WEBHOOK_SECRET,
        returnUrl: parsed.KASHIER_RETURN_URL,
        webhookUrl: parsed.KASHIER_WEBHOOK_URL,
        timeoutMs: Number(parsed.KASHIER_TIMEOUT_MS),
        webhookAmountUnit: parsed.KASHIER_WEBHOOK_AMOUNT_UNIT,
    },
    payments: {
        sessionTimeoutMin: Number(parsed.PAYMENT_SESSION_TIMEOUT_MIN),
        sweepIntervalSec: Number(parsed.PAYMENT_SWEEP_INTERVAL_SEC),
        sweepGraceMin: Number(parsed.PAYMENT_SWEEP_GRACE_MIN),
        refundStaleAlertMin: Number(parsed.REFUND_STALE_ALERT_MIN),
    },
    delivery: {
        offerIntervalSec: Number(parsed.OFFER_INTERVAL_SEC),
        offerTopN: Number(parsed.OFFER_TOP_N),
        offerTtlSec: Number(parsed.OFFER_TTL_SEC),
        offerBatch: Number(parsed.OFFER_BATCH),
        radiusMeters: Number(parsed.ASSIGNMENT_RADIUS_METERS),
        agentStaleSec: Number(parsed.AGENT_STALE_SEC),
        agentShareBps: Number(parsed.AGENT_SHARE_BPS),
    },
    archival: {
        intervalMin: Number(parsed.ARCHIVE_INTERVAL_MIN),
        windowUtc: parseWindow(parsed.ARCHIVE_WINDOW_UTC),
        batchSize: Number(parsed.ARCHIVE_BATCH_SIZE),
        maxBatchesPerRun: Number(parsed.ARCHIVE_MAX_BATCHES_PER_RUN),
        minAgeDays: Number(parsed.ARCHIVE_MIN_AGE_DAYS),
        stuckAlertDays: Number(parsed.ARCHIVE_STUCK_ALERT_DAYS),
        testPauseMs: parsed.NODE_ENV === "production" ? 0 : Number(parsed.ARCHIVE_TEST_PAUSE_MS),
    },
    ws: {
        heartbeatSec: Number(parsed.WS_HEARTBEAT_SEC),
    }
};

// "0-5" -> {fromHour: 0, toHour: 5}: the archiver works while fromHour <= UTC hour < toHour
function parseWindow(raw: string): {fromHour: number; toHour: number} {
    const [fromHour, toHour] = raw.split("-").map(Number) as [number, number];
    if(fromHour < 0 || toHour > 24 || fromHour >= toHour){
        throw new Error(`ARCHIVE_WINDOW_UTC "${raw}" must be "<from>-<to>" with 0 <= from < to <= 24`);
    }
    return {fromHour, toHour};
}
