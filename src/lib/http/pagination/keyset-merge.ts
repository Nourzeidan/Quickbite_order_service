import type {ReadSource} from "../../knex/read-sources.js";

// One keyset page read from several sources (shards for admin fan-out, archive + hot for prior years)
// and merged into one list, with one cursor position per source.
//
//   state = { "eg": [<last row of eg>], "eg:archive": "end", ... }
//     - absent  -> that source has not been read yet (start from the top)
//     - "end"   -> that source has nothing more
//
// Each source returns up to `limit + 1` rows in the SAME order as `compare`. The rows are merged, the
// first `limit` distinct rows are kept, and every source's cursor moves past exactly the rows of it
// that were used. A row found in two sources (archive + hot while the archiver is between its copy
// and its delete) has the same `identity` there: it is returned once and both cursors skip it.
export type SourceCursors<C> = Record<string, C | "end">;

export interface MergedRow<T> {
    source: ReadSource;
    row: T;
}

export interface MergeKeysetInput<T, C> {
    sources: ReadSource[];
    state: SourceCursors<C>;
    limit: number;
    fetch: (source: ReadSource, cursor: C | null) => Promise<T[]>;
    compare: (a: T, b: T) => number;
    identity: (row: T) => string;
    cursorOf: (row: T) => C;
}

export interface MergeKeysetResult<T, C> {
    rows: MergedRow<T>[];
    nextState: SourceCursors<C>;
    hasMore: boolean;
}

export async function mergeKeysetPages<T, C>(input: MergeKeysetInput<T, C>): Promise<MergeKeysetResult<T, C>> {
    const {sources, state, limit} = input;

    // one query per source, in parallel (never one per row)
    const fetched = await Promise.all(sources.map(async (source) => {
        const position = state[source.key];
        const rows = position === "end" ? [] : await input.fetch(source, position ?? null);
        return {source, rows};
    }));

    // every source is already sorted, so after a global sort the rows each source contributes are
    // always a prefix of its own list: counting them is enough to place its next cursor
    const candidates = fetched.flatMap(({source, rows}, sourceIndex) =>
        rows.map((row) => ({source, sourceIndex, row})));
    candidates.sort((a, b) => input.compare(a.row, b.row) || a.sourceIndex - b.sourceIndex);

    const rows: MergedRow<T>[] = [];
    const seen = new Set<string>();
    const consumed = new Map<string, number>();
    for(const candidate of candidates){
        const id = input.identity(candidate.row);
        const duplicate = seen.has(id);
        if(!duplicate && rows.length === limit){
            break;
        }
        consumed.set(candidate.source.key, (consumed.get(candidate.source.key) ?? 0) + 1);
        if(!duplicate){
            seen.add(id);
            rows.push({source: candidate.source, row: candidate.row});
        }
    }

    const nextState: SourceCursors<C> = {};
    for(const {source, rows: sourceRows} of fetched){
        const previous = state[source.key];
        const used = consumed.get(source.key) ?? 0;
        if(previous === "end" || (used === sourceRows.length && sourceRows.length <= limit)){
            nextState[source.key] = "end";
        }else if(used > 0){
            nextState[source.key] = input.cursorOf(sourceRows[used - 1]!);
        }else if(previous !== undefined){
            nextState[source.key] = previous;
        }
    }
    const hasMore = sources.some((source) => nextState[source.key] !== "end");
    return {rows, nextState, hasMore};
}

// a cursor state is valid when every key is a source this request reads and every value passes isPosition
export function isSourceCursors<C>(value: unknown, isPosition: (position: unknown) => position is C): value is SourceCursors<C> {
    if(typeof value !== "object" || value === null || Array.isArray(value)){
        return false;
    }
    return Object.values(value).every((position) => position === "end" || isPosition(position));
}
