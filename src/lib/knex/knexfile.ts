import type {Knex} from "knex";
import {env, type ShardConfig} from "../config/env.js";

const PG_TIMESTAMP_OID = 1114;

// TIMESTAMP columns hold UTC (docs/database-design.md §1). pg parses them as LOCAL time by default,
// and NOW() / partition bounds follow the session time zone, so every connection is pinned to UTC.
function parseUtcTimestamp(value: string): Date {
    return new Date(`${value.replace(" ", "T")}Z`);
}

// conn is the raw pg Client (untyped in knex)
function onConnectionCreated(conn: any, done: (err: Error | null, conn: unknown) => void) {
    conn.setTypeParser(PG_TIMESTAMP_OID, parseUtcTimestamp);
    conn.query("SET TIME ZONE 'UTC'", (err: Error | null) => done(err, conn));
}

export function buildKnexConfig(shard: ShardConfig): Knex.Config {
    return {
        client: "pg",
        connection: {
            host: shard.host,
            port: shard.port,
            user: shard.user,
            password: shard.password,
            database: shard.name,
        },
        pool: {
            min: 0,
            max: env.db.poolMax,
            afterCreate: onConnectionCreated,
        },
        migrations: {
            directory: env.db.migrationDir,
            extension: env.db.migrationExtension
        }
    };
}

// default export only feeds the knex CLI (`npm run migrate:make`), which needs the migrations dir.
// it points at REGION (or the first region); real migrations go through migrate-all.ts.
const cliRegion = process.env.REGION ?? env.regions[0]!;
const cliShard = env.hotShards[cliRegion];
if(!cliShard){
    throw new Error(`No shard configured for region "${cliRegion}"`);
}

const config: Knex.Config = buildKnexConfig(cliShard);

export default config;
