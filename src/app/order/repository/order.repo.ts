import type {Knex} from "knex";
import {Order} from "../entity/order.entity.js";
import {OrderStatus} from "../enums.js";
import type {DateRange, InsertOrderInput, OrderListFilter, OrderPage, OrderRef} from "../types.js";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

const ORDER_COLUMNS = [
    "id", "region", "public_id", "country_code", "restaurant_id", "branch_id", "customer_id", "customer_address_id",
    "delivery_lat", "delivery_lng", "delivery_address_text_snapshot", "status", "cancel_reason",
    "subtotal", "delivery_fee", "service_fee", "total", "commission", "currency", "payment_method",
    "delivery_agent_id", "created_at", "updated_at", "accepted_at", "rejected_at", "ready_at",
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

function applyListFilter(query: Knex.QueryBuilder, filter: OrderListFilter, range: DateRange, page: OrderPage) {
    if(filter.customerId !== undefined) query.where("customer_id", filter.customerId);
    if(filter.branchId !== undefined) query.where("branch_id", filter.branchId);
    if(filter.restaurantId !== undefined) query.where("restaurant_id", filter.restaurantId);
    if(filter.status !== undefined) query.where("status", filter.status);

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
