import {AppError} from "../error/AppError.js";

export const WsNoTokenError = new AppError("Not Authenticated", 401);
