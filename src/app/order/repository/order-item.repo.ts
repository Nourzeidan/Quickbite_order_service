import type {Knex} from "knex";
import {OrderItem} from "../entity/order-item.entity.js";
import type {InsertOrderItemInput, OrderRef} from "../types.js";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

const ORDER_ITEM_COLUMNS = [
    "id", "region", "order_id", "product_id", "quantity", "unit_price_snapshot",
    "name_snapshot", "image_url_snapshot", "line_total", "created_at"
];

function toEntity(row: any): OrderItem {
    return new OrderItem({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        productId: Number(row.product_id),
        quantity: row.quantity,
        unitPrice: row.unit_price_snapshot,
        name: row.name_snapshot,
        imageUrl: row.image_url_snapshot,
        lineTotal: row.line_total,
        createdAt: row.created_at,
    });
}

// order_created_at BETWEEN the oldest and newest parent -> only those months' partitions are read
function whereOrders(query: Knex.QueryBuilder, orders: OrderRef[]) {
    const times = orders.map((order) => order.createdAt.getTime());
    return query
        .whereIn("order_id", orders.map((order) => order.id))
        .andWhere("order_created_at", ">=", toUtcTimestamp(new Date(Math.min(...times))))
        .andWhere("order_created_at", "<=", toUtcTimestamp(new Date(Math.max(...times))));
}

// one multi-row INSERT
export async function insertOrderItems(items: InsertOrderItemInput[], conn: Knex): Promise<OrderItem[]> {
    const rows = await conn("order_items")
        .insert(items.map((item) => ({
            region: item.region,
            order_id: item.orderId,
            order_created_at: toUtcTimestamp(item.orderCreatedAt),
            product_id: item.productId,
            quantity: item.quantity,
            unit_price_snapshot: item.unitPrice,
            name_snapshot: item.name,
            image_url_snapshot: item.imageUrl,
            line_total: item.lineTotal,
        })))
        .returning(ORDER_ITEM_COLUMNS);
    return rows.map(toEntity);
}

// Q-O7
export async function findItemsByOrders(orders: OrderRef[], conn: Knex): Promise<OrderItem[]> {
    if(orders.length === 0){
        return [];
    }
    const rows = await whereOrders(conn("order_items").select(ORDER_ITEM_COLUMNS), orders).orderBy("id", "asc");
    return rows.map(toEntity);
}

// Q-O7 (grouped) — line count per order for list screens
export async function countItemsByOrders(orders: OrderRef[], conn: Knex): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if(orders.length === 0){
        return counts;
    }
    const rows = await whereOrders(conn("order_items").select("order_id").count({count: "*"}), orders).groupBy("order_id");
    for(const row of rows as {order_id: string; count: string}[]){
        counts.set(Number(row.order_id), Number(row.count));
    }
    return counts;
}
