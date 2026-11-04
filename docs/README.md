# order-service — Documentation Index

`order-service` is the QuickBite microservice that owns **orders, payments, deliveries & agents, restaurant finance, and realtime updates**. It is a sibling of `../core-service` (users, auth, restaurants, branches, menus, products) and follows the same stack, layout and conventions, except that **every HTTP response is a typed response DTO** (see [folder-structure.md](./folder-structure.md)).

## Reading order

| # | Document | What it answers |
|---|----------|-----------------|
| 1 | [system-design.md](./system-design.md) | Scope, architecture, country sharding, Redis layers, consistency for money, archival, failure handling |
| 2 | [database-design.md](./database-design.md) | Per-shard schema, DDL, constraints, query catalogue → indexes, ERD, money-flow matrix, migration order |
| 3 | [folder-structure.md](./folder-structure.md) | `app/ lib/ pkg/` layering, module anatomy, file naming, DTO pattern, routing |
| 4 | [api-contracts.md](./api-contracts.md) | Every HTTP endpoint, WebSocket protocol, error messages (corrected version of the root draft) |
| 5 | [integrations.md](./integrations.md) | core-service sync HTTP + inbound RabbitMQ events, Kashier v3 |
| 6 | [business-logic/orders.md](./business-logic/orders.md) | Placement algorithm, pricing, status machine, cancellation, reads |
| 7 | [business-logic/payments.md](./business-logic/payments.md) | Kashier sessions, webhooks, refunds, COD |
| 8 | [business-logic/deliveries.md](./business-logic/deliveries.md) | Assignment algorithm, delivery status machine, settlement on delivered, reassignment |
| 9 | [business-logic/agents.md](./business-logic/agents.md) | Presence model, task list, earnings |
| 10 | [business-logic/restaurant-finance.md](./business-logic/restaurant-finance.md) | Balance and payout reads, admin payout recording |
| 11 | [business-logic/rbac.md](./business-logic/rbac.md) | Permissions seeded in core, per-endpoint mapping, cached resolution |
| 12 | [business-logic/realtime.md](./business-logic/realtime.md) | socket.io server, rooms, events, emit-after-commit |
| 13 | [implementation-plan.md](./implementation-plan.md) | Phase-by-phase build order with acceptance gates and the PR checklist |

The project-wide rules for contributors (human or AI) live in [`../CLAUDE.md`](../CLAUDE.md).

## Inputs these docs were derived from

- `../full_prd.md` — QuickBite PRD (functional + non-functional requirements).
- `../img.png`, `../img_1.png` — system design whiteboard (core + orders/payments services, Redis per service, **relational DB per region**, analytics/NoSQL, CDN).
- `../img_2.png` — first ERD draft (`orders`, `order_items`, `transactions`, `payment_providers`, `restaurant_balances`, `agent_presence`, `agent_earnings`).
- `../api-contracts.md` — first API draft (kept untouched; superseded by [api-contracts.md](./api-contracts.md)).
- `../../order-service-example` — the reference design these docs follow (tables, phases, inbound-only async, archive cluster).
- `../../core-service` — reference implementation for code conventions.
- Kashier v3 docs: [payment sessions](https://developers.kashier.io/payment/payment-sessions), [webhooks](https://developers.kashier.io/webhooks/setup).
- `../_old-design/` — the previous order-service design (outbox/inbox, status history, assignment offers). Kept for reference only; not current.

## Out of scope for this service (for now)

- Analytics service (NoSQL, aggregates) and any event emission to it.
- **Outbound async events** from this service to anyone — async with core is inbound only.
- DevOps (containers, LB, multi-AZ, observability, benchmarks) — the service stays stateless and horizontally scalable so it fits that plan later.
- Read replicas — one primary per region until load data justifies more.
- Incentives / promo codes / loyalty / reviews / recommendations.

## Decisions log

| Decision | Choice | Where |
|----------|--------|-------|
| Shard key | Country, named `region` in code and columns (`eg`, `ksa`); one Postgres cluster per country | system-design §3 |
| Region source | `X-Region` header only; `POST /orders` may derive it from the branch; `all` only for admin fan-out reads | system-design §3.2 |
| Money | `INT` minor units + `currency` (`EGP`, `SAR`) | database-design §2 |
| Timestamps | `TIMESTAMP` (UTC), same as core | database-design §1 |
| Payouts | No `payouts` table — a `transactions` row with `transaction_type = 'payout'` | database-design §4.5 |
| Ledger accounts | `src_acc_id` / `dst_acc_id` = core `users.id`; restaurant ⇒ **owner id**; platform ⇒ **NULL** | database-design §2 |
| Deliveries model | `deliveries` table, one row per assignment, reassignment chain via `reassigned_from`; current agent denormalized on `orders.delivery_agent_id` | database-design §4.7 |
| Async transport | RabbitMQ, **inbound only** (core → order cache invalidation), dedupe in Redis `SET NX`, DLQ for failures | integrations §3 |
| Stock | Sync check at placement, `reserveStock` on core right after commit; order voided if the reservation fails | orders §2 |
| Online payments | Kashier v3 Payment Sessions + HMAC-verified webhooks; order moves to `placed` only on a verified capture | payments |
| Realtime | socket.io on `/ws`, `@socket.io/redis-adapter`, rooms = channels, emit after commit | realtime |
| Archival | Separate `order_service_archive` cluster per region, nightly worker (Phase 7) | system-design §10 |
| Transactions | Explicit `trx` + commit/rollback (core `auth.service.ts` style) | folder-structure §3.5 |
| Permission names | `order:<resource>` + action, matching core's `core:<resource>` naming | rbac |
| Admin role | core's `admin` system role (the example's `system_admin` does not exist in core) | rbac |
| Background loops | In-process timers: payment-expiry sweep (Phase 2), assignment timeout scan (Phase 3), presence reconciliation (Phase 4); archival worker is a separate process (Phase 7) | system-design §2 |
