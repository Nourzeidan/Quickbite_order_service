import {AppError} from "../error/AppError.js";

export const IdempotencyKeyRequiredError = new AppError("Missing Idempotency-Key header", 400);
export const IdempotencyConflictError = new AppError("Idempotency key reused with a different body", 409);
export const IdempotencyInProgressError = new AppError("Request with this Idempotency-Key is already in progress", 409);
export const IdempotencyUnavailableError = new AppError("Idempotency service unavailable", 503);
