import {AppError} from "../error/AppError.js";

export const CoreServiceUnavailableError = new AppError("Core service unavailable", 503);

// 4xx from core keeps core's status; the endpoint wrapper decides what it means for the caller
export function coreUpstreamError(status: number, message: string): AppError {
    return new AppError(`Core service error: ${message}`, status);
}
