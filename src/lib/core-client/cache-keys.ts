// Layer A keys (system-design §4). Core data is global, so these are NOT region-prefixed.
// The core-event handlers delete exactly these keys.
export const CORE_CACHE_KEYS = {
    branch: (branchId: number) => `core:branch:${branchId}`,
    restaurant: (restaurantId: number) => `core:restaurant:${restaurantId}`,
    product: (branchId: number, productId: number) => `core:product:price:${branchId}:${productId}`,
    rolePermissions: (roleName: string) => `core:rbac:perms:${roleName}`,
    rolePermissionsStale: (roleName: string) => `core:rbac:perms:${roleName}:stale`,
};

export const CORE_CACHE_TTL_SEC = {
    branch: 60,
    restaurant: 5 * 60,
    product: 30,
    rolePermissions: 5 * 60,
    rolePermissionsStale: 60 * 60,
};
