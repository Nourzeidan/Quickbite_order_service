import type {Knex} from "knex";
import {PaymentSession} from "../entity/payment-session.entity.js";
import {OPEN_SESSION_STATUSES, PaymentSessionStatus} from "../enums.js";
import type {InsertPaymentSessionInput} from "../types.js";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

const PAYMENT_SESSION_COLUMNS = [
    "id", "region", "order_id", "order_created_at", "provider_id", "provider_session_id", "merchant_order_ref",
    "redirect_url", "amount", "currency", "status", "expires_at", "created_at", "updated_at"
];

interface OrderKey {
    id: number;
    createdAt: Date;
}

function toEntity(row: any): PaymentSession {
    return new PaymentSession({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        providerId: row.provider_id,
        providerSessionId: row.provider_session_id,
        merchantOrderRef: row.merchant_order_ref,
        redirectUrl: row.redirect_url,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function insertPaymentSession(data: InsertPaymentSessionInput, conn: Knex): Promise<PaymentSession> {
    const [row] = await conn("payment_sessions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_created_at: toUtcTimestamp(data.orderCreatedAt),
            provider_id: data.providerId,
            provider_session_id: data.providerSessionId,
            merchant_order_ref: data.merchantOrderRef,
            redirect_url: data.redirectUrl,
            amount: data.amount,
            currency: data.currency,
            status: data.status,
            expires_at: toUtcTimestamp(data.expiresAt),
            raw_init_payload: JSON.stringify(data.rawInitPayload),
        })
        .returning(PAYMENT_SESSION_COLUMNS);
    return toEntity(row);
}

// Q-P2 — every session of one order, newest first (a handful of rows at most)
export async function findSessionsByOrder(order: OrderKey, conn: Knex): Promise<PaymentSession[]> {
    const rows = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .where("order_id", order.id)
        .andWhere("order_created_at", toUtcTimestamp(order.createdAt))
        .orderBy("id", "desc");
    return rows.map(toEntity);
}

// Q-P2 — the session a webhook belongs to: matched by our merchant reference (uq_payment_sessions_merchant_order_ref)
export async function findSessionByMerchantOrderRef(merchantOrderRef: string, conn: Knex, forUpdate = false): Promise<PaymentSession | null> {
    const query = conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .where("merchant_order_ref", merchantOrderRef);
    if(forUpdate) query.forUpdate();
    const [row] = await query;
    if(!row){
        return null;
    }
    return toEntity(row);
}

// PK — conditional: only from the given statuses; 0 rows -> null
export async function updateSessionStatus(
    id: number,
    fromStatuses: PaymentSessionStatus[],
    toStatus: PaymentSessionStatus,
    rawLastPayload: unknown,
    conn: Knex
): Promise<PaymentSession | null> {
    const changes: Record<string, unknown> = {status: toStatus, updated_at: conn.fn.now()};
    if(rawLastPayload !== undefined){
        changes.raw_last_payload = JSON.stringify(rawLastPayload);
    }
    const [row] = await conn("payment_sessions")
        .update(changes)
        .where("id", id)
        .whereIn("status", fromStatuses)
        .returning(PAYMENT_SESSION_COLUMNS);
    if(!row){
        return null;
    }
    return toEntity(row);
}

// Q-P2 — one statement for a batch of orders (sweep: expired; cancel: cancelled)
export async function closeOpenSessionsByOrders(orders: OrderKey[], toStatus: PaymentSessionStatus, conn: Knex): Promise<number> {
    if(orders.length === 0){
        return 0;
    }
    const pairs = orders.map(() => "(?::bigint, ?::timestamp)").join(", ");
    const bindings = orders.flatMap((order) => [order.id, toUtcTimestamp(order.createdAt)]);
    const result = await conn.raw(`
        UPDATE payment_sessions SET status = ?, updated_at = NOW()
        WHERE (order_id, order_created_at) IN (${pairs})
          AND status = ANY(?)
    `, [toStatus, ...bindings, OPEN_SESSION_STATUSES]);
    return result.rowCount ?? 0;
}
