import {AppError} from "../../lib/error/AppError.js";

// messages: docs/api-contracts.md §9
export const RestaurantNotFoundError = new AppError("Restaurant not found", 404);
export const InsufficientBalanceError = new AppError("Insufficient balance", 409);
export const RestaurantIdRequiredError = new AppError("Validation failed: restaurantId is required", 400);
