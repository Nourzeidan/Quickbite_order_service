import type {NextFunction, Request, Response} from "express";
import {ALL_REGIONS, isRegion} from "./regions.js";
import {InvalidRegionError, RegionAllNotAllowedError, RegionNotResolvedError} from "./errors.js";

// global middleware: reads the region from the X-Region header ONLY (not JWT, path, query or cookie).
// a header that is present but unknown is a 400 instead of being silently ignored.
export function resolveRegion(req: Request, res: Response, next: NextFunction) {
    const header = req.headers["x-region"];
    const raw = Array.isArray(header) ? header[0] : header;
    if(raw){
        const region = raw.trim().toLowerCase();
        if(region !== ALL_REGIONS && !isRegion(region)){
            throw InvalidRegionError;
        }
        req.region = region;
    }
    next();
}

// per-route guard. allowAll: only admin fan-out reads may use X-Region: all
export function requireRegion(options: {allowAll?: boolean} = {}) {
    const {allowAll = false} = options;
    return (req: Request, res: Response, next: NextFunction) => {
        if(!req.region){
            throw RegionNotResolvedError;
        }
        if(req.region === ALL_REGIONS && !allowAll){
            throw RegionAllNotAllowedError;
        }
        next();
    }
}
