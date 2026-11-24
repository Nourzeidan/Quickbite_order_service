import {inject, injectable} from "tsyringe";
import {isUUID} from "class-validator";
import {TOKENS} from "../../../lib/di/tokens.js";
import {db} from "../../../lib/knex/knex.js";
import {env} from "../../../lib/config/env.js";
import type {JwtPayload} from "../../../lib/auth/jwt.js";
import {Rooms, type WsPublisher} from "../../../lib/websocket/ws-publisher.js";
import {decodeCursor, encodeCursor, type PaginationMeta} from "../../../lib/http/pagination/cursor-pagination.js";
import {isSourceCursors, mergeKeysetPages, type SourceCursors} from "../../../lib/http/pagination/keyset-merge.js";
import {readSourcesForRange} from "../../../lib/knex/read-sources.js";
import type {AgentEarning} from "../repository/agent-earning.repo.js";
import {distanceMeters} from "../../../pkg/utils/geo.js";
import {OrderActor, OrderStatus} from "../../order/enums.js";
import {InvalidCursorError, InvalidDateRangeError} from "../../order/errors.js";
import type {OrderDeliveryService} from "../../order/service/order-delivery.service.js";
import type {DeliveryService} from "../../delivery/service/delivery.service.js";
import type {DeliveryNotifierService} from "../../delivery/service/delivery-notifier.service.js";
import {AgentHasActiveDeliveryError, AgentNotOnlineError} from "../../delivery/errors.js";
import type {AgentEarningsQueryDTO, AgentTasksQueryDTO, PresenceRequestDTO} from "../../delivery/dto/delivery.request.dto.js";
import {
    AgentEarningsResponseDTO,
    AgentTaskResponseDTO,
    PresenceResponseDTO,
    type AgentEarningItemDTO
} from "../../delivery/dto/delivery.response.dto.js";
import type {PresenceService} from "./presence.service.js";
import type {AgentEarningService} from "./agent-earning.service.js";

const AVAILABLE_LIMIT = 50;
const DEFAULT_PAGE = 20;

type TaskCursor = [string, string];          // [createdAt ISO, publicId]
type EarningCursor = [string, number];       // [earnedAt ISO, id]

// deliveries.md §5 — everything an agent does about themselves. The agent = req.user.userId.
@injectable()
export class AgentService {
    constructor(
        @inject(TOKENS.PresenceService) private readonly presence: PresenceService,
        @inject(TOKENS.OrderDeliveryService) private readonly orders: OrderDeliveryService,
        @inject(TOKENS.DeliveryService) private readonly deliveries: DeliveryService,
        @inject(TOKENS.DeliveryNotifierService) private readonly notifier: DeliveryNotifierService,
        @inject(TOKENS.AgentEarningService) private readonly earnings: AgentEarningService,
        @inject(TOKENS.WsPublisher) private readonly ws: WsPublisher
    ){}

    online = async (region: string, user: JwtPayload, data: PresenceRequestDTO): Promise<PresenceResponseDTO> => {
        await this.presence.markSeen(region, user.userId, data.lat, data.lng);
        return PresenceResponseDTO.from(true);
    }

    // every ~30 s; while carrying a picked order the customer sees the agent move
    ping = async (region: string, user: JwtPayload, data: PresenceRequestDTO): Promise<PresenceResponseDTO> => {
        if(!(await this.presence.getOnline(region, user.userId))){
            throw AgentNotOnlineError;
        }
        await this.presence.markSeen(region, user.userId, data.lat, data.lng);
        const active = await this.orders.findActiveByAgent(user.userId, db(region));       // Q-O6
        if(active?.status === OrderStatus.PICKED){
            this.ws.publish([Rooms.customer(active.customerId)], "delivery.position",
                {orderPublicId: active.publicId, lat: data.lat, lng: data.lng, ts: new Date().toISOString()});
        }
        return PresenceResponseDTO.from(true);
    }

    // a picked order can't be abandoned; an assigned one goes back to be offered to someone else
    offline = async (region: string, user: JwtPayload, correlationId: string): Promise<PresenceResponseDTO> => {
        const active = await this.orders.findActiveByAgent(user.userId, db(region));
        if(active?.status === OrderStatus.PICKED){
            throw AgentHasActiveDeliveryError;
        }
        if(active?.status === OrderStatus.ASSIGNED){
            await this.deliveries.release(active, user.userId, OrderActor.AGENT, "agent went offline", correlationId);
        }
        await this.presence.remove(region, user.userId);
        return PresenceResponseDTO.from(false);
    }

    // GET /agents/available-orders — ready orders within the radius of the agent's last ping, nearest first
    availableOrders = async (region: string, user: JwtPayload, correlationId: string): Promise<AgentTaskResponseDTO[]> => {
        const location = await this.presence.getOnline(region, user.userId);
        if(!location){
            throw AgentNotOnlineError;
        }
        const conn = db(region);
        const nearby = await this.orders.listReadyNear(location.lat, location.lng, env.delivery.radiusMeters, AVAILABLE_LIMIT, conn);
        const state = await this.notifier.offerState(region, nearby.map((order) => order.publicId));
        const visible = nearby
            .filter((order) => !state.get(order.publicId)?.declined.has(user.userId))
            .map((order) => ({order, distance: distanceMeters(location.lat, location.lng, order.pickupLat!, order.pickupLng!)}))
            .filter(({distance}) => distance <= env.delivery.radiusMeters)
            .sort((a, b) => a.distance - b.distance);
        const counts = await this.orders.countItems(visible.map(({order}) => order), conn);
        return visible.map(({order, distance}) =>
            AgentTaskResponseDTO.from(order, counts.get(order.id) ?? 0, {lat: order.pickupLat!, lng: order.pickupLng!}, distance));
    }

    // GET /agents/tasks?status= — the agent's orders this year, newest first
    tasks = async (region: string, user: JwtPayload, query: AgentTasksQueryDTO, correlationId: string): Promise<{data: AgentTaskResponseDTO[]; meta: PaginationMeta}> => {
        const limit = query.limit ?? DEFAULT_PAGE;
        const cursor = decodeCursor(query.cursor, isTaskCursor);
        if(query.cursor && !cursor) throw InvalidCursorError;
        const conn = db(region);
        const rows = await this.orders.listForAgent(user.userId, query.status, cursor ? {createdAt: new Date(cursor[0]), publicId: cursor[1]} : null, limit, conn);
        const page = rows.slice(0, limit);
        const [counts, pickups] = await Promise.all([this.orders.countItems(page, conn), this.orders.pickupOf(page, correlationId)]);
        const last = page[page.length - 1];
        const hasMore = rows.length > limit;
        return {
            data: page.map((order) => AgentTaskResponseDTO.from(order, counts.get(order.id) ?? 0, pickups.get(order.id) ?? null, null)),
            meta: {nextCursor: hasMore && last ? encodeCursor([last.createdAt.toISOString(), last.publicId]) : null, hasMore, count: page.length},
        };
    }

    // GET /agents/earnings?from=&to= — default: this month
    earningsOf = async (region: string, user: JwtPayload, query: AgentEarningsQueryDTO): Promise<AgentEarningsResponseDTO> => {
        const now = new Date();
        const to = query.to ? new Date(query.to) : now;
        const from = query.from ? new Date(query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        if(from.getTime() >= to.getTime()) throw InvalidDateRangeError;
        const range = {from, to: new Date(to.getTime() + 1)};
        const limit = query.limit ?? DEFAULT_PAGE;
        const state = decodeCursor(query.cursor, isEarningCursorState);
        if(query.cursor && !state) throw InvalidCursorError;

        // a range reaching into a prior year reads archive + hot (archival.md §6)
        const sources = readSourcesForRange(region, range);
        const [page, totalsPerSource] = await Promise.all([
            mergeKeysetPages<AgentEarning, EarningCursor>({
                sources,
                state: state ?? {},
                limit,
                fetch: (source, position) => this.earnings.page(user.userId, range,
                    position ? {earnedAt: new Date(position[0]), id: position[1]} : null, limit, source.conn),
                compare: (a, b) => b.earnedAt.getTime() - a.earnedAt.getTime() || b.id - a.id,
                identity: (row) => String(row.id),
                cursorOf: (row) => [row.earnedAt.toISOString(), row.id],
            }),
            Promise.all(sources.map((source) => this.earnings.totals(user.userId, range, source.conn))),
        ]);

        // order public ids: one batch lookup per source used (the order lives where its earning does)
        const publicIds = new Map<number, string>();
        await Promise.all(sources.map(async (source) => {
            const refs = page.rows.filter((row) => row.source === source).map(({row}) => ({id: row.orderId, createdAt: row.orderCreatedAt}));
            if(refs.length === 0) return;
            for(const order of await this.orders.findByRefs(refs, source.conn)) publicIds.set(order.id, order.publicId);
        }));
        const items: AgentEarningItemDTO[] = page.rows.map(({row}) => ({
            orderPublicId: publicIds.get(row.orderId) ?? null, amount: row.amount, currency: row.currency, earnedAt: row.earnedAt.toISOString(),
        }));
        const nextCursor = page.hasMore ? encodeCursor(page.nextState) : null;
        return AgentEarningsResponseDTO.from(range, sumTotals(totalsPerSource.flat()), items, nextCursor);
    }
}

function isTaskCursor(value: unknown): value is TaskCursor {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && !Number.isNaN(Date.parse(value[0])) && typeof value[1] === "string" && isUUID(value[1]);
}

function isEarningCursor(value: unknown): value is EarningCursor {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && !Number.isNaN(Date.parse(value[0])) && Number.isSafeInteger(value[1]);
}

function isEarningCursorState(value: unknown): value is SourceCursors<EarningCursor> {
    return isSourceCursors(value, isEarningCursor);
}

// totals of archive + hot, per currency. While the archiver is between its copy and its delete a
// batch can be in both and be counted twice for a moment (archival.md §6, accepted).
function sumTotals(rows: {currency: string; count: number; sum: number}[]): {currency: string; count: number; sum: number}[] {
    const byCurrency = new Map<string, {currency: string; count: number; sum: number}>();
    for(const row of rows){
        const total = byCurrency.get(row.currency) ?? {currency: row.currency, count: 0, sum: 0};
        total.count += row.count;
        total.sum += row.sum;
        byCurrency.set(row.currency, total);
    }
    return [...byCurrency.values()];
}
