import type {Knex} from "knex";
import {Order} from "../entity/order.entity.js";
import {OrderStatus} from "../enums.js";
import type {DateRange, GeoBox, InsertOrderInput, OrderListFilter, OrderPage, OrderRef} from "../types.js";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

const ORDER_COLUMNS = [
    "id", "region", "public_id", "country_code", "restaurant_id", "branch_id", "customer_id", "customer_address_id",
    "delivery_lat", "delivery_lng", "delivery_address_text_snapshot", "status", "cancel_reason",
    "subtotal", "delivery_fee", "service_fee", "total", "commission", "currency", "payment_method",
    "delivery_agent_id", "pickup_lat", "pickup_lng", "created_at", "updated_at", "accepted_at", "rejected_at", "ready_at",
    "assigned_at", "picked_at", "delivered_at", "cancelled_at"
];

// transition timestamp written with each target status (preparing / placed have none)
const STATUS_TIMESTAMP_COLUMN: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.ACCEPTED]: "accepted_at",
    [OrderStatus.REJECTED]: "rejected_at",
    [OrderStatus.READY]: "ready_at",
    [OrderStatus.ASSIGNED]: "assigned_at",
    [OrderStatus.PICKED]: "picked_at",
    [OrderStatus.DELIVERED]: "delivered_at",
    [OrderStatus.CANCELLED]: "cancelled_at",
};

function toEntity(row: any): Order {
    return new Order({
        id: Number(row.id),
        region: row.region,
        publicId: row.public_id,
        countryCode: row.country_code,
        restaurantId: Number(row.restaurant_id),
        branchId: Number(row.branch_id),
        customerId: Number(row.customer_id),
        customerAddressId: Number(row.customer_address_id),
        deliveryLat: Number(row.delivery_lat),
        deliveryLng: Number(row.delivery_lng),
        deliveryAddressText: row.delivery_address_text_snapshot,
        status: row.status,
        cancelReason: row.cancel_reason,
        subtotal: row.subtotal,
        deliveryFee: row.delivery_fee,
        serviceFee: row.service_fee,
        total: row.total,
        commission: row.commission,
        currency: row.currency,
        paymentMethod: row.payment_method,
        deliveryAgentId: row.delivery_agent_id === null ? null : Number(row.delivery_agent_id),
        pickupLat: row.pickup_lat === null ? null : Number(row.pickup_lat),
        pickupLng: row.pickup_lng === null ? null : Number(row.pickup_lng),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        readyAt: row.ready_at,
        assignedAt: row.assigned_at,
        pickedAt: row.picked_at,
        deliveredAt: row.delivered_at,
        cancelledAt: row.cancelled_at,
    });
}

// created_at of an order = the timestamp inside its UUIDv7 public id (see create_orders_table)
function createdAtOf(publicId: string, conn: Knex): Knex.Raw {
    return conn.raw("(uuid_extract_timestamp(?::uuid) AT TIME ZONE 'UTC')", [publicId]);
}

export async function insertOrder(data: InsertOrderInput, conn: Knex): Promise<Order> {
    const [row] = await conn("orders")
        .insert({
            region: data.region,
            public_id: data.publicId,
            country_code: data.countryCode,
            restaurant_id: data.restaurantId,
            branch_id: data.branchId,
            customer_id: data.customerId,
            customer_address_id: data.customerAddressId,
            delivery_lat: data.deliveryLat,
            delivery_lng: data.deliveryLng,
            delivery_address_text_snapshot: data.deliveryAddressText,
            pickup_lat: data.pickupLat,
            pickup_lng: data.pickupLng,
            status: data.status,
            subtotal: data.subtotal,
            delivery_fee: data.deliveryFee,
            service_fee: data.serviceFee,
            total: data.total,
            currency: data.currency,
            payment_method: data.paymentMethod,
            created_at: createdAtOf(data.publicId, conn),
        })
        .returning(ORDER_COLUMNS);
    return toEntity(row);
}

// Q-O1 — one partition: created_at is derived from the public id
export async function findOrderByPublicId(publicId: string, conn: Knex): Promise<Order | null> {
    const [row] = await conn("orders")
        .select(ORDER_COLUMNS)
        .where("public_id", publicId)
        .andWhere("created_at", createdAtOf(publicId, conn));
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-O10 — PK (id, created_at): the order a ledger / session row points to
// forUpdate: the refund webhook locks the order FIRST (same lock order as settlement, no deadlock)
export async function findOrderByRef(ref: OrderRef, conn: Knex, forUpdate = false): Promise<Order | null> {
    const query = conn("orders")
        .select(ORDER_COLUMNS)
        .where("id", ref.id)
        .andWhere("created_at", toUtcTimestamp(ref.createdAt));
    if(forUpdate) query.forUpdate();
    const [row] = await query;
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-O4 — payment sweep: unpaid online orders older than the session timeout, locked, safe with N instances
export async function lockExpiredPendingPaymentOrders(timeoutMin: number, limit: number, conn: Knex): Promise<Order[]> {
    const rows = await conn("orders")
        .select(ORDER_COLUMNS)
        .where("status", OrderStatus.PENDING_PAYMENT)
        .andWhere("created_at", "<", conn.raw("NOW() - make_interval(mins => ?)", [timeoutMin]))
        .orderBy("created_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();
    return rows.map(toEntity);
}

// Q-O8 (batch) — one conditional UPDATE for many orders; returns the rows that actually moved
export async function updateOrdersStatus(
    refs: OrderRef[],
    fromStatuses: OrderStatus[],
    toStatus: OrderStatus,
    cancelReason: string | null,
    conn: Knex
): Promise<Order[]> {
    if(refs.length === 0){
        return [];
    }
    const changes: Record<string, unknown> = {status: toStatus, updated_at: conn.fn.now()};
    const timestampColumn = STATUS_TIMESTAMP_COLUMN[toStatus];
    if(timestampColumn){
        changes[timestampColumn] = conn.fn.now();
    }
    if(cancelReason !== null){
        changes.cancel_reason = cancelReason;
    }
    const rows = await conn("orders")
        .update(changes)
        .whereIn(["id", "created_at"], refs.map((ref) => [ref.id, toUtcTimestamp(ref.createdAt)]))
        .whereIn("status", fromStatuses)
        .returning(ORDER_COLUMNS);
    return rows.map(toEntity);
}

function applyListFilter(query: Knex.QueryBuilder, filter: OrderListFilter, range: DateRange, page: OrderPage) {
    if(filter.customerId !== undefined) query.where("customer_id", filter.customerId);
    if(filter.branchId !== undefined) query.where("branch_id", filter.branchId);
    if(filter.restaurantId !== undefined) query.where("restaurant_id", filter.restaurantId);
    if(filter.status !== undefined) query.where("status", filter.status);
    if(filter.deliveryAgentId !== undefined) query.where("delivery_agent_id", filter.deliveryAgentId);

    // the range bounds prune partitions and bound the index range scan
    query.where("created_at", ">=", toUtcTimestamp(range.from)).andWhere("created_at", "<", toUtcTimestamp(range.to));

    if(page.cursor){
        const createdAt = toUtcTimestamp(page.cursor.createdAt);
        query.where("created_at", "<=", createdAt)
            .whereRaw("(created_at, public_id) < (?, ?::uuid)", [createdAt, page.cursor.publicId]);
    }
    return query.orderBy([{column: "created_at", order: "desc"}, {column: "public_id", order: "desc"}])
        .limit(page.limit + 1);
}

// Q-O2 (customerId) · Q-O3 (branchId [+ status]) · Q-O9 (admin, neither)
// returns up to limit + 1 rows so the caller can tell whether there is a next page
export async function listOrders(filter: OrderListFilter, range: DateRange, page: OrderPage, conn: Knex): Promise<Order[]> {
    const rows = await applyListFilter(conn("orders").select(ORDER_COLUMNS), filter, range, page);
    return rows.map(toEntity);
}

// Q-O8 — conditional transition: 0 rows (someone else moved it) -> null
export async function updateOrderStatus(
    ref: OrderRef,
    fromStatuses: OrderStatus[],
    toStatus: OrderStatus,
    cancelReason: string | null,
    conn: Knex
): Promise<Order | null> {
    const changes: Record<string, unknown> = {
        status: toStatus,
        updated_at: conn.fn.now(),
    };
    const timestampColumn = STATUS_TIMESTAMP_COLUMN[toStatus];
    if(timestampColumn){
        changes[timestampColumn] = conn.fn.now();
    }
    if(cancelReason !== null){
        changes.cancel_reason = cancelReason;
    }

    const [row] = await conn("orders")
        .update(changes)
        .where("id", ref.id)
        .andWhere("created_at", toUtcTimestamp(ref.createdAt))
        .whereIn("status", fromStatuses)
        .returning(ORDER_COLUMNS);
    if(!row){
        return null;
    }
    return toEntity(row);
}

// ------------------------------------------------------------------ deliveries (Phase 3)

// an order can't stay assigned/picked for weeks: bounding the partitions keeps busy checks to recent months
const ACTIVE_DELIVERY_WINDOW = "NOW() - interval '30 days'";

// Q-O5 — the offer worker: ready orders without an agent / assigned orders, oldest first
export async function listOrdersForDispatch(status: OrderStatus.READY | OrderStatus.ASSIGNED, limit: number, conn: Knex): Promise<Order[]> {
    const query = conn("orders").select(ORDER_COLUMNS).where("status", status);
    if(status === OrderStatus.READY) query.whereNull("delivery_agent_id");
    const rows = await query.orderBy("created_at", "asc").limit(limit);
    return rows.map(toEntity);
}

// Q-O5 + pickup box — ready orders an agent can see (bounding box; the service checks the exact distance)
export async function listReadyOrdersInBox(box: GeoBox, limit: number, conn: Knex): Promise<Order[]> {
    const rows = await conn("orders")
        .select(ORDER_COLUMNS)
        .where("status", OrderStatus.READY)
        .whereNull("delivery_agent_id")
        .whereBetween("pickup_lat", [box.minLat, box.maxLat])
        .whereBetween("pickup_lng", [box.minLng, box.maxLng])
        .orderBy("created_at", "asc")
        .limit(limit);
    return rows.map(toEntity);
}

// Q-O6 — orders some agents are holding (assigned / picked): busy check for many agents in one query
export async function findActiveOrdersByAgents(agentIds: number[], conn: Knex): Promise<Order[]> {
    if(agentIds.length === 0){
        return [];
    }
    const rows = await conn("orders")
        .select(ORDER_COLUMNS)
        .whereIn("delivery_agent_id", agentIds)
        .whereIn("status", [OrderStatus.ASSIGNED, OrderStatus.PICKED])
        .andWhere("created_at", ">", conn.raw(ACTIVE_DELIVERY_WINDOW));
    return rows.map(toEntity);
}

// PK tuples — the orders behind some ledger / earnings rows, one query
export async function findOrdersByRefs(refs: OrderRef[], conn: Knex): Promise<Order[]> {
    if(refs.length === 0){
        return [];
    }
    const rows = await conn("orders")
        .select(ORDER_COLUMNS)
        .whereIn(["id", "created_at"], refs.map((ref) => [ref.id, toUtcTimestamp(ref.createdAt)]));
    return rows.map(toEntity);
}

// Q-O8 — an agent takes a ready order: only if nobody else did (one winner)
export async function assignOrderToAgent(ref: OrderRef, agentId: number, conn: Knex): Promise<Order | null> {
    const [row] = await conn("orders")
        .update({status: OrderStatus.ASSIGNED, delivery_agent_id: agentId, assigned_at: conn.fn.now(), updated_at: conn.fn.now()})
        .where("id", ref.id)
        .andWhere("created_at", toUtcTimestamp(ref.createdAt))
        .andWhere("status", OrderStatus.READY)
        .whereNull("delivery_agent_id")
        .returning(ORDER_COLUMNS);
    return row ? toEntity(row) : null;
}

// Q-O8 — the agent gives the order back (release / stale / offline): only if it's still theirs
export async function releaseOrderFromAgent(ref: OrderRef, agentId: number, conn: Knex): Promise<Order | null> {
    const [row] = await conn("orders")
        .update({status: OrderStatus.READY, delivery_agent_id: null, assigned_at: null, updated_at: conn.fn.now()})
        .where("id", ref.id)
        .andWhere("created_at", toUtcTimestamp(ref.createdAt))
        .andWhere("status", OrderStatus.ASSIGNED)
        .andWhere("delivery_agent_id", agentId)
        .returning(ORDER_COLUMNS);
    return row ? toEntity(row) : null;
}

// Q-O8 — picked / delivered by the order's own agent (commission is written with delivered)
export async function updateOrderStatusByAgent(
    ref: OrderRef,
    agentId: number,
    from: OrderStatus,
    to: OrderStatus.PICKED | OrderStatus.DELIVERED,
    commission: number | null,
    conn: Knex
): Promise<Order | null> {
    const changes: Record<string, unknown> = {status: to, [STATUS_TIMESTAMP_COLUMN[to]!]: conn.fn.now(), updated_at: conn.fn.now()};
    if(commission !== null) changes.commission = commission;
    const [row] = await conn("orders")
        .update(changes)
        .where("id", ref.id)
        .andWhere("created_at", toUtcTimestamp(ref.createdAt))
        .andWhere("status", from)
        .andWhere("delivery_agent_id", agentId)
        .returning(ORDER_COLUMNS);
    return row ? toEntity(row) : null;
}

// Q-O8 (batch) — give many assigned orders back at once (worker: agents went silent). Each row only
// if it is still assigned to the agent we saw. ONE statement; returns the rows that moved.
export async function releaseOrdersFromAgents(refs: (OrderRef & {agentId: number})[], conn: Knex): Promise<Order[]> {
    if(refs.length === 0){
        return [];
    }
    const rows = await conn("orders")
        .update({status: OrderStatus.READY, delivery_agent_id: null, assigned_at: null, updated_at: conn.fn.now()})
        .whereIn(["id", "created_at", "delivery_agent_id"], refs.map((ref) => [ref.id, toUtcTimestamp(ref.createdAt), ref.agentId]))
        .andWhere("status", OrderStatus.ASSIGNED)
        .returning(ORDER_COLUMNS);
    return rows.map(toEntity);
}
