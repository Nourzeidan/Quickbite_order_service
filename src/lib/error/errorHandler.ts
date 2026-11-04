import type {Request, Response, NextFunction} from "express";
import {logger} from "../logger/logger.js";
import {AppError} from "./AppError.js";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
    // anything that is not an AppError (pg errors, bugs) is a 500 and never leaks its message
    const appError = err instanceof AppError ? err : new AppError(err.message, 500, false);
    const operational = appError.isOperational;

    // no request body in the log: payment endpoints carry provider payloads
    logger.error(appError.message, {
        statusCode: appError.statusCode,
        stack: appError.stack,
        operational: operational,
        method: req.method,
        path: req.originalUrl,
        region: req.region,
        correlationId: req.correlationId
    });

    if(operational){
        return res.status(appError.statusCode).json({
            error: appError.message,
        });
    }
    return res.status(500).json({
        error: "Something went wrong",
    });
}
