import {AppError} from "../../lib/error/AppError.js";

// messages: docs/api-contracts.md §9
export const OrderAlreadyTakenError = new AppError("Order already taken", 409);
export const OrderNotReadyForDeliveryError = new AppError("Order is not ready for delivery", 409);
export const AgentNotOnlineError = new AppError("Agent is not online", 409);
export const AgentTooFarError = new AppError("Agent is too far from the pickup", 409);
export const AgentHasActiveDeliveryError = new AppError("Agent has an active delivery", 409);
