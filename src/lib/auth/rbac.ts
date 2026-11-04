import type {NextFunction, Request, Response} from "express";
import {BranchAccessDeniedError, NotAuthenticated, unAuthorizedError} from "./errors.js";
import {RestaurantRole, SystemRole} from "./enums.js";
import {container} from "../di/container.js";
import {TOKENS} from "../di/tokens.js";
import type {PermissionCacheService} from "./permission-cache.service.js";

export interface RBACOptions {
    resource: string;           // "order:order", "order:finance", ...
    action: string;             // "read", "accept", ...
    allowSystemAdmin?: boolean;
}

export function requireRole(...roles: SystemRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            throw NotAuthenticated;
        }
        if(!roles.includes(req.user.role as SystemRole)){
            throw unAuthorizedError;
        }
        next();
    }
}

// system admin bypasses this.
// restaurant users need `${resource}:${action}` for their restaurantRole, resolved from core through
// PermissionCacheService (Redis, stale-serve when core is down). Every other role is denied.
export function rbac(options: RBACOptions) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            throw NotAuthenticated;
        }
        const {allowSystemAdmin = true} = options;
        if(allowSystemAdmin && req.user.role === SystemRole.ADMIN){
            return next();
        }
        if(req.user.role !== SystemRole.RESTAURANT_USER){
            throw unAuthorizedError;
        }
        const permissionCache = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);
        const allowed = await permissionCache.hasPermission(req.user.restaurantRole, options.resource, options.action, req.correlationId);
        if(!allowed){
            throw unAuthorizedError;
        }
        next();
    }
}

export function requireRestaurantMember(paramName: string = 'restaurantId') {
    return (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            throw NotAuthenticated;
        }
        if(req.user.role === SystemRole.ADMIN){
            return next();
        }
        const restaurantId = Number(req.params[paramName]);
        if(!restaurantId || Number(req.user.restaurantId) !== restaurantId){
            throw unAuthorizedError;
        }
        next();
    }
}

export function requireBranchAccess(paramName: string = 'branchId') {
    return (req: Request, res: Response, next: NextFunction) => {
        if(!req.user){
            throw NotAuthenticated;
        }
        if(req.user.role === SystemRole.ADMIN){
            return next();
        }

        const branchId = Number(req.params[paramName]) || Number(req.query[paramName]);
        if(!branchId){
            // endpoint is not scoped to a specific branch
            return next();
        }

        if(req.user.role !== SystemRole.RESTAURANT_USER){
            throw BranchAccessDeniedError;
        }
        if(req.user.restaurantRole === RestaurantRole.OWNER){
            // owner sees every branch of THEIR restaurant; the service still checks restaurant_id on the row
            return next();
        }
        const userBranchIds = req.user.branchIds ?? [];
        if(!userBranchIds.includes(branchId)){
            throw BranchAccessDeniedError;
        }
        next();
    }
}
