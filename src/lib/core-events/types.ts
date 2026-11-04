export type CoreEventHandler = (payload: unknown) => Promise<void>;

export interface CoreEventEnvelope {
    eventId: string;            // stable across redeliveries (core outbox row id)
    eventType: string;          // = routing key, e.g. "product.stock.changed"
    occurredAt: string;
    payload: unknown;
}
