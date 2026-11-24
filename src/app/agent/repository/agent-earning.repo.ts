import type {Knex} from "knex";
import {toUtcTimestamp} from "../../../pkg/utils/time.js";

export interface AgentEarning {
    id: number;
    agentId: number;
    orderId: number;
    orderCreatedAt: Date;
    amount: number;
    currency: string;
    earnedAt: Date;
}

export interface InsertAgentEarningInput {
    region: string;
    agentId: number;
    orderId: number;
    orderCreatedAt: Date;
    amount: number;
    currency: string;
}

const AGENT_EARNING_COLUMNS = ["id", "agent_id", "order_id", "order_created_at", "amount", "currency", "earned_at"];

function toRecord(row: any): AgentEarning {
    return {
        id: Number(row.id),
        agentId: Number(row.agent_id),
        orderId: Number(row.order_id),
        orderCreatedAt: row.order_created_at,
        amount: row.amount,
        currency: row.currency,
        earnedAt: row.earned_at,
    };
}

// a second insert for the same order fails on uq_agent_earnings_order_id (settlement can't pay twice)
export async function insertAgentEarning(data: InsertAgentEarningInput, conn: Knex): Promise<AgentEarning> {
    const [row] = await conn("agent_earnings")
        .insert({
            region: data.region,
            agent_id: data.agentId,
            order_id: data.orderId,
            order_created_at: toUtcTimestamp(data.orderCreatedAt),
            amount: data.amount,
            currency: data.currency,
        })
        .returning(AGENT_EARNING_COLUMNS);
    return toRecord(row);
}

// Q-A3 — one page, newest first, keyset on (earned_at, id)
export async function listAgentEarnings(
    agentId: number,
    range: {from: Date; to: Date},
    cursor: {earnedAt: Date; id: number} | null,
    limit: number,
    conn: Knex
): Promise<AgentEarning[]> {
    const query = conn("agent_earnings")
        .select(AGENT_EARNING_COLUMNS)
        .where("agent_id", agentId)
        .andWhere("earned_at", ">=", toUtcTimestamp(range.from))
        .andWhere("earned_at", "<", toUtcTimestamp(range.to));
    if(cursor){
        query.whereRaw("(earned_at, id) < (?, ?)", [toUtcTimestamp(cursor.earnedAt), cursor.id]);
    }
    const rows = await query.orderBy([{column: "earned_at", order: "desc"}, {column: "id", order: "desc"}]).limit(limit + 1);
    return rows.map(toRecord);
}

// Q-A3 — totals for the same range, one aggregate per currency
export async function sumAgentEarnings(agentId: number, range: {from: Date; to: Date}, conn: Knex): Promise<{currency: string; count: number; sum: number}[]> {
    const rows = await conn("agent_earnings")
        .select("currency")
        .count({count: "*"})
        .sum({sum: "amount"})
        .where("agent_id", agentId)
        .andWhere("earned_at", ">=", toUtcTimestamp(range.from))
        .andWhere("earned_at", "<", toUtcTimestamp(range.to))
        .groupBy("currency");
    return (rows as {currency: string; count: string; sum: string}[]).map((row) => ({
        currency: row.currency, count: Number(row.count), sum: Number(row.sum),
    }));
}
