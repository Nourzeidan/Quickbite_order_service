import {logger} from "../logger/logger.js";

// what both a socket.io Server (API) and a @socket.io/redis-emitter Emitter (worker) offer
export interface RoomEmitter {
    to(rooms: string | string[]): {emit(event: string, ...args: any[]): unknown};
}

// room names (ws-auth.ts permits them per role)
export const Rooms = {
    customer: (userId: number) => `customer:${userId}`,
    branch: (branchId: number) => `branch:${branchId}`,
    restaurant: (restaurantId: number) => `restaurant:${restaurantId}`,
    agent: (agentId: number) => `agent:${agentId}`,
};

// The one way services emit realtime events (realtime.md §4):
//  - call it AFTER commit only;
//  - payloads are response DTOs or documented subsets, never entities;
//  - a failure is logged and swallowed: the state is committed, clients can re-fetch.
// The socket.io server is created after the DI container (it needs the http server), so it is bound
// at boot: server.ts binds the API's socket.io server, worker.ts a Redis emitter (same Redis channel,
// so its events reach sockets on every API instance). Unbound (scripts, tests) = emits are dropped.
export class WsPublisher {
    private io: RoomEmitter | null = null;

    bind = (io: RoomEmitter) => {
        this.io = io;
    }

    publish = (rooms: string[], event: string, payload: unknown) => {
        if(!this.io || rooms.length === 0){
            return;
        }
        try{
            this.io.to(rooms).emit(event, payload);
        }catch(err){
            logger.warn("ws emit failed", {event, rooms, error: (err as Error).message});
        }
    }
}
