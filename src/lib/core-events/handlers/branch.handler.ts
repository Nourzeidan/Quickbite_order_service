import {cacheProvider} from "../../cache/init.js";
import {CORE_CACHE_KEYS} from "../../core-client/cache-keys.js";

// branch.updated / branch.deactivated -> the next lookup re-reads core (isActive=false rejects new orders)
export async function handleBranchChanged(payload: unknown): Promise<void> {
    const {branchId} = payload as {branchId: number};
    if(!Number.isInteger(branchId)){
        throw new Error("branch event: branchId missing");
    }
    await cacheProvider.del(CORE_CACHE_KEYS.branch(branchId));
}
