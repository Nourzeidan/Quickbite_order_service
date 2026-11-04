# Agents Module

Code: `src/app/agent/`. Tables: `agent_presence`, `agent_earnings` (+ reads of `deliveries`). Endpoints: [api-contracts §4](../api-contracts.md#4-agents). Phase 4.

Delivery state changes live in the Deliveries module (`PATCH /deliveries/:id/status`).

## 1. Presence model

One row per agent in `agent_presence` (`is_online`, `last_seen_at`, `last_lat/last_lng`, generated `location`). No presence history.

Redis keeps the working set for assignment and dashboards:

| Key | Purpose | Updated by |
|---|---|---|
| `presence:geo:<region>` (GEO) | coordinates of online agents | online / offline / ping |
| `presence:busy:<region>` (set) | agents with an active delivery | assignment / delivered / cancel |
| `presence:meta:<region>:<agentId>` (hash) | `lastSeenAt`, online flag | online / offline / ping |

Postgres is the source of truth. A reconciliation loop (`PresenceService.reconcile`, every 60 s per shard) marks agents whose `last_seen_at` is older than `PRESENCE_STALE_SEC` (90 s) offline [Q-A2] and removes them from Redis.

## 2. Endpoints — `PresenceService` / `AgentService`

All: `authenticate → requireRegion() → requireRole(delivery_agent)`; the agent is `req.user.userId`.

### `POST /agents/presence/online` — body `PresenceRequestDTO { lat, lng }`

- `INSERT … ON CONFLICT (agent_id) DO UPDATE` → `is_online=true`, `last_seen_at=NOW()`, coordinates [Q-A4].
- `GEOADD presence:geo:<region>`, set `presence:meta`.
- **200** `{ online: true }`.

### `POST /agents/presence/offline`

- Active delivery `picked` → 409 `Agent has an active delivery`.
- Active delivery `assigned` / `accepted` → trigger reassignment (Deliveries §4).
- `is_online=false`; remove from `presence:geo` and `presence:busy`.
- **200** `{ online: false }`.

### `POST /agents/presence/ping` — body `PresenceRequestDTO`

- Not online → 409 `Agent is not online`.
- Redis `GEOADD` + `presence:meta` on every ping; the Postgres row at most once per 15 s per agent (protects the primary).
- If the agent has a `picked` delivery → WS `delivery.position` → `customer:<id>`.
- **200** `{ online: true }`. Clients ping every ~30 s while online.

### `GET /agents/tasks?status=`

- Deliveries of the agent, optional `status` (`assigned | accepted | picked | delivered`), cursor by `assigned_at DESC` [Q-D1]; order data for the page loaded with one `whereIn`.
- `withCache(5, true)`; deleted on every transition of that agent's deliveries.
- **200** paginated `DeliveryTaskResponseDTO[]`.

### `GET /agents/earnings?from=&to=`

- Defaults: first day of the current month → now. Range in a prior year → `dbArchive(region)` (Phase 7).
- One range scan [Q-A3] for the page + one `SUM`/`COUNT` aggregate for the totals.
- **200** `AgentEarningsResponseDTO`.

## 3. Assignment integration

The Deliveries module reads `presence:geo:<region>`. Redis cold/down → fallback query [Q-A1]:

```sql
SELECT agent_id, ST_Distance(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_meters
FROM agent_presence
WHERE is_online = TRUE AND last_seen_at > NOW() - INTERVAL '90 seconds'
ORDER BY location <-> ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography
LIMIT 5;
```

## 4. Invariants

1. `is_online = true` ⇔ the agent is in `presence:geo:<region>` (eventually, within one reconciliation cycle).
2. An agent in `presence:busy:<region>` has a delivery in `assigned | accepted | picked`.
3. Going offline with a `picked` delivery is forbidden.

## 5. RBAC

Agent-self only; no permissions. `requireRole(delivery_agent)` + the agent id always comes from the JWT, never from the request.

## 6. Configuration

`PRESENCE_STALE_SEC=90`.

## 7. Errors (`app/agent/errors.ts`)

`AgentHasActiveDeliveryError`, `AgentNotOnlineError`.
