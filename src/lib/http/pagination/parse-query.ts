import type {FilterParams, PaginationParams} from "./cursor-pagination.js";

// sortBy is mapped through allowedSort (api field -> db column); anything else falls back to defaultSort
export function parsePaginationQuery(query: Record<string, any>, allowedSort: Record<string, string> = {}, defaultSort: string = "created_at"): PaginationParams {
    const parsedLimit = Number(query.limit);
    const params: PaginationParams = {
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(100, parsedLimit) : 20,
        sortBy: allowedSort[query.sortBy as string] ?? defaultSort,
        sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc'
    };
    if(typeof query.cursor === "string" && query.cursor.length > 0){
        params.cursor = query.cursor;
    }
    return params;
}

export function parseFilters(query: Record<string, any>, allowedFields: string[]): FilterParams[] {
    const filter = query.filter;
    if(!filter || typeof filter !== 'object') return [];

    const allowedOps = new Set(['eq', 'gt', 'lt', 'lte', 'gte', 'in', 'like']);

    return allowedFields.flatMap((field) => {
        const fieldFilters = filter[field];

        if(!fieldFilters || typeof fieldFilters !== 'object') return [];

        return Object.entries(fieldFilters)
            .filter(([op]) => allowedOps.has(op))
            .map(([operator, value]) => ({
                field,
                operator: operator as FilterParams['operator'],
                value: value as string | string[],
            }));
    });
}
