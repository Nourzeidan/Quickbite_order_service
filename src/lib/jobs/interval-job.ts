import {logger} from "../logger/logger.js";

export interface IntervalJob {
    stop(): void;
}

// runs fn now and then every intervalMs; a slow run never overlaps the next one.
// intervalMs <= 0 disables the job.
export function startIntervalJob(name: string, intervalMs: number, fn: () => Promise<void>): IntervalJob {
    if(intervalMs <= 0){
        logger.info("job disabled", {job: name});
        return {stop: () => {}};
    }

    let timer: NodeJS.Timeout | null = null;
    let stopped = false;

    const tick = async () => {
        try{
            await fn();
        }catch(err){
            logger.error("job failed", {job: name, error: (err as Error).message});
        }
        if(!stopped){
            timer = setTimeout(tick, intervalMs);
            timer.unref();
        }
    };
    void tick();

    return {
        stop: () => {
            stopped = true;
            if(timer) clearTimeout(timer);
        },
    };
}
