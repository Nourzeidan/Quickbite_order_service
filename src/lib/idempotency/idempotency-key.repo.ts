import type {Knex} from "knex";

export const PG_UNIQUE_VIOLATION = "23505";

const IDEMPOTENCY_KEY_COLUMNS = ["key_hash", "user_id", "request_fingerprint", "response_status", "response_body", "expires_at"];

export interface IdempotencyRecord {
    keyHash: Buffer;
    userId: number;
    fingerprint: Buffer;
    responseStatus: number;
    responseBody: unknown;
    expiresAt: Date;
}

export interface InsertIdempotencyKeyInput {
    keyHash: Buffer;
    region: string;
    userId: number;
    fingerprint: Buffer;
    responseStatus: number;
    responseBody: unknown;
    ttlSec: number;
}

function toRecord(row: any): IdempotencyRecord {
    return {
        keyHash: row.key_hash,
        userId: Number(row.user_id),
        fingerprint: row.request_fingerprint,
        responseStatus: row.response_status,
        responseBody: row.response_body,
        expiresAt: row.expires_at,
    };
}

// Q-I1 — expired rows count as absent (cleanup may not have run yet)
export async function findIdempotencyKeyByHash(keyHash: Buffer, conn: Knex): Promise<IdempotencyRecord | null> {
    const [row] = await conn("idempotency_keys")
        .select(IDEMPOTENCY_KEY_COLUMNS)
        .where("key_hash", keyHash)
        .andWhere("expires_at", ">", conn.fn.now());
    if(!row){
        return null;
    }
    return toRecord(row);
}

// a concurrent insert of the same key fails with 23505 (PK) and rolls the caller's trx back.
// an EXPIRED row with the same hash is replaced instead.
export async function insertIdempotencyKey(data: InsertIdempotencyKeyInput, conn: Knex): Promise<void> {
    const result = await conn.raw(`
        INSERT INTO idempotency_keys (key_hash, region, user_id, request_fingerprint, response_status, response_body, expires_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, NOW() + make_interval(secs => ?))
        ON CONFLICT (key_hash) DO UPDATE SET
            region = EXCLUDED.region,
            user_id = EXCLUDED.user_id,
            request_fingerprint = EXCLUDED.request_fingerprint,
            response_status = EXCLUDED.response_status,
            response_body = EXCLUDED.response_body,
            created_at = NOW(),
            expires_at = EXCLUDED.expires_at
        WHERE idempotency_keys.expires_at <= NOW()
    `, [data.keyHash, data.region, data.userId, data.fingerprint, data.responseStatus, JSON.stringify(data.responseBody), data.ttlSec]);
    if(result.rowCount === 0){
        // a live row for this key already exists: same outcome as a PK violation
        throw Object.assign(new Error("duplicate idempotency key"), {code: PG_UNIQUE_VIOLATION});
    }
}

// Q-I1 (PK) — the stored response changes when a committed order is voided afterwards
export async function updateIdempotencyKeyResponse(keyHash: Buffer, responseStatus: number, responseBody: unknown, conn: Knex): Promise<void> {
    await conn("idempotency_keys")
        .update({response_status: responseStatus, response_body: JSON.stringify(responseBody)})
        .where("key_hash", keyHash);
}

// Q-I1 (PK) — forget a key whose request failed with a retryable error
export async function deleteIdempotencyKeyByHash(keyHash: Buffer, conn: Knex): Promise<void> {
    await conn("idempotency_keys").where("key_hash", keyHash).delete();
}

// Q-I2 — one batch; the caller loops until it returns < batchSize
export async function deleteExpiredIdempotencyKeys(batchSize: number, conn: Knex): Promise<number> {
    const result = await conn.raw(`
        DELETE FROM idempotency_keys
        WHERE key_hash IN (
            SELECT key_hash FROM idempotency_keys WHERE expires_at < NOW() LIMIT ?
        )
    `, [batchSize]);
    return result.rowCount ?? 0;
}
