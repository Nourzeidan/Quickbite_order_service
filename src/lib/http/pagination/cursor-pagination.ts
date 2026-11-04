import type {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
}

export interface FilterParams {
    field: string;
    operator: 'eq' | 'gt' | 'lt' | 'lte' | 'gte' | 'in' | 'like';
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

// sortBy must be a db column name the caller whitelisted (never raw user input)
export function applyCursorPagination(query: Knex.QueryBuilder, params: PaginationParams): Knex.QueryBuilder {
    if(!params.sortBy){
        return query.limit(params.limit + 1);
    }
    if(params.cursor) {
        const op = params.sortOrder === 'asc' ? '>' : '<';
        query = query.where(params.sortBy, op, params.cursor);
    }
    return query.orderBy(params.sortBy, params.sortOrder).limit(params.limit + 1);
}

export function applyFilters(query: Knex.QueryBuilder, filters: FilterParams[]): Knex.QueryBuilder {
    for(const filter of filters) {
        switch(filter.operator) {
            case 'eq': query.where(filter.field, filter.value); break;
            case 'gt': query.where(filter.field, '>', filter.value); break;
            case 'lt': query.where(filter.field, '<', filter.value); break;
            case 'lte': query.where(filter.field, '<=', filter.value); break;
            case 'gte': query.where(filter.field, '>=', filter.value); break;
            case 'like': query.whereLike(filter.field, `%${filter.value}%`); break;
            case 'in': query.whereIn(filter.field, Array.isArray(filter.value) ? filter.value : [filter.value]); break;
        }
    }
    return query;
}

export function buildPaginationResult<T>(rows: T[], limit: number, sortBy: string) {
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    let nextCursor: string | null = null;
    const lastItem = data[data.length - 1] as Record<string, unknown> | undefined;
    if(hasMore && lastItem) {
        const value = lastItem[sortBy];
        nextCursor = value instanceof Date ? value.toISOString() : String(value);
    }
    return {
        data,
        meta: {
            nextCursor: nextCursor,
            hasMore: hasMore,
            count: data.length,
        } satisfies PaginationMeta
    }
}

// opaque keyset cursor: base64url(JSON). Used where one column can't order the rows on its own
// (e.g. orders: created_at + public_id tie-break) and for admin fan-out (one cursor per region).
export function encodeCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// null for anything that isn't a cursor we produced (callers treat it as "first page")
export function decodeCursor<T>(raw: string | undefined, isValid: (value: unknown) => value is T): T | null {
    if(!raw){
        return null;
    }
    try{
        const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        return isValid(value) ? value : null;
    }catch{
        return null;
    }
}
