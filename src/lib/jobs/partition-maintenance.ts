import {env} from "../config/env.js";
import {db} from "../knex/knex.js";
import {logger} from "../logger/logger.js";
import {MinsToMS} from "../../pkg/utils/time.js";
import {startIntervalJob, type IntervalJob} from "./interval-job.js";

// pg_partman is installed without its background worker, so the app premakes partitions:
// partman.run_maintenance_proc() on every hot shard. It takes an advisory lock, so several
// instances calling it at once is safe (the others skip). PARTMAN_MAINTENANCE_INTERVAL_MIN=0
// turns this off where pg_partman_bgw (or pg_cron) runs it instead.
export function startPartitionMaintenance(): IntervalJob {
    return startIntervalJob("partition-maintenance", MinsToMS(env.db.partmanMaintenanceIntervalMin), async () => {
        for(const region of env.regions){
            try{
                await db(region).raw("CALL partman.run_maintenance_proc()");
                logger.info("partition maintenance done", {region});
            }catch(err){
                // one shard down must not stop the others
                logger.error("partition maintenance failed", {region, error: (err as Error).message});
            }
        }
    });
}
