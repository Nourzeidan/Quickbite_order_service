import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {ICacheProvider} from "../../pkg/cache/cache.interface.js";
import type {PermissionClient} from "../core-client/permission.client.js";
import {CORE_CACHE_KEYS, CORE_CACHE_TTL_SEC} from "../core-client/cache-keys.js";
import {logger} from "../logger/logger.js";

// role -> permissions projection of core's RBAC (docs/business-logic/rbac.md §2)
//   fresh key 5 min; on a miss ask core; core down -> serve the ":stale" copy (1 h); nothing -> deny.
// invalidated by rbac.permissions_changed (lib/core-events/handlers/rbac.handler.ts).
@injectable()
export class PermissionCacheService {
    constructor(
        @inject(TOKENS.CacheProvider) private readonly cacheProvider: ICacheProvider,
        @inject(TOKENS.PermissionClient) private readonly permissionClient: PermissionClient
    ){}

    getPermissions = async (roleName: string, correlationId?: string): Promise<string[]> => {
        const freshKey = CORE_CACHE_KEYS.rolePermissions(roleName);
        const staleKey = CORE_CACHE_KEYS.rolePermissionsStale(roleName);

        const cached = await this.cacheProvider.get(freshKey).catch(() => null);
        if(cached){
            return JSON.parse(cached) as string[];
        }

        try{
            const permissions = await this.permissionClient.getRolePermissions(roleName, correlationId);
            const serialized = JSON.stringify(permissions);
            await Promise.all([
                this.cacheProvider.set(freshKey, serialized, CORE_CACHE_TTL_SEC.rolePermissions),
                this.cacheProvider.set(staleKey, serialized, CORE_CACHE_TTL_SEC.rolePermissionsStale),
            ]).catch(() => {});
            return permissions;
        }catch(err){
            const stale = await this.cacheProvider.get(staleKey).catch(() => null);
            if(stale){
                logger.warn("permissions: core unavailable, serving stale copy", {roleName, correlationId});
                return JSON.parse(stale) as string[];
            }
            // fail closed
            logger.error("permissions: core unavailable and no stale copy, denying", {roleName, correlationId, error: (err as Error).message});
            return [];
        }
    }

    hasPermission = async (roleName: string | undefined, resource: string, action: string, correlationId?: string): Promise<boolean> => {
        if(!roleName){
            return false;
        }
        const permissions = await this.getPermissions(roleName, correlationId);
        return permissions.includes(`${resource}:${action}`);
    }
}
