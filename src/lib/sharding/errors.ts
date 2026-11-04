import {AppError} from "../error/AppError.js";

export const RegionNotResolvedError = new AppError("Region not resolved", 400);
export const InvalidRegionError = new AppError("Invalid region", 400);
export const RegionAllNotAllowedError = new AppError('Region "all" is not allowed here', 400);
