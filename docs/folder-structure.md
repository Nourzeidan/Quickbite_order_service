# Folder Structure & Code Conventions

Mirrors `core-service`. Differences are listed in §8.

## 1. Tree

Files marked ✅ exist (Phase 0). Everything else is the target end state, added by the phase noted.

```
order-service/
├── CLAUDE.md                                  ✅
├── package.json  tsconfig.json  .gitignore  .env.example   ✅
├── full_prd.md  api-contracts.md (root draft)  img*.png     (inputs)
├── _old-design/                               (previous design, reference only)
├── docs/                                      ✅
└── src/
    ├── app.ts                                 ✅ express composition (helmet, cors, json, cookie, correlation, region, routes, errorHandler)
    ├── server.ts                              ✅ HTTP server + socket.io + core-events consumer + graceful shutdown
    ├── routes.ts                              ✅ mounts every module router under /api
    ├── worker.ts                                 Phase 7 — archival worker entry
    │
    ├── app/                                   business modules
    │   ├── health/health.routes.ts            ✅
    │   ├── order/                                Phase 1
    │   │   ├── controller/order.controller.ts
    │   │   ├── service/order.service.ts
    │   │   ├── service/order-status.service.ts      # transition table + assertTransition
    │   │   ├── repository/order.repo.ts
    │   │   ├── repository/order-item.repo.ts
    │   │   ├── repository/idempotency-key.repo.ts
    │   │   ├── service/order-pricing.service.ts      # pure pricing
    │   │   ├── entity/order.entity.ts
    │   │   ├── entity/order-item.entity.ts
    │   │   ├── dto/order.request.dto.ts
    │   │   ├── dto/order.response.dto.ts
    │   │   ├── enums.ts  errors.ts  types.ts  routes.ts
    │   ├── payment/                              Phase 2
    │   │   ├── controller/payment.controller.ts
    │   │   ├── controller/webhook.controller.ts      # /payments/webhook/:provider (no auth, HMAC)
    │   │   ├── service/payment.service.ts
    │   │   ├── service/webhook.service.ts
    │   │   ├── service/refund.service.ts
    │   │   ├── service/payment-sweep.service.ts      # pending_payment expiry loop
    │   │   ├── repository/payment-session.repo.ts
    │   │   ├── repository/transaction.repo.ts
    │   │   ├── repository/payment-webhook-event.repo.ts
    │   │   ├── repository/payment-provider.repo.ts
    │   │   ├── entity/ dto/ enums.ts errors.ts types.ts routes.ts
    │   ├── delivery/                             Phase 3
    │   │   ├── controller/delivery.controller.ts
    │   │   ├── service/delivery.service.ts
    │   │   ├── service/assignment.service.ts         # auto + manual + reassign + timeout scan
    │   │   ├── service/settlement.service.ts         # money on delivered
    │   │   ├── repository/delivery.repo.ts
    │   │   ├── entity/ dto/ enums.ts errors.ts types.ts routes.ts
    │   ├── agent/                                Phase 4
    │   │   ├── controller/agent.controller.ts
    │   │   ├── service/presence.service.ts
    │   │   ├── service/agent.service.ts              # tasks + earnings reads
    │   │   ├── repository/agent-presence.repo.ts
    │   │   ├── repository/agent-earning.repo.ts
    │   │   ├── entity/ dto/ enums.ts errors.ts routes.ts
    │   └── restaurant-finance/                   Phase 5
    │       ├── controller/finance.controller.ts
    │       ├── service/finance.service.ts
    │       ├── repository/restaurant-balance.repo.ts
    │       ├── entity/ dto/ errors.ts routes.ts
    │
    ├── lib/                                   app-aware glue
    │   ├── auth/
    │   │   ├── guard.ts                       ✅ authenticate (Bearer, cookie fallback)
    │   │   ├── jwt.ts                         ✅ JwtPayload + verifyAccessToken (same secret as core)
    │   │   ├── rbac.ts                        ✅ requireRole, rbac, requireRestaurantMember, requireBranchAccess
    │   │   ├── enums.ts                       ✅ SystemRole, RestaurantRole (mirror core)
    │   │   ├── errors.ts                      ✅
    │   │   └── permission-cache.service.ts       Phase 1 — role → permissions via core-client + Redis
    │   ├── cache/{init.ts, withCache.ts}      ✅
    │   ├── config/env.ts                      ✅ zod; regions + per-region hot/archive shard configs
    │   ├── correlation/correlationId.ts       ✅
    │   ├── core-client/
    │   │   ├── core-client.ts                 ✅ fetch wrapper: api-key, correlation, timeout, retry
    │   │   ├── errors.ts  types.ts            ✅
    │   │   └── branch.client.ts product.client.ts address.client.ts permission.client.ts stock.client.ts   Phase 1+
    │   ├── core-events/
    │   │   ├── consumer.ts                    ✅ topology + dedupe + handler registry + ack/nack
    │   │   ├── types.ts                       ✅
    │   │   └── handlers/*.handler.ts             Phase 1+ (one file per event type)
    │   ├── di/{container.ts, tokens.ts}       ✅
    │   ├── error/{AppError.ts, errorHandler.ts}   ✅
    │   ├── http/
    │   │   ├── response.ts                    ✅ sendSuccess, sendPaginated
    │   │   └── pagination/{cursor-pagination.ts, parse-query.ts}   ✅ (core copies)
    │   ├── idempotency/{idempotency.ts, errors.ts}   ✅ Redis (user-scoped, fingerprint, in-flight lock); DB store wired in Phase 1
    │   ├── knex/
    │   │   ├── knex.ts                        ✅ db(region), dbArchive(region), pingAll, destroyAll
    │   │   ├── knexfile.ts                    ✅ buildKnexConfig(shard) + default export for the knex CLI
    │   │   └── migrate-all.ts                 ✅ runs migrations on every shard (hot or archive)
    │   ├── jobs/{interval-job.ts, partition-maintenance.ts}   Phase 1 — pg_partman maintenance timer
    │   ├── jobs/archival.worker.ts               Phase 7
    │   ├── logger/logger.ts                   ✅
    │   ├── messaging/init.ts                  ✅ the RabbitMQ client instance
    │   ├── sharding/{regions.ts, region-resolver.ts, errors.ts}   ✅
    │   ├── types/express.d.ts                 ✅ Request: correlationId, region, user
    │   ├── validation/validate.ts             ✅ validateBody, validateQuery
    │   └── websocket/{ws-server.ts, ws-auth.ts, errors.ts}         ✅ socket.io + Redis adapter
    │
    ├── pkg/                                   app-agnostic, framework-free
    │   ├── cache/{cache.interface.ts, redis.ts}                    ✅
    │   ├── messaging/
    │   │   ├── message-broker.interface.ts    ✅ IMessageBroker
    │   │   └── rabbitmq/{rabbitmq.client.ts, rabbitmq.types.ts}    ✅ amqp-connection-manager wrapper
    │   ├── payments/                             Phase 2
    │   │   ├── payment.interface.ts           IPaymentProvider: createSession, refund, verifyWebhook
    │   │   └── kashier/{kashier.client.ts, kashier.types.ts, kashier.signature.ts}
    │   └── utils/{time.ts, money.ts, retry.ts}                     ✅
    │
    └── migrations/                            ✅ (empty until Phase 1) raw-SQL knex migrations
```

## 2. Layering & dependency rule

```
app  ──►  lib  ──►  pkg
 │                    ▲
 └────────────────────┘   (app may use pkg types/helpers directly)
```

| Layer | May import | Must NOT import | Examples |
|---|---|---|---|
| `pkg/` | node built-ins, npm packages, other `pkg/` | **anything in `lib/` or `app/`**, `env`, DI container, express | `RedisCacheProvider(config)`, `RabbitMQClient(config)`, `KashierClient(config)`, `toMinor()` |
| `lib/` | `pkg/`, npm, other `lib/` | `app/` (exception: `lib/di/container.ts` registers app classes) | `db(region)`, `authenticate`, `withCache`, `idempotency()`, `coreClient` |
| `app/` | `lib/`, `pkg/`, other `app/` modules **through services injected by DI** | another module's repository or controller | `OrderService`, `AssignmentService` |

Consequences:

- `pkg` classes take **config objects in constructors** (core's `RedisCacheProvider(config)` pattern) and expose an interface. `lib/*/init.ts` instantiates them from `env`; `lib/di/container.ts` registers the instances.
- core-service leaks (`lib/auth/guard.ts → app/auth/utils.ts`, `lib/validation/validate.ts → app/auth/errors.ts`) are **not** copied: `JwtPayload` / `verifyAccessToken` live in `lib/auth/jwt.ts`, validation errors are built in `lib/validation/`.
- Cross-module work goes service → service via DI (`@inject(TOKENS.PaymentService)`), never into another module's repository. Settlement (Deliveries) writes ledger rows through `PaymentService` / `TransactionService` methods that accept the caller's `trx`.

## 3. Module anatomy (per feature, same as core)

```
app/<module>/
  controller/<name>.controller.ts   # @injectable class, arrow-function handlers, try/catch → next(err)
  dto/<name>.request.dto.ts         # class-validator classes (input)
  dto/<name>.response.dto.ts        # plain classes with static from(...) (output)
  entity/<name>.entity.ts           # class with constructor(data: Partial<X>)
  repository/<name>.repo.ts         # exported async functions, *_COLUMNS, toEntity(row), conn last
  service/<name>.service.ts         # @injectable class, business rules, explicit trx
  enums.ts                          # TS enums mirroring DB CHECK values
  errors.ts                         # export const XxxError = new AppError("Message", status)
  types.ts                          # non-entity row/input types shared inside the module
  routes.ts                         # Router, container.resolve(controller), middleware chain
```

### 3.1 Controller

```ts
@injectable()
export class OrderController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService){}

    create = async (req: Request, res: Response, next: NextFunction) => {
        try{
            const data = await validateBody(CreateOrderRequestDTO, req.body);
            const result = await this.orderService.place(req.region, req.user!, data, req.correlationId);
            sendSuccess(res, result, 201);              // result: OrderResponseDTO
        }catch(error){
            next(error);
        }
    }
}
```

Rules: validate → one service call → `sendSuccess` / `sendPaginated`. No business logic, no repository imports, no `res.status().json()` with ad-hoc objects.

### 3.2 DTOs (the deliberate difference from core)

- **Request DTOs**: class-validator, `!` definite assignment, `@IsOptional()` first, nested arrays with `@ValidateNested({ each: true }) @Type(() => X)`. Query strings go through `validateQuery(Cls, req.query)`.
- **Response DTOs**: every service method feeding a controller returns a response DTO (or `{ data: DTO[], meta }`):

```ts
export class OrderSummaryResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    total!: number;
    currency!: Currency;
    itemsCount!: number;
    branchId!: number;
    createdAt!: string;

    static from(order: Order, itemsCount: number): OrderSummaryResponseDTO {
        const dto = new OrderSummaryResponseDTO();
        dto.publicId = order.publicId;
        dto.status = order.status;
        dto.total = order.total;
        dto.currency = order.currency;
        dto.itemsCount = itemsCount;
        dto.branchId = order.branchId;
        dto.createdAt = order.createdAt.toISOString();
        return dto;
    }
}
```

- Never return entities or raw rows. Internal ids (`orders.id`), idempotency keys, raw provider payloads and owner ids never appear in responses.
- `BIGINT` ids come back from `pg` as strings → `Number(row.id)` in `toEntity`.
- WebSocket payloads reuse response DTOs (or a documented subset).

### 3.3 Entity

Same as core:

```ts
export class Order {
    id: number;
    region: string;
    publicId: string;
    status: OrderStatus;
    // ...
    constructor(data: Partial<Order>){
        this.id = data.id!;
        this.region = data.region!;
        this.publicId = data.publicId!;
        this.status = data.status!;
        // ...
    }

    isTerminal(): boolean {
        return [OrderStatus.DELIVERED, OrderStatus.REJECTED, OrderStatus.CANCELLED].includes(this.status);
    }
}
```

### 3.4 Repository

```ts
const ORDER_COLUMNS = ["id", "region", "public_id", "branch_id", "customer_id", "status", "total", "currency", "created_at" /* ... */];

function toEntity(row: any): Order {
    return new Order({
        id: Number(row.id),
        region: row.region,
        publicId: row.public_id,
        // ...
    });
}

// Q-O1
export async function findOrderByPublicId(publicId: string, conn: Knex): Promise<Order | null> {
    const [row] = await conn("orders").select(ORDER_COLUMNS).where("public_id", publicId);
    if(!row){
        return null;
    }
    return toEntity(row);
}
```

Rules: exported async functions (no classes); **last parameter `conn: Knex` is required** (a pool from `db(region)` or a `trx`) — there is no `= db` default because there is no global db; explicit columns; a `// Q-xx` comment on every query; no business decisions; "not found" returns `null`.

### 3.5 Service

`@injectable()`, dependencies via `@inject(TOKENS.X)`, owns the transaction (core `auth.service.ts` style):

```ts
place = async (region: string, user: JwtPayload, data: CreateOrderRequestDTO, correlationId: string) => {
    const branch = await this.branchClient.getBranch(data.branchId, correlationId);   // network: before the trx
    // ... validate, price ...
    const trx = await db(region).transaction();
    try{
        const order = await insertOrder(orderData, trx);
        const items = await insertOrderItems(itemRows, trx);
        await trx.commit();
        // after commit: reserveStock, WS emit, cache del
        return OrderResponseDTO.from(order, items);
    }catch(error){
        await trx.rollback();
        throw error;
    }
}
```

Do **not** use the `db.transaction(async (trx) => {...})` callback form — keep it consistent with core.

### 3.6 Routes

```ts
export const orderRouter = Router();
const orderController = container.resolve<OrderController>(TOKENS.OrderController);

orderRouter.post('/orders',
    authenticate,
    requireRole(SystemRole.CUSTOMER),
    idempotency({strict: true}),
    orderController.create);

orderRouter.get('/restaurant/orders',
    authenticate,
    requireRegion(),
    rbac({resource: "order:order", action: "read"}),
    requireBranchAccess('branchId'),
    withCache(10),
    orderController.listForRestaurant);
```

Middleware order: `authenticate → requireRegion → requireRole / rbac / requireBranchAccess → idempotency / withCache → controller`. (`POST /orders` skips `requireRegion` because it may derive the region from the branch.) Mounted in `src/routes.ts`:

```ts
routes.use(healthRouter);
routes.use("/", orderRouter);            // /orders, /customer/orders, /restaurant/orders
routes.use("/payments", paymentRouter);
routes.use("/deliveries", deliveryRouter);
routes.use("/agents", agentRouter);
routes.use("/", financeRouter);          // /restaurant/balance, /restaurant/payouts
```

### 3.7 Errors

```ts
// app/order/errors.ts
export const OrderNotFoundError = new AppError("Order not found", 404);
export const InvalidStatusTransitionError = new AppError("Invalid status transition", 409);
```

Same `AppError(message, statusCode, isOperational = true)` as core; the handler renders `{ "error": message }`. Messages are the canonical list in [api-contracts.md §9](./api-contracts.md#9-error-messages-canonical).

### 3.8 DI

`lib/di/tokens.ts` groups `Symbol.for(...)` tokens (services, controllers, lib). `lib/di/container.ts` registers services and controllers with `registerSingleton` and infrastructure with `registerInstance` (logger, cache provider, message broker, core client, socket.io server).

## 4. File & symbol naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case + role suffix | `order-status.service.ts`, `payment-session.repo.ts`, `order.request.dto.ts` |
| Classes | PascalCase + role | `OrderStatusService`, `OrderController`, `CreateOrderRequestDTO` |
| DTO names | `<Action><Resource>RequestDTO`, `<Resource>[Detail|Summary]ResponseDTO` | `UpdateOrderStatusRequestDTO` |
| Repo functions | verb + noun + By + key | `findOrderByPublicId`, `insertOrderItems`, `updateOrderStatus` |
| Enums | PascalCase type, UPPER_SNAKE members, lowercase values = DB values | `OrderStatus.PENDING_PAYMENT = 'pending_payment'` |
| Errors | `<Reason>Error` constant | `OutOfStockError` |
| Imports | ESM with `.js` extension, `import type` for types (`verbatimModuleSyntax`) | `import type { Knex } from "knex";` |
| Permissions | `order:<resource>` + action | `order:order` / `accept` |
| WS events | `<aggregate>.<past_tense>` | `order.status_changed`, `task.assigned` |

## 5. HTTP conventions

- Envelope via `lib/http/response.ts`: `sendSuccess(res, dto, status?, meta?)`, `sendPaginated(res, dtos, meta)`.
- Pagination: core's `parsePaginationQuery` / `applyCursorPagination` / `buildPaginationResult`; lists sort by `createdAt desc`. Unlike core, `parsePaginationQuery(query, allowedSort)` maps `sortBy` through a whitelist (`{ createdAt: "created_at" }`), so a client can't sort by an arbitrary column, and `limit` is capped at 100.
- Filters: core's `parseFilters(query, allowedFields)`; allowed fields must be covered by an index.
- Headers: `X-Region` (in), `Idempotency-Key` (writes), `X-Correlation-ID` (in/out), `X-Cache` (out on cached endpoints).

## 6. Testing layout (when introduced)

`src/**/__tests__/*.test.ts` next to the code. Repositories against a disposable PG (one shard); services with fakes of `ICacheProvider`, `IMessageBroker`, `IPaymentProvider` and the core client (that's why `pkg` exposes interfaces).

## 7. Scripts (package.json)

```json
{
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "migrate": "tsx src/lib/knex/migrate-all.ts latest",
    "migrate:rollback": "tsx src/lib/knex/migrate-all.ts rollback",
    "migrate:archive": "tsx src/lib/knex/migrate-all.ts latest --archive",
    "migrate:make": "tsx ./node_modules/knex/bin/cli.js migrate:make --knexfile src/lib/knex/knexfile.ts",
    "lint": "prettier --check .",
    "format": "prettier --write ."
}
```

## 8. Differences from core-service (intentional)

| Area | core-service | order-service |
|---|---|---|
| Responses | ad-hoc objects / entities | **typed response DTOs** only |
| DB access | global `db`, repos default `conn = db` | `db(region)`, repos **require** `conn` (last param) |
| Money | `DECIMAL(10,2)` | `INT` minor units |
| Auth token | `Authorization: Bearer` | Bearer, with `access_token` cookie fallback; WS handshake `auth.token` / cookie |
| Auth error status | 400 | 401 |
| Correlation id | always generated | incoming `X-Correlation-ID` honoured and forwarded to core |
| Validation error | generic message | field messages joined into the error |
| Logging | `console.log` scattered | `logger` only in `app/` and `lib/` |
| Layer leaks | `lib` imports `app` | forbidden |
| Everything else | — | same: stack, layout, naming, raw-SQL migrations, DI style, explicit transactions, pagination helpers, response envelope |
