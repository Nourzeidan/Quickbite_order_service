# RBAC

order-service has **no** permission catalog of its own. Roles, permissions and `role_permissions` live in core-service. This service adds permissions under its own namespace (`order:*`, matching core's `core:*`) and reads them through a cached projection.

Code: `src/lib/auth/rbac.ts` (middleware), `src/lib/auth/permission-cache.service.ts` (Phase 1), `src/lib/core-client/permission.client.ts` (Phase 1).

## 1. Permissions seeded in core-service

New core migration `seed_order_service_permissions_table.ts` (same style as core's `seed_rbac_table`):

```sql
INSERT INTO permissions (resource, action, created_at) VALUES
    ('order:order',    'read',          NOW()),
    ('order:order',    'accept',        NOW()),
    ('order:order',    'update',        NOW()),
    ('order:order',    'cancel',        NOW()),
    ('order:payment',  'read',          NOW()),
    ('order:payment',  'refund',        NOW()),
    ('order:delivery', 'assign',        NOW()),
    ('order:finance',  'read',          NOW()),
    ('order:finance',  'payout_create', NOW())
ON CONFLICT (resource, action) DO NOTHING;
```

Role mapping (same migration):

| Role | Permissions |
|---|---|
| `owner` | all of the above |
| `branch_manager` | `order:order:read`, `order:order:accept`, `order:order:update`, `order:order:cancel`, `order:finance:read` |
| `staff` | `order:order:read`, `order:order:accept`, `order:order:update` |

`order:payment:refund`, `order:delivery:assign`, `order:finance:payout_create` are admin-only today (admin bypasses RBAC); they are seeded so a role can be granted them later without a code change.

## 2. Resolution at request time

```ts
rbac({ resource: "order:order", action: "read" })
```

1. No `req.user` → 401 `Not Authenticated`.
2. `req.user.role === 'admin'` (core `SystemRole.ADMIN`) → allowed.
3. `req.user.role === 'restaurant_user'` → `permissionCacheService.getPermissions(req.user.restaurantRole)`:
   - Redis `core:rbac:perms:<roleName>` (TTL 5 min), miss → `GET /api/internal/roles/:roleName/permissions` on core → cache.
   - Core down → serve the last value for up to 1 h (a second key `…:stale` with a 1 h TTL); after that → deny.
   - Allowed if the list contains `${resource}:${action}` (core's `hasPermissions` format).
4. Any other role → 403 `Not Authorized for such Action !`.

Invalidation: `rbac.permissions_changed` from core over RabbitMQ deletes `core:rbac:perms:<roleName>`.

Until Phase 1 wires the permission cache, `rbac()` lets admins through and **denies everyone else** (fail-closed).

## 3. Other guards (`lib/auth/rbac.ts`)

| Guard | Rule |
|---|---|
| `requireRole(...roles)` | `req.user.role` in the list (admin is **not** implicitly included) |
| `requireRestaurantMember(param)` | admin, or `req.user.restaurantId === req.params[param]` |
| `requireBranchAccess(param)` | admin or `restaurantRole === 'owner'` → allowed; otherwise the branch id from params/query must be in `req.user.branchIds`; no branch id in the request → allowed (endpoint not branch-scoped) |

## 4. Per-endpoint table

| Endpoint | Gate |
|---|---|
| `POST /orders` | `requireRole(customer)` |
| `GET /orders/:publicId` | authenticated; ownership in the service |
| `GET /customer/orders` | `requireRole(customer)` |
| `GET /restaurant/orders` | `rbac(order:order, read)` + `requireBranchAccess('branchId')` |
| `GET /admin/orders` | `requireRole(admin)` |
| `PATCH /orders/:publicId/status` | authenticated; the service checks the target: `accept` (accepted/rejected), `update` (preparing/ready), `cancel` (cancelled), customer window, admin |
| `POST /payments/init` | `requireRole(customer)` + own order |
| `POST /payments/webhook/:provider` | none (HMAC) |
| `GET /payments/:id` | admin or `rbac(order:payment, read)` + own restaurant |
| `POST /payments/:id/refund` | `requireRole(admin)` |
| `POST /deliveries/assign/:orderPublicId`, `…/reassign/…` | `requireRole(admin)` |
| `PATCH /deliveries/:id/status` | `requireRole(delivery_agent)` + ownership |
| `/agents/*` | `requireRole(delivery_agent)` + self |
| `GET /restaurant/balance`, `GET /restaurant/payouts` | `rbac(order:finance, read)` |
| `POST /restaurant/payouts` | `requireRole(admin)` |

## 5. Resource-level checks (in services)

They need the row, so they live in services, not middleware:

- **customer**: `order.customer_id === req.user.userId`.
- **restaurant_user**: `order.restaurant_id === req.user.restaurantId` and, unless owner, `order.branch_id ∈ req.user.branchIds`.
- **delivery_agent**: `delivery.agent_id === req.user.userId`.
- **admin**: no ownership check, but the region still applies — the row is read from `db(req.region)`, so a region-A request can never see region-B data.

A failed ownership check on a specific order returns 404 `Order not found` (no existence leak).
