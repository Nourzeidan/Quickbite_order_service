import jwt from "jsonwebtoken";
import {env} from "../config/env.js";
import {NotAuthenticated} from "./errors.js";

// same payload core-service signs (ACCESS_SECRET is shared). order-service only verifies.
export interface JwtPayload {
    userId: number;
    email: string;
    role: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export function verifyAccessToken(token: string): JwtPayload {
    try{
        return jwt.verify(token, env.jwt.accessSecret) as JwtPayload;
    }catch{
        // expired / bad signature -> 401, never a 500
        throw NotAuthenticated;
    }
}

export function extractBearerToken(header: string | undefined): string | null {
    if(!header || !header.startsWith("Bearer ")){
        return null;
    }
    const token = header.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
}
