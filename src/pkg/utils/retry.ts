export interface RetryOptions {
    attempts: number;           // total tries including the first
    initialDelayMs: number;
    maxDelayMs: number;
    isRetryable?: (err: unknown) => boolean;
}

// exponential backoff: initialDelayMs, x2, x4 ... capped at maxDelayMs
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
    let delay = options.initialDelayMs;
    let lastError: unknown;

    for(let attempt = 1; attempt <= options.attempts; attempt++){
        try{
            return await fn();
        }catch(err){
            lastError = err;
            if(options.isRetryable && !options.isRetryable(err)){
                throw err;
            }
            if(attempt === options.attempts){
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, options.maxDelayMs);
        }
    }
    throw lastError;
}
