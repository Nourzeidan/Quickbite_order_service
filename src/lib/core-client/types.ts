export interface CoreClientRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;                       // e.g. "/api/internal/branches/123"
    body?: unknown;
    correlationId?: string;
    idempotencyKey?: string;            // makes a mutating call safe to retry
}

// response shapes of core's /api/internal/* (core-service CHANGES.md §4, integrations §2.3)

export interface CoreBranch {
    id: number;
    restaurantId: number;
    countryCode: string;
    currency: string;                   // "EGP" | "SAR"
    lat: number;
    lng: number;
    isActive: boolean;
    acceptOrders: boolean;
    deliveryFee: number;                // minor units
    commission: number;                 // basis points
    deliveryRadiusKm: number;
}

export interface CoreRestaurant {
    id: number;
    ownerId: number;
    name: string;
    status: string;                     // "active" | "suspended" | ...
}

export interface CoreAddress {
    id: number;
    userId: number;
    lat: number;
    lng: number;
    addressText: string;
}

export interface CoreBranchProduct {
    productId: number;
    name: string;
    imageUrl: string | null;
    price: string;                      // DECIMAL string "55.00" -> toMinor
    stock: number;
    isAvailable: boolean;
}

export interface CoreStockItem {
    productId: number;
    quantity: number;
}
