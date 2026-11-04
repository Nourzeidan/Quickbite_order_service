import knex, {type Knex} from "knex";
import {env} from "../config/env.js";
import {assertRegion} from "../sharding/regions.js";
import {buildKnexConfig} from "./knexfile.js";

// one pool per region and cluster, created on first use.
// there is no global `db`: every query picks its shard with db(region).
const hotShards = new Map<string, Knex>();
const archiveShards = new Map<string, Knex>();

export function db(region: string): Knex {
    assertRegion(region);
    let conn = hotShards.get(region);
    if(!conn){
        conn = knex(buildKnexConfig(env.hotShards[region]!));
        hotShards.set(region, conn);
    }
    return conn;
}

// archive cluster (prior years) — used from Phase 7
export function dbArchive(region: string): Knex {
    assertRegion(region);
    const shard = env.archiveShards[region];
    if(!shard){
        throw new Error(`No archive shard configured for region "${region}" (ARCHIVE_DB_${region}_*)`);
    }
    let conn = archiveShards.get(region);
    if(!conn){
        conn = knex(buildKnexConfig(shard));
        archiveShards.set(region, conn);
    }
    return conn;
}

export async function pingDB(region: string) {
    await db(region).raw("SELECT 1+1 AS result");
}

export interface ShardPing {
    region: string;
    ok: boolean;
    error?: string;
}

// hot shards only: archive clusters may not exist before Phase 7
export async function pingAll(): Promise<ShardPing[]> {
    return Promise.all(env.regions.map(async (region): Promise<ShardPing> => {
        try{
            await pingDB(region);
            return {region, ok: true};
        }catch(err){
            return {region, ok: false, error: (err as Error).message};
        }
    }));
}

export async function destroyAll(): Promise<void> {
    const pools = [...hotShards.values(), ...archiveShards.values()];
    await Promise.all(pools.map((pool) => pool.destroy()));
    hotShards.clear();
    archiveShards.clear();
}
