import {applyBps, multiplyMinor, sumMinor, toMinor} from "../../../pkg/utils/money.js";
import type {CoreBranchProduct} from "../../../lib/core-client/types.js";
import type {OrderPricing, PricedItem} from "../types.js";

export interface PricingLine {
    product: CoreBranchProduct;
    quantity: number;
}

// pure: no I/O, integers only (docs/business-logic/orders.md §3). The client never sends prices.
export function priceOrder(lines: PricingLine[], deliveryFee: number, serviceFeeBps: number): OrderPricing {
    const items: PricedItem[] = lines.map(({product, quantity}) => {
        const unitPrice = toMinor(product.price);
        return {
            productId: product.productId,
            name: product.name,
            imageUrl: product.imageUrl,
            quantity,
            unitPrice,
            lineTotal: multiplyMinor(unitPrice, quantity),
        };
    });
    const subtotal = sumMinor(items.map((item) => item.lineTotal));
    const serviceFee = applyBps(subtotal, serviceFeeBps);
    return {
        items,
        subtotal,
        deliveryFee,
        serviceFee,
        total: subtotal + deliveryFee + serviceFee,
    };
}
