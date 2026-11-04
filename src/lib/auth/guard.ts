import type {NextFunction, Request, Response} from "express";
import {NotAuthenticated} from "./errors.js";
import {extractBearerToken, verifyAccessToken} from "./jwt.js";

// Authorization: Bearer <jwt> (core-service style), access_token cookie as fallback for browsers
export function authenticate(req: Request, res: Response, next: NextFunction){
    const token = extractBearerToken(req.headers.authorization) ?? req.cookies?.access_token;
    if(!token){
        throw NotAuthenticated;
    }

    req.user = verifyAccessToken(token);
    next();
}
