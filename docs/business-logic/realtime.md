# Realtime Module (WebSocket)

Code: `src/lib/websocket/` (scaffold, Phase 0). Event wiring into services: Phase 6. Protocol: [api-contracts §6](../api-contracts.md#6-websocket-socketio).

## 1. Goals

Push order, payment and delivery changes to the four apps so they don't poll; keep the server stateless (any instance can serve any socket).

## 2. Stack

- `socket.io` mounted on the same `http.Server` as Express, path `/ws`, `serveClient: false`, `pingInterval = WS_HEARTBEAT_SEC`.
- `@socket.io/redis-adapter` with the shared Redis connection (publisher) and a `duplicate()` (subscriber — an ioredis connection in subscribe mode can't run other commands).
- The `io` instance is registered in DI as `TOKENS.WsServer` by `server.ts`.

Why socket.io and not raw `ws` or SSE: rooms + the Redis adapter give cross-instance fan-out without a hand-written pub/sub layer, acks for `subscribe`, automatic reconnect on the client, and bidirectional messages (subscribe/unsubscribe). Clients use `transports: ["websocket"]`, so no long-polling.

## 3. Handshake & authorization (`ws-auth.ts`)

1. Token from `handshake.auth.token` (mobile/native) or the `access_token` cookie (browsers). Query-string tokens are rejected (they leak into logs).
2. `verifyAccessToken` (same secret as core). Failure → `connect_error` `Not Authenticated`.
3. Permitted rooms are computed once and stored in `socket.data.allowed`:

| Role | Rooms |
|---|---|
| `customer` | `customer:<userId>` |
| `restaurant_user` | `restaurant:<restaurantId>` + `branch:<id>` for each id in `branchIds` |
| `delivery_agent` | `agent:<userId>` |
| `admin` | none in this milestone (admin dashboards use REST; an `admin:<region>` room can be added later) |

4. On connect the server emits `hello { allowedChannels }`. The client then `subscribe`s; a room outside the allowed set gets ack `{ ok: false, error: "not permitted" }` and the connection stays open.

JWT expiry: the socket keeps its rooms until it disconnects; clients reconnect with a fresh token after a refresh.

## 4. Publishing (Phase 6)

```ts
// in a service, AFTER trx.commit()
const io = container.resolve<Server>(TOKENS.WsServer);
io.to(`customer:${order.customerId}`).to(`branch:${order.branchId}`)
  .emit("order.status_changed", { orderPublicId: order.publicId, status: order.status, updatedAt });
```

Rules:

- Emit **after commit** only — never announce something that may roll back.
- Payloads are response DTOs or documented subsets; never entities.
- An emit failure is logged and swallowed — it must not fail the request (the state is already committed; clients can re-fetch).

## 5. Event catalogue

| Event | Channels | Payload | Producer |
|---|---|---|---|
| `order.created` | `branch:<id>`, `restaurant:<id>` | `OrderSummaryResponseDTO` | Orders (COD), Payments (capture) |
| `order.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderPublicId, status, updatedAt }` | Orders, Deliveries |
| `order.cancelled` | `customer:<id>`, `branch:<id>`, `restaurant:<id>` | `{ orderPublicId, reason, updatedAt }` | Orders, payment sweep |
| `payment.captured` | `customer:<id>` | `{ orderPublicId, amount, currency }` | Payments |
| `payment.failed` | `customer:<id>` | `{ orderPublicId, reason }` | Payments |
| `delivery.status_changed` | `customer:<id>`, `branch:<id>` | `{ orderPublicId, status, updatedAt, agent }` | Deliveries |
| `delivery.position` | `customer:<id>` | `{ deliveryId, lat, lng, ts }` | Agents (ping while `picked`) |
| `task.assigned` | `agent:<id>` | `DeliveryTaskResponseDTO` | Deliveries |
| `task.cancelled` | `agent:<id>` | `{ deliveryId, reason }` | Deliveries, Orders |

## 6. Delivery guarantees

At-most-once, best effort. Events are notifications, not the source of truth: after a reconnect the client re-fetches the order/task via REST.

## 7. Scale notes

- Fan-out goes through Redis pub/sub; no sticky sessions needed with websocket-only transport.
- Redis down → emits are local-instance only until it recovers; sockets stay open.
- Rooms are per user/branch/agent, so one emit reaches only the few sockets that care.
