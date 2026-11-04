import {v4 as uuidv4} from "uuid";
import type {Request, Response, NextFunction} from "express";

// honour an incoming X-Correlation-ID (gateway / core) so one id follows the request across services
export function correlationId(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers["x-correlation-id"];
    const id = typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128 ? incoming : uuidv4();
    req.correlationId = id;
    res.setHeader("X-Correlation-ID", id);
    next();
}
