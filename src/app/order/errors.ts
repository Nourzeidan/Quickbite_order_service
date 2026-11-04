import {AppError} from "../../lib/error/AppError.js";

// messages: docs/api-contracts.md §9
export const OrderNotFoundError = new AppError("Order not found", 404);
export const RegionMismatchError = new AppError("Region mismatch", 409);
export const BranchNotAcceptingOrdersError = new AppError("Branch is not accepting orders", 409);
export const ProductNotFoundError = new AppError("Product not found", 409);
export const ProductUnavailableError = new AppError("Product unavailable", 409);
export const OutOfStockError = new AppError("Out of stock", 409);
export const InvalidStatusTransitionError = new AppError("Invalid status transition", 409);
export const CancellationWindowExpiredError = new AppError("Cancellation window expired", 409);
export const ReasonRequiredError = new AppError("Reason is required", 400);
export const InvalidDateRangeError = new AppError("Validation failed: from must be before to and within one year", 400);
export const TooManyItemsError = new AppError("Validation failed: quantity must not be greater than 50", 400);
export const AddressNotFoundError = new AppError("Address not found", 404);
export const InvalidCursorError = new AppError("Validation failed: cursor is invalid", 400);
