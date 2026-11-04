// Runs knex migrations on every shard of a cluster, one region at a time.
//   tsx src/lib/knex/migrate-all.ts latest              -> every hot shard
//   tsx src/lib/knex/migrate-all.ts rollback            -> last batch on every hot shard
//   tsx src/lib/knex/migrate-all.ts latest --archive    -> every archive shard (Phase 7)
//   REGION=eg tsx src/lib/knex/migrate-all.ts latest    -> only eg
// Stops at the first failing shard so shards never drift silently.
import knex from "knex";
import {env} from "../config/env.js";
import {logger} from "../logger/logger.js";
import {buildKnexConfig} from "./knexfile.js";

type Command = "latest" | "rollback";

const command = process.argv[2] as Command;
const cluster = process.argv.includes("--archive") ? "archive" : "hot";
const onlyRegion = process.env.REGION;

async function run() {
    if(command !== "latest" && command !== "rollback"){
        throw new Error(`Unknown command "${process.argv[2]}". Use "latest" or "rollback".`);
    }

    const shards = cluster === "hot" ? env.hotShards : env.archiveShards;
    const regions = Object.keys(shards).filter((region) => !onlyRegion || region === onlyRegion);
    if(regions.length === 0){
        throw new Error(`No ${cluster} shards configured${onlyRegion ? ` for region "${onlyRegion}"` : ""}`);
    }

    for(const region of regions){
        const conn = knex(buildKnexConfig(shards[region]!));
        try{
            const [batch, files] = command === "latest"
                ? await conn.migrate.latest()
                : await conn.migrate.rollback();
            logger.info(`migrate ${command}`, {cluster, region, batch, files});
        }finally{
            await conn.destroy();
        }
    }
}

run().catch((err) => {
    logger.error("migration failed", {cluster, error: (err as Error).message});
    process.exit(1);
});
