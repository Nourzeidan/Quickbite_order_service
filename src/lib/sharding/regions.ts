import {env} from "../config/env.js";
import {InvalidRegionError} from "./errors.js";

// fan-out marker for admin reads; never a shard
export const ALL_REGIONS = "all";

const configured = new Set(env.regions);

export const REGIONS: ReadonlyArray<string> = env.regions;

export function isRegion(candidate: string | null | undefined): candidate is string {
    return typeof candidate === "string" && configured.has(candidate);
}

export function assertRegion(candidate: string | null | undefined): string {
    if(!isRegion(candidate)){
        throw InvalidRegionError;
    }
    return candidate;
}

// core's branch.countryCode is free text; region == lowercased country code, plus the aliases where
// the region name differs from the ISO code (Saudi Arabia: "SA" -> "ksa").
const COUNTRY_ALIASES: Record<string, string> = {
    sa: "ksa",
};

export function regionForCountry(countryCode: string): string | null {
    const normalized = countryCode.trim().toLowerCase();
    const region = COUNTRY_ALIASES[normalized] ?? normalized;
    return isRegion(region) ? region : null;
}
