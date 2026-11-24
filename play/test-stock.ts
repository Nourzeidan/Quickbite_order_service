// Test-data helper: every test order reserves stock on core and delivered orders keep it, so repeated
// runs drain the product. Before a suite places orders, top the product back up through core's normal
// owner API (PATCH /api/products/:id?branchId=), signed as the restaurant's owner.
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env.js";
import {coreClient} from "../src/lib/core-client/core-client.js";
import type {CoreBranchProduct, CoreRestaurant} from "../src/lib/core-client/types.js";

export async function ensureStock(branchId: number, restaurantId: number, productId: number, min = 50, topUpTo = 500): Promise<void> {
    const [product] = await coreClient.request<CoreBranchProduct[]>({
        method: "POST", path: `/api/internal/branches/${branchId}/products/batch`, body: {productIds: [productId]},
        correlationId: "test-stock", idempotencyKey: `test-stock:${Date.now()}`,
    });
    if(product && product.stock >= min){
        return;
    }
    const restaurant = await coreClient.request<CoreRestaurant>({method: "GET", path: `/api/internal/restaurants/${restaurantId}`, correlationId: "test-stock"});
    const ownerToken = jwt.sign(
        {userId: restaurant.ownerId, role: "restaurant_user", restaurantId, restaurantRole: "owner", branchIds: [branchId]},
        env.jwt.accessSecret, {expiresIn: "5m"});
    const res = await fetch(`${env.core.baseUrl}/api/products/${productId}?branchId=${branchId}`, {
        method: "PATCH",
        headers: {"Authorization": `Bearer ${ownerToken}`, "Content-Type": "application/json"},
        body: JSON.stringify({stock: topUpTo}),
    });
    if(!res.ok){
        throw new Error(`stock top-up failed: ${res.status} ${await res.text()}`);
    }
    console.log(`(test data) product ${productId} at branch ${branchId}: stock ${product?.stock ?? "?"} -> ${topUpTo}`);
}
