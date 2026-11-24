import type {Knex} from "knex";
import {db, dbArchive} from "./knex.js";
import {startOfUtcYear} from "../../pkg/utils/time.js";

// docs/business-logic/archival.md §6 — which cluster(s) answer a read.
//
//   only the current year      -> hot
//   touches any prior year     -> archive + hot (merged by the caller)
//
// Why both for prior years: a prior-year order can still be hot (its 30-day grace, stuck, or in the
// middle of a batch). The archiver copies BEFORE it deletes, so a row is always in at least one of
// the two; during a batch it can be in both, and callers drop that duplicate.
export interface ReadSource {
    key: string;            // cursor key: "<region>" or "<region>:archive"
    region: string;
    archive: boolean;
    conn: Knex;
}

export function hotSource(region: string): ReadSource {
    return {key: region, region, archive: false, conn: db(region)};
}

export function archiveSource(region: string): ReadSource {
    return {key: `${region}:archive`, region, archive: true, conn: dbArchive(region)};
}

export function touchesPriorYear(from: Date, now: Date = new Date()): boolean {
    return from.getTime() < startOfUtcYear(now.getUTCFullYear()).getTime();
}

// archive first: for prior years it holds most rows (detail lookups stop at the first hit)
export function readSourcesForRange(region: string, range: {from: Date}): ReadSource[] {
    return touchesPriorYear(range.from) ? [archiveSource(region), hotSource(region)] : [hotSource(region)];
}
