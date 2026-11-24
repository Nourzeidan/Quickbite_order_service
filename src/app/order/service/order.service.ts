import {inject, injectable} from "tsyringe";
import {isUUID} from "class-validator";
import {v7 as uuidv7} from "uuid";
import type {Knex} from "knex";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import {hotSource, readSourcesForRange, touchesPriorYear, type ReadSource} from "../../../lib/knex/read-sources.js";
import {isSourceCursors, mergeKeysetPages, type SourceCursors} from "../../../lib/http/pagination/keyset-merge.js";
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
import {timeOfUuidV7} from "../../../pkg/utils/uuid.js";
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
    OrderSummaryResponseDTO
} from "../dto/order.response.dto.js";
import type {DateRange, OrderCursor, OrderListFilter} from "../types.js";
import {insertOrder, findOrderByPublicId, listOrders, updateOrderStatus} from "../repository/order.repo.js";
import {countItemsByOrders, findItemsByOrders, insertOrderItems} from "../repository/order-item.repo.js";
import {
    deleteIdempotencyKeyByHash,
    findIdempotencyKeyByHash,
    insertIdempotencyKey,
    PG_UNIQUE_VIOLATION,
    updateIdempotencyKeyResponse
} from "../../../lib/idempotency/idempotency-key.repo.js";
import {priceOrder, type PricingLine} from "./order-pricing.service.js";
import {isRestaurantMemberOf, type OrderStatusService} from "./order-status.service.js";
import type {OrderCacheService, OrderSnapshot} from "./order-cache.service.js";
import {toPaymentRef} from "../payment-ref.js";
import type {PaymentLedgerService} from "../../payment/service/payment-ledger.service.js";
import type {OrderEventsService} from "./order-events.service.js";

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

// cursor state: per source ("eg", "eg:archive", ...) the last row returned ([createdAtISO, publicId])
// or "end" when exhausted; a source absent from the map has not been read yet (keyset-merge.ts)
type OrderPosition = [string, string];
type CursorState = SourceCursors<OrderPosition>;

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.BranchClient) private readonly branchClient: BranchClient,
        @inject(TOKENS.RestaurantClient) private readonly restaurantClient: RestaurantClient,
        @inject(TOKENS.AddressClient) private readonly addressClient: AddressClient,
        @inject(TOKENS.ProductClient) private readonly productClient: ProductClient,
        @inject(TOKENS.StockClient) private readonly stockClient: StockClient,
        @inject(TOKENS.OrderStatusService) private readonly orderStatusService: OrderStatusService,
        @inject(TOKENS.OrderCacheService) private readonly orderCache: OrderCacheService,
        @inject(TOKENS.PaymentLedgerService) private readonly ledger: PaymentLedgerService,
        @inject(TOKENS.OrderEventsService) private readonly orderEvents: OrderEventsService
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
        let placed: Order;
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
                pickupLat: branch.lat,
                pickupLng: branch.lng,
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

            // COD: the money is collected at the door -> pending ledger row now (payments.md §7)
            if(!online){
                await this.ledger.recordCodCollection(toPaymentRef(order), restaurant.ownerId, trx);
            }

            response = OrderResponseDTO.from(order, items);
            placed = order;
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

        // COD goes straight into the restaurant's queue; online waits for the capture (OrderPaymentService.afterPaid)
        if(!online){
            this.orderEvents.created(placed, response.items.length);
        }
        return {order: response, replayed: false};
    }

    // GET /orders/:publicId — customer (own), restaurant member, admin; anyone else 404.
    // order data comes from the 5 s order cache; the access check runs on every request.
    getDetail = async (region: string, user: JwtPayload, publicId: string): Promise<OrderDetailResponseDTO> => {
        if(!isUUID(publicId)){
            throw OrderNotFoundError;
        }
        const found = await this.loadDetail(region, publicId);
        if(!found || !canRead(user, found.snapshot.order)){
            throw OrderNotFoundError;
        }
        const {snapshot: {order, items}, conn} = found;
        // ledger is read fresh (one indexed query, Q-P3) from the cluster the order was found on:
        // payment state must not lag behind the cache
        const ledger = await this.ledger.summarize(toPaymentRef(order), order.paymentMethod, isVoided(order), conn);
        return OrderDetailResponseDTO.fromDetail(order, items, {
            method: order.paymentMethod,
            status: ledger.status,
            amount: order.total,
            refundedAmount: ledger.refundedAmount,
            currency: order.currency,
        });
    }

    // GET /customer/orders?year= — one calendar year
    listForCustomer = async (region: string, user: JwtPayload, query: CustomerOrdersQueryDTO): Promise<OrderListResult> => {
        const year = query.year ?? new Date().getUTCFullYear();
        const range = {from: startOfUtcYear(year), to: startOfUtcYear(year + 1)};
        return this.list(readSourcesForRange(region, range), {customerId: user.userId}, range, query);
    }

    // GET /restaurant/orders?branchId=&status=&from=&to=
    listForRestaurant = async (region: string, user: JwtPayload, query: RestaurantOrdersQueryDTO): Promise<OrderListResult> => {
        const filter: OrderListFilter = {branchId: query.branchId};
        if(query.status) filter.status = query.status;
        // requireBranchAccess lets owners through for any branch id: scope to their restaurant here
        if(user.role !== SystemRole.ADMIN) filter.restaurantId = Number(user.restaurantId);
        const range = parseRange(query.from, query.to);
        return this.list(readSourcesForRange(region, range), filter, range, query);
    }

    // GET /admin/orders — X-Region: all fans out to every shard with a per-region cursor
    listForAdmin = async (region: string, query: AdminOrdersQueryDTO): Promise<OrderListResult> => {
        const filter: OrderListFilter = {};
        if(query.branchId) filter.branchId = query.branchId;
        if(query.status) filter.status = query.status;
        const regions = region === ALL_REGIONS ? [...REGIONS] : [region];
        const range = parseRange(query.from, query.to);
        return this.list(regions.flatMap((shard) => readSourcesForRange(shard, range)), filter, range, query);
    }

    // one keyset page across one or more sources (shards for X-Region: all, archive + hot for prior
    // years); never OFFSET, never a query per row. The merge itself lives in keyset-merge.ts.
    private list = async (
        sources: ReadSource[],
        filter: OrderListFilter,
        range: DateRange,
        query: {cursor?: string; limit?: number}
    ): Promise<OrderListResult> => {
        const limit = query.limit ?? DEFAULT_PAGE_SIZE;
        const state = decodeCursor(query.cursor, isCursorState);
        if(query.cursor && !state){
            throw InvalidCursorError;
        }

        const page = await mergeKeysetPages<Order, OrderPosition>({
            sources,
            state: state ?? {},
            limit,
            fetch: (source, position) => {
                const cursor: OrderCursor | null = position ? {createdAt: new Date(position[0]), publicId: position[1]} : null;
                return listOrders(filter, range, {cursor, limit}, source.conn);
            },
            compare: compareNewestFirst,
            identity: (order) => order.publicId,
            cursorOf: (order) => [order.createdAt.toISOString(), order.publicId],
        });

        // items count: one grouped query per source touched, never per row
        const counts = new Map<string, number>();
        await Promise.all(sources.map(async (source) => {
            const orders = page.rows.filter((row) => row.source === source).map((row) => row.row);
            if(orders.length === 0) return;
            const byId = await countItemsByOrders(orders, source.conn);
            for(const order of orders){
                counts.set(order.publicId, byId.get(order.id) ?? 0);
            }
        }));

        return {
            data: page.rows.map(({row: order}) => OrderSummaryResponseDTO.from(order, counts.get(order.publicId) ?? 0)),
            meta: {
                nextCursor: page.hasMore ? encodeCursor(page.nextState) : null,
                hasMore: page.hasMore,
                count: page.rows.length,
            },
        };
    }

    // GET /orders/:publicId: the year is inside the UUIDv7, so the cluster is known before any query.
    //   current year -> hot, through the 5 s order cache (as before)
    //   prior year   -> archive, then hot; no cache: rare reads, and the archiver moves these rows
    private loadDetail = async (region: string, publicId: string): Promise<{snapshot: OrderSnapshot; conn: Knex} | null> => {
        const createdAt = timeOfUuidV7(publicId);
        if(!touchesPriorYear(createdAt)){
            const conn = hotSource(region).conn;
            const snapshot = await this.orderCache.getOrLoad(region, publicId, conn);
            return snapshot ? {snapshot, conn} : null;
        }
        for(const source of readSourcesForRange(region, {from: createdAt})){
            const order = await findOrderByPublicId(publicId, source.conn);
            if(order){
                const items = await findItemsByOrders([order], source.conn);
                return {snapshot: {order, items}, conn: source.conn};
            }
        }
        return null;
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

        let voided: Order | null;
        const trx = await conn.transaction();
        try{
            voided = await updateOrderStatus(current, fromStatuses, OrderStatus.CANCELLED, reason, trx);
            if(voided && voided.paymentMethod === PaymentMethod.COD){
                await this.ledger.voidCodCollection(toPaymentRef(voided), reason, trx);
            }
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
        if(voided){
            this.orderEvents.statusChanged(voided);
        }
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

// a rejected / cancelled order will never be collected
function isVoided(order: Order): boolean {
    return order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED;
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

function compareNewestFirst(a: Order, b: Order): number {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if(byTime !== 0) return byTime;
    return a.publicId < b.publicId ? 1 : a.publicId > b.publicId ? -1 : 0;
}

function isCursorState(value: unknown): value is CursorState {
    return isSourceCursors(value, (position): position is OrderPosition =>
        Array.isArray(position) && position.length === 2 &&
        typeof position[0] === "string" && !Number.isNaN(Date.parse(position[0])) &&
        typeof position[1] === "string" && isUUID(position[1]));
}
