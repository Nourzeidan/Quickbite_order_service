import {cacheProvider} from "../../cache/init.js";
import {CORE_CACHE_KEYS} from "../../core-client/cache-keys.js";

// rbac.permissions_changed -> drop both the fresh and the stale projection of that role
export async function handlePermissionsChanged(payload: unknown): Promise<void> {
    const {roleName} = payload as {roleName: string};
    if(typeof roleName !== "string" || roleName.length === 0){
        throw new Error("rbac event: roleName missing");
    }
    await Promise.all([
        cacheProvider.del(CORE_CACHE_KEYS.rolePermissions(roleName)),
        cacheProvider.del(CORE_CACHE_KEYS.rolePermissionsStale(roleName)),
    ]);
}
