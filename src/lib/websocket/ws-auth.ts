import type {IncomingHttpHeaders} from "http";
import {verifyAccessToken, type JwtPayload} from "../auth/jwt.js";
import {SystemRole} from "../auth/enums.js";
import {WsNoTokenError} from "./errors.js";

interface Handshake {
    auth: Record<string, unknown>;
    headers: IncomingHttpHeaders;
}

// token sources, in order:
//   1. handshake.auth.token  - native/mobile: io(url, {auth: {token}})
//   2. access_token cookie   - browsers reuse the HTTP login cookie
// query-string tokens are NOT accepted (they end up in access logs)
export function authenticateHandshake(handshake: Handshake): JwtPayload {
    const authToken = typeof handshake.auth.token === "string" ? handshake.auth.token : null;
    const token = authToken ?? extractCookie(handshake.headers.cookie, "access_token");
    if(!token){
        throw WsNoTokenError;
    }
    return verifyAccessToken(token);
}

// socket.io rooms (= channels) this user may join
export function permittedChannels(user: JwtPayload): Set<string> {
    const allowed = new Set<string>();
    switch(user.role){
        case SystemRole.CUSTOMER:
            allowed.add(`customer:${user.userId}`);
            break;
        case SystemRole.RESTAURANT_USER:
            if(user.restaurantId){
                allowed.add(`restaurant:${user.restaurantId}`);
            }
            for(const branchId of user.branchIds ?? []){
                allowed.add(`branch:${branchId}`);
            }
            break;
        case SystemRole.DELIVERY_AGENT:
            allowed.add(`agent:${user.userId}`);
            break;
    }
    return allowed;
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
    if(!cookieHeader){
        return null;
    }
    for(const part of cookieHeader.split(";")){
        const eq = part.indexOf("=");
        if(eq < 0) continue;
        if(part.slice(0, eq).trim() === name){
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return null;
}
