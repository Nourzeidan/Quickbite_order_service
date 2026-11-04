import {inject, injectable} from "tsyringe";
import {TOKENS} from "../di/tokens.js";
import type {CoreClient} from "./core-client.js";
import type {CoreAddress} from "./types.js";
import {isNotFound} from "./read-through.js";

// not cached: per-customer data, read once per checkout
@injectable()
export class AddressClient {
    constructor(@inject(TOKENS.CoreClient) private readonly coreClient: CoreClient){}

    // null = not found OR not this customer's address (core answers 404 for both)
    getAddress = async (userId: number, addressId: number, correlationId: string): Promise<CoreAddress | null> => {
        try{
            return await this.coreClient.request<CoreAddress>({
                method: "GET",
                path: `/api/internal/customers/${userId}/addresses/${addressId}`,
                correlationId,
            });
        }catch(err){
            if(isNotFound(err)) return null;
            throw err;
        }
    }
}
