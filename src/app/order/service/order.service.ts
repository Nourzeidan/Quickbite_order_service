import {inject, injectable} from "tsyringe";
import {isUUID} from "class-validator";
import {v7 as uuidv7} from "uuid";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db, dbArchive} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {logger} from "../../../lib/logger/logger.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import {SystemRole} from "../../../lib/auth/enums.js";
import {ALL_REGIONS, REGIONS, regionForCountry} from "../../../lib/sharding/regions.js";
import {RegionNotResolvedError} from "../../../lib/sharding/errors.js";
import {IdempotencyConflictError} from "../../../lib/idempotency/errors.js";
import type {IdempotencyContext} from "../../../lib/idempotency/idempotency.js";
import {decodeCursor, encodeCursor, type PaginationMeta} from "../../../lib/http/pagination/cursor-pagination.js";
import type {BranchClient} from "../../../lib/core-client/branch.client.js";
import type {RestaurantClient} from "../../../lib/core-client/restaurant.client.js";
import type {AddressClient} from "../../../lib/core-client/address.client.js";
import type {ProductClient} from "../../../lib/core-client/product.client.js";
import type {StockClient} from "../../../lib/core-client/stock.client.js";
import type {CoreBranchProduct} from "../../../lib/core-client/types.js";
import {daysToMs, startOfUtcYear} from "../../../pkg/utils/time.js";
import {
    CANCEL_REASON_OUT_OF_STOCK,
    CANCEL_REASON_STOCK_RESERVATION_FAILED,
    Currency,
    OrderActor,
    OrderStatus,
    PaymentMethod
} from "../enums.js";
import {
    AddressNotFoundError,
    BranchNotAcceptingOrdersError,
    InvalidCursorError,
    InvalidDateRangeError,
    OrderNotFoundError,
    OutOfStockError,
    ProductNotFoundError,
    ProductUnavailableError,
    RegionMismatchError,
    TooManyItemsError
} from "../errors.js";
import type {Order} from "../entity/order.entity.js";
import type {
    AdminOrdersQueryDTO,
    CreateOrderRequestDTO,
    CustomerOrdersQueryDTO,
    RestaurantOrdersQueryDTO
} from "../dto/order.request.dto.js";
import {
    OrderDetailResponseDTO,
    OrderResponseDTO,
    OrderSummaryResponseDTO,
    type PaymentSummary
} from "../dto/order.response.dto.js";
import type {DateRange, OrderCursor, OrderListFilter} from "../types.js";
import {insertOrder, findOrderByPublicId, listOrders, updateOrderStatus} from "../repository/order.repo.js";
import {countItemsByOrders, insertOrderItems} from "../repository/order-item.repo.js";
import {
    deleteIdempotencyKeyByHash,
    findIdempotencyKeyByHash,
    insertIdempotencyKey,
    PG_UNIQUE_VIOLATION,
    updateIdempotencyKeyResponse
} from "../repository/idempotency-key.repo.js";
import {priceOrder, type PricingLine} from "./order-pricing.service.js";
import {isRestaurantMemberOf, type OrderStatusService} from "./order-status.service.js";
import type {OrderCacheService} from "./order-cache.service.js";

const MAX_QUANTITY_PER_PRODUCT = 50;
const MAX_LIST_RANGE_MS = daysToMs(366);
const DEFAULT_PAGE_SIZE = 20;

export interface PlaceOrderResult {
    order: OrderResponseDTO;
    replayed: boolean;              // served from the idempotency_keys table
}

export interface OrderListResult {
    data: OrderSummaryResponseDTO[];
    meta: PaginationMeta;
}

// cursor state: per region the last row returned ([createdAtISO, publicId]) or "end" when exhausted.
// a region absent from the map has not been read yet.
type CursorState = Record<string, [string, string] | "end">;

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.BranchClient) private readonly branchClient: BranchClient,
        @inject(TOKENS.RestaurantClient) private readonly restaurantClient: RestaurantClient,
        @inject(TOKENS.AddressClient) private readonly addressClient: AddressClient,
        @inject(TOKENS.ProductClient) private readonly productClient: ProductClient,
        @inject(TOKENS.StockClient) private readonly stockClient: StockClient,
        @inject(TOKENS.OrderStatusService) private readonly orderStatusService: OrderStatusService,
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService
    ){}

    // POST /orders — docs/business-logic/orders.md §2
    place = async (
        user: JwtPayload,
        data: CreateOrderRequestDTO,
        requestRegion: string | undefined,
        idempotency: IdempotencyContext | undefined,
        correlationId: string
    ): Promise<PlaceOrderResult> => {
        const lines = mergeItems(data.items);

        // the branch decides the shard, so it is read first
        const branch = await this.branchClient.getBranch(data.branchId, correlationId);
        if(!branch){
            throw BranchNotAcceptingOrdersError;
        }
        const region = regionForCountry(branch.countryCode);
        if(!region){
            throw RegionNotResolvedError;
        }
        if(requestRegion && requestRegion !== region){
            throw RegionMismatchError;
        }
        const conn = db(region);

        // durable replay guard (Redis may have lost the key)
        if(idempotency){
            const replay = await this.findReplay(idempotency, conn);
            if(replay) return replay;
        }

        // every network call happens before the transaction
        const productIds = lines.map((line) => line.productId);
        const [restaurant, address, products] = await Promise.all([
            this.restaurantClient.getRestaurant(branch.restaurantId, correlationId),
            this.addressClient.getAddress(user.userId, data.customerAddressId, correlationId),
            this.productClient.getBranchProducts(branch.id, productIds, correlationId),
        ]);

        if(!restaurant || restaurant.status !== "active" || !branch.isActive || !branch.acceptOrders){
            throw BranchNotAcceptingOrdersError;
        }
        if(!address){
            throw AddressNotFoundError;
        }
        const pricingLines = matchProducts(lines, products);
        const pricing = priceOrder(pricingLines, branch.deliveryFee, env.orders.serviceFeeBps);

        const online = data.paymentMethod === PaymentMethod.ONLINE;
        const publicId = uuidv7();

        let response: OrderResponseDTO;
        const trx = await conn.transaction();
        try{
            const order = await insertOrder({
                region,
                publicId,
                countryCode: branch.countryCode,
                restaurantId: branch.restaurantId,
                branchId: branch.id,
                customerId: user.userId,
                customerAddressId: address.id,
                deliveryLat: address.lat,
                deliveryLng: address.lng,
                deliveryAddressText: address.addressText,
                status: online ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED,
                subtotal: pricing.subtotal,
                deliveryFee: pricing.deliveryFee,
                serviceFee: pricing.serviceFee,
                total: pricing.total,
                currency: branch.currency as Currency,
                paymentMethod: data.paymentMethod,
            }, trx);

            const items = await insertOrderItems(pricing.items.map((item) => ({
                region,
                orderId: order.id,
                orderCreatedAt: order.createdAt,
                ...item,
            })), trx);

            // TODO(phase-2): COD -> paymentService.recordCodCollection(order, restaurant.ownerId, trx)
            // (the transactions table lands with Payments)

            response = OrderResponseDTO.from(order, items);
            if(idempotency){
                await insertIdempotencyKey({
                    keyHash: idempotency.keyHash,
                    region,
                    userId: user.userId,
                    fingerprint: idempotency.fingerprint,
                    responseStatus: 201,
                    responseBody: response,
                    ttlSec: idempotency.ttlSec,
                }, trx);
            }
            await trx.commit();
        }catch(err){
            await trx.rollback();
            // a concurrent request with the same key committed first -> answer like it did
            if(idempotency && (err as {code?: string}).code === PG_UNIQUE_VIOLATION){
                const replay = await this.findReplay(idempotency, conn);
                if(replay) return replay;
            }
            throw err;
        }

        // after commit: reserve on core (atomic, idempotent on orderPublicId)
        let reservation: "reserved" | "out_of_stock";
        try{
            reservation = await this.stockClient.reserveStock(
                branch.id,
                publicId,
                lines.map(({productId, quantity}) => ({productId, quantity})),
                correlationId
            );
        }catch(err){
            // core unreachable: we don't know whether it reserved -> void, release, let the client retry the key
            await this.voidOrder(region, response, idempotency, CANCEL_REASON_STOCK_RESERVATION_FAILED, correlationId);
            throw err;
        }
        if(reservation === "out_of_stock"){
            await this.voidOrder(region, response, idempotency, CANCEL_REASON_OUT_OF_STOCK, correlationId);
            throw OutOfStockError;
        }

        // TODO(phase-6): COD -> WS order.created to branch:<id>, restaurant:<id>
        return {order: response, replayed: false};
    }

    // GET /orders/:publicId — customer (own), restaurant member, admin; anyone else 404.
    // order data comes from the 5 s order cache; the access check runs on every request.
    getDetail = async (region: string, user: JwtPayload, publicId: string): Promise<OrderDetailResponseDTO> => {
        if(!isUUID(publicId)){
            throw OrderNotFoundError;
        }
        const snapshot = await this.orderCache.getOrLoad(region, publicId, db(region));
        if(!snapshot || !canRead(user, snapshot.order)){
            throw OrderNotFoundError;
        }
        const {order, items} = snapshot;
        return OrderDetailResponseDTO.fromDetail(order, items, paymentSummaryOf(order));
    }

    // GET /customer/orders?year= — one calendar year
    listForCustomer = async (region: string, user: JwtPayload, query: CustomerOrdersQueryDTO): Promise<OrderListResult> => {
        const year = query.year ?? new Date().getUTCFullYear();
        const range = {from: startOfUtcYear(year), to: startOfUtcYear(year + 1)};
        return this.list([region], {customerId: user.userId}, range, query, () => readConnForYear(region, year));
    }

    // GET /restaurant/orders?branchId=&status=&from=&to=
    listForRestaurant = async (region: string, user: JwtPayload, query: RestaurantOrdersQueryDTO): Promise<OrderListResult> => {
        const filter: OrderListFilter = {branchId: query.branchId};
        if(query.status) filter.status = query.status;
        // requireBranchAccess lets owners through for any branch id: scope to their restaurant here
        if(user.role !== SystemRole.ADMIN) filter.restaurantId = Number(user.restaurantId);
        return this.list([region], filter, parseRange(query.from, query.to), query, () => db(region));
    }

    // GET /admin/orders — X-Region: all fans out to every shard with a per-region cursor
    listForAdmin = async (region: string, query: AdminOrdersQueryDTO): Promise<OrderListResult> => {
        const filter: OrderListFilter = {};
        if(query.branchId) filter.branchId = query.branchId;
        if(query.status) filter.status = query.status;
        const regions = region === ALL_REGIONS ? [...REGIONS] : [region];
        return this.list(regions, filter, parseRange(query.from, query.to), query, (shard) => db(shard));
    }

    // one keyset page across one or more shards; never OFFSET, never a query per row
    private list = async (
        regions: string[],
        filter: OrderListFilter,
        range: DateRange,
        query: {cursor?: string; limit?: number},
        connFor: (region: string) => Knex
    ): Promise<OrderListResult> => {
        const limit = query.limit ?? DEFAULT_PAGE_SIZE;
        const state = decodeCursor(query.cursor, isCursorState);
        if(query.cursor && !state){
            throw InvalidCursorError;
        }
        const cursorState: CursorState = state ?? {};

        const perRegion = await Promise.all(regions.map(async (region) => {
            const position = cursorState[region];
            if(position === "end"){
                return {region, orders: [] as Order[]};
            }
            const cursor: OrderCursor | null = position ? {createdAt: new Date(position[0]), publicId: position[1]} : null;
            const orders = await listOrders(filter, range, {cursor, limit}, connFor(region));
            return {region, orders};
        }));

        // merge newest first, keep `limit`
        const merged = perRegion
            .flatMap(({region, orders}) => orders.map((order) => ({region, order})))
            .sort((a, b) => compareNewestFirst(a.order, b.order))
            .slice(0, limit);

        const nextState: CursorState = {...cursorState};
        for(const {region, orders} of perRegion){
            if(cursorState[region] === "end") continue;
            const taken = merged.filter((row) => row.region === region);
            const last = taken[taken.length - 1];
            if(taken.length === orders.length && orders.length <= limit){
                nextState[region] = "end";
            }else if(last){
                nextState[region] = [last.order.createdAt.toISOString(), last.order.publicId];
            }
        }
        const hasMore = regions.some((region) => nextState[region] !== "end");

        // items count: one grouped query per shard touched, never per row
        const counts = new Map<string, number>();
        await Promise.all(regions.map(async (region) => {
            const orders = merged.filter((row) => row.region === region).map((row) => row.order);
            const byId = await countItemsByOrders(orders, connFor(region));
            for(const order of orders){
                counts.set(order.publicId, byId.get(order.id) ?? 0);
            }
        }));

        return {
            data: merged.map(({order}) => OrderSummaryResponseDTO.from(order, counts.get(order.publicId) ?? 0)),
            meta: {
                nextCursor: hasMore ? encodeCursor(nextState) : null,
                hasMore,
                count: merged.length,
            },
        };
    }

    private findReplay = async (idempotency: IdempotencyContext, conn: Knex): Promise<PlaceOrderResult | null> => {
        const stored = await findIdempotencyKeyByHash(idempotency.keyHash, conn);
        if(!stored){
            return null;
        }
        if(!stored.fingerprint.equals(idempotency.fingerprint)){
            throw IdempotencyConflictError;
        }
        // the only non-201 we store is the post-commit "Out of stock" (see voidOrder)
        if(stored.responseStatus !== 201){
            throw OutOfStockError;
        }
        return {order: stored.responseBody as OrderResponseDTO, replayed: true};
    }

    // system cancel of an order whose stock could not be reserved after commit
    private voidOrder = async (
        region: string,
        order: OrderResponseDTO,
        idempotency: IdempotencyContext | undefined,
        reason: string,
        correlationId: string
    ) => {
        const conn = db(region);
        const current = await findOrderByPublicId(order.publicId, conn);
        if(!current){
            return;
        }
        const fromStatuses = this.orderStatusService.allowedSources(OrderStatus.CANCELLED, OrderActor.SYSTEM);

        const trx = await conn.transaction();
        try{
            await updateOrderStatus(current, fromStatuses, OrderStatus.CANCELLED, reason, trx);
            // TODO(phase-2): COD -> cod_collection 'failed' + 0-amount adjustment
            if(idempotency){
                if(reason === CANCEL_REASON_OUT_OF_STOCK){
                    // a retry with the same key gets the same 409
                    await updateIdempotencyKeyResponse(idempotency.keyHash, OutOfStockError.statusCode, {error: OutOfStockError.message}, trx);
                }else{
                    // retryable failure: forget the key so the retry places a fresh order
                    await deleteIdempotencyKeyByHash(idempotency.keyHash, trx);
                }
            }
            await trx.commit();
        }catch(err){
            await trx.rollback();
            throw err;
        }

        await this.orderCache.invalidate(region, order.publicId);
        logger.warn("order voided after commit", {region, orderPublicId: order.publicId, reason, correlationId});
        if(reason === CANCEL_REASON_STOCK_RESERVATION_FAILED){
            // core may have reserved before the timeout; release is a no-op otherwise
            this.stockClient.releaseStock(current.branchId, current.publicId, correlationId).catch((err) => {
                logger.error("stock release failed after void", {region, orderPublicId: current.publicId, correlationId, error: (err as Error).message});
            });
        }
    }
}

// same product twice in a cart -> one line with the summed quantity
function mergeItems(items: {productId: number; quantity: number}[]): {productId: number; quantity: number}[] {
    const merged = new Map<number, number>();
    for(const item of items){
        merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
    }
    return [...merged.entries()].map(([productId, quantity]) => {
        if(quantity > MAX_QUANTITY_PER_PRODUCT){
            throw TooManyItemsError;
        }
        return {productId, quantity};
    });
}

// cached stock is advisory (core's reserve is the authority); it just fails fast on obvious cases
function matchProducts(lines: {productId: number; quantity: number}[], products: CoreBranchProduct[]): PricingLine[] {
    const byId = new Map(products.map((product) => [product.productId, product]));
    return lines.map(({productId, quantity}) => {
        const product = byId.get(productId);
        if(!product){
            throw ProductNotFoundError;
        }
        if(!product.isAvailable){
            throw ProductUnavailableError;
        }
        if(product.stock < quantity){
            throw OutOfStockError;
        }
        return {product, quantity};
    });
}

function canRead(user: JwtPayload, order: Order): boolean {
    switch(user.role){
        case SystemRole.ADMIN: return true;
        case SystemRole.CUSTOMER: return order.customerId === user.userId;
        case SystemRole.RESTAURANT_USER: return isRestaurantMemberOf(user, order);
        default: return false;
    }
}

// TODO(phase-2): derive from the ledger (latest charge / cod_collection + refunds).
// Phase 1 has no transactions table: nothing is collected before delivery, and a rejected /
// cancelled order will never be collected.
function paymentSummaryOf(order: Order): PaymentSummary {
    const voided = order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED;
    return {
        method: order.paymentMethod,
        status: voided ? "failed" : "pending",
        amount: order.total,
        refundedAmount: 0,
        currency: order.currency,
    };
}

// default: Jan 1 of the current year -> now. Bounded to one year so index range scans stay small.
function parseRange(from: string | undefined, to: string | undefined): DateRange {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : startOfUtcYear(end.getUTCFullYear());
    if(start.getTime() >= end.getTime() || end.getTime() - start.getTime() > MAX_LIST_RANGE_MS){
        throw InvalidDateRangeError;
    }
    // `to` is inclusive for the caller; the repository range is [from, to)
    return {from: start, to: new Date(end.getTime() + 1)};
}

// prior years move to the archive cluster in Phase 7; until it is configured they are still hot
function readConnForYear(region: string, year: number): Knex {
    const archived = year < new Date().getUTCFullYear() && env.archiveShards[region] !== undefined;
    return archived ? dbArchive(region) : db(region);
}

function compareNewestFirst(a: Order, b: Order): number {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if(byTime !== 0) return byTime;
    return a.publicId < b.publicId ? 1 : a.publicId > b.publicId ? -1 : 0;
}

function isCursorState(value: unknown): value is CursorState {
    if(typeof value !== "object" || value === null || Array.isArray(value)){
        return false;
    }
    return Object.entries(value).every(([region, position]) =>
        REGIONS.includes(region) && (
            position === "end" ||
            (Array.isArray(position) && position.length === 2 &&
                typeof position[0] === "string" && !Number.isNaN(Date.parse(position[0])) &&
                typeof position[1] === "string" && isUUID(position[1]))
        )
    );
}
