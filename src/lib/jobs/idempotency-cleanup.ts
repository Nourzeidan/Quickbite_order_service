import {env} from "../config/env.js";
import {db} from "../knex/knex.js";
import {logger} from "../logger/logger.js";
import {MinsToMS} from "../../pkg/utils/time.js";
import {deleteExpiredIdempotencyKeys} from "../idempotency/idempotency-key.repo.js";
import {startIntervalJob, type IntervalJob} from "./interval-job.js";

const BATCH = 5000;

// Q-I2: expired idempotency_keys rows, in batches, every shard
export function startIdempotencyCleanup(): IntervalJob {
    return startIntervalJob("idempotency-cleanup", MinsToMS(env.db.idempotencyCleanupIntervalMin), async () => {
        for(const region of env.regions){
            try{
                let deleted = 0;
                let batch: number;
                do{
                    batch = await deleteExpiredIdempotencyKeys(BATCH, db(region));
                    deleted += batch;
                }while(batch === BATCH);
                if(deleted > 0) logger.info("expired idempotency keys deleted", {region, deleted});
            }catch(err){
                logger.error("idempotency cleanup failed", {region, error: (err as Error).message});
            }
        }
    });
}
