// The first 48 bits of a UUIDv7 are its creation time in Unix milliseconds — the same value Postgres'
// uuid_extract_timestamp() reads. Order public ids are UUIDv7 and orders.created_at is derived from
// them, so the year of an order is known from its id before any query.
export function timeOfUuidV7(id: string): Date {
    const hex = id.replace(/-/g, "").slice(0, 12);
    return new Date(Number.parseInt(hex, 16));
}
