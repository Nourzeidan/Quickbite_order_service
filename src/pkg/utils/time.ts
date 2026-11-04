export function hoursToMS(hours: number): number {
    return hours * 60 * 60 * 1000;
}

export function MinsToMS(mins: number): number {
    return mins * 60 * 1000;
}

export function SecsToMS(sec: number): number {
    return sec * 1000;
}

export function daysToMs(day: number): number {
    return day * hoursToMS(24);
}

export function msToSecs(ms: number): number {
    return Math.floor(ms / 1000);
}

// pg ignores the offset of a JS Date sent to a TIMESTAMP (without time zone) column and node-pg
// serializes Dates in local time -> always send UTC ISO strings for TIMESTAMP params.
export function toUtcTimestamp(date: Date): string {
    return date.toISOString();
}

export function startOfUtcYear(year: number): Date {
    return new Date(Date.UTC(year, 0, 1));
}
