import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {CoreClient} from "./core-client.js";
import type {CoreStockItem} from "./types.js";

export type ReserveStockResult = "reserved" | "out_of_stock";

// both calls are idempotent on core by orderPublicId, so they always carry an Idempotency-Key (= retryable)
@injectable()
export class StockClient {
    constructor(@inject(TOKENS.CoreClient) private readonly coreClient: CoreClient){}

    // all-or-nothing on core. 409 -> "out_of_stock"; 5xx / timeout after retries -> throws 503
    reserveStock = async (branchId: number, orderPublicId: string, items: CoreStockItem[], correlationId: string): Promise<ReserveStockResult> => {
        try{
            await this.coreClient.request<void>({
                method: "POST",
                path: `/api/internal/branches/${branchId}/stock/reserve`,
                body: {orderPublicId, items},
                correlationId,
                idempotencyKey: `reserve:${orderPublicId}`,
            });
            return "reserved";
        }catch(err){
            if((err as {statusCode?: number}).statusCode === 409){
                return "out_of_stock";
            }
            throw err;
        }
    }

    // restocks what the order reserved; a repeat (or an order that never reserved) is a no-op on core
    releaseStock = async (branchId: number, orderPublicId: string, correlationId: string): Promise<void> => {
        await this.releaseStockBatch([{branchId, orderPublicId}], correlationId);
    }

    // many orders (the payment sweep cancels up to 100 at once): ONE core call per 100 orders,
    // ONE transaction on core. Idempotent there (released reservations are skipped) -> retryable.
    releaseStockBatch = async (orders: {branchId: number; orderPublicId: string}[], correlationId: string): Promise<void> => {
        for(let i = 0; i < orders.length; i += 100){
            const batch = orders.slice(i, i + 100);
            await this.coreClient.request<void>({
                method: "POST",
                path: "/api/internal/stock/release",
                body: {orders: batch},
                correlationId,
                idempotencyKey: `release:${batch.map((order) => order.orderPublicId).join(",")}`,
            });
        }
    }
}
