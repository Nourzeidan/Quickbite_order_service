import type {Server as HttpServer} from "http";
import {Server} from "socket.io";
import {createAdapter} from "@socket.io/redis-adapter";
import {SecsToMS} from "../../pkg/utils/time.js";
import {env} from "../config/env.js";
import {logger} from "../logger/logger.js";
import {cacheProvider} from "../cache/init.js";
import {authenticateHandshake, permittedChannels} from "./ws-auth.js";

// socket.io on /ws with the Redis adapter: io.to(room).emit(...) on any instance reaches the
// socket wherever it is connected. The shared Redis connection publishes; a duplicate() subscribes
// (an ioredis connection in subscribe mode can't run other commands).
export function attachWsServer(httpServer: HttpServer): Server {
    const redis = cacheProvider.getClient();
    const io = new Server(httpServer, {
        path: "/ws",
        serveClient: false,
        pingInterval: SecsToMS(env.ws.heartbeatSec),
        cors: {origin: env.cors.origin, credentials: true},
    });
    io.adapter(createAdapter(redis, redis.duplicate()));

    io.use((socket, next) => {
        try{
            const user = authenticateHandshake(socket.handshake);
            socket.data.user = user;
            socket.data.allowed = permittedChannels(user);
            next();
        }catch(err){
            next(err as Error);
        }
    });

    io.on("connection", (socket) => {
        const allowed: Set<string> = socket.data.allowed;
        const userId: number = socket.data.user.userId;
        socket.emit("hello", {allowedChannels: [...allowed]});

        socket.on("subscribe", async (channel: unknown, ack?: (res: unknown) => void) => {
            if(typeof channel !== "string" || !allowed.has(channel)){
                ack?.({ok: false, error: "not permitted"});
                return;
            }
            await socket.join(channel);
            ack?.({ok: true});
            socket.emit("subscribed", {channel});
        });

        socket.on("unsubscribe", async (channel: unknown) => {
            if(typeof channel === "string"){
                await socket.leave(channel);
            }
        });

        socket.on("disconnect", (reason) => {
            logger.info("ws disconnected", {userId, reason});
        });
    });

    return io;
}
