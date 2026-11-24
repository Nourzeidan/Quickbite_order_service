import {injectable} from "tsyringe";
import type {Knex} from "knex";
import {insertAgentEarning, listAgentEarnings, sumAgentEarnings, type AgentEarning} from "../repository/agent-earning.repo.js";

// agent_earnings: written by the delivery settlement (inside its trx), read by GET /agents/earnings
@injectable()
export class AgentEarningService {
    record = (data: {region: string; agentId: number; order: {id: number; createdAt: Date; currency: string}; amount: number}, trx: Knex): Promise<AgentEarning> =>
        insertAgentEarning({
            region: data.region,
            agentId: data.agentId,
            orderId: data.order.id,
            orderCreatedAt: data.order.createdAt,
            amount: data.amount,
            currency: data.order.currency,
        }, trx)

    page = (agentId: number, range: {from: Date; to: Date}, cursor: {earnedAt: Date; id: number} | null, limit: number, conn: Knex) =>
        listAgentEarnings(agentId, range, cursor, limit, conn)

    totals = (agentId: number, range: {from: Date; to: Date}, conn: Knex) => sumAgentEarnings(agentId, range, conn)
}
