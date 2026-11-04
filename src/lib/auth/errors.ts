import {AppError} from "../error/AppError.js";

export const NotAuthenticated = new AppError('Not Authenticated', 401);
export const unAuthorizedError = new AppError('Not Authorized for such Action !', 403);
export const BranchAccessDeniedError = new AppError('You do not have access to this branch', 403);
