import type {Knex} from "knex";
import type {InsertWebhookEventInput} from "../types.js";

// Q-P7 — dedupe insert. null = already processed (duplicate delivery -> 200).
// A row that exists but never finished (processing threw, we answered 500) is handed back so the
// provider's retry processes it again; processing is idempotent (conditional updates, unique keys).
export async function insertWebhookEventIfNew(data: InsertWebhookEventInput, conn: Knex): Promise<number | null> {
    const result = await conn.raw(`
        INSERT INTO payment_webhook_events (region, provider_id, provider_event_id, signature, payload)
        VALUES (?, ?, ?, ?, ?::jsonb)
        ON CONFLICT (provider_id, provider_event_id) DO UPDATE SET received_at = NOW()
            WHERE payment_webhook_events.processed_at IS NULL
        RETURNING id
    `, [data.region, data.providerId, data.providerEventId, data.signature, JSON.stringify(data.payload)]);
    const row = result.rows[0];
    return row ? Number(row.id) : null;
}

// PK — done (a non-null note = handled without a state change, e.g. amount mismatch; not retried)
export async function markWebhookEventProcessed(id: number, note: string | null, conn: Knex): Promise<void> {
    await conn("payment_webhook_events")
        .update({processed_at: conn.fn.now(), process_error: note})
        .where("id", id);
}

// PK — processing threw; processed_at stays NULL so the provider's retry runs it again
export async function markWebhookEventFailed(id: number, processError: string, conn: Knex): Promise<void> {
    await conn("payment_webhook_events")
        .update({process_error: processError})
        .where("id", id);
}
