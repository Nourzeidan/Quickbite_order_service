import {AppError} from "../../lib/error/AppError.js";

// messages: docs/api-contracts.md §9
export const OrderNotPendingPaymentError = new AppError("Order is not pending payment", 409);
export const PaymentNotFoundError = new AppError("Payment not found", 404);
export const PaymentNotRefundableError = new AppError("Payment is not refundable", 409);
export const RefundExceedsRefundableError = new AppError("Refund exceeds the refundable amount", 409);
export const InvalidSignatureError = new AppError("Invalid signature", 401);
export const PaymentProviderUnavailableError = new AppError("Payment provider unavailable", 503);
export const PaymentProviderRejectedError = new AppError("Payment provider rejected the request", 502);
export const PaymentNotSettledError = new AppError("Order payment is not settled", 409);
