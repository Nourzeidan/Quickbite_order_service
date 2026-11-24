import {Server} from "socket.io";
import {createAdapter} from "@socket.io/redis-adapter";
import {Redis} from "ioredis";
const pub = new Redis({host: "localhost", port: 6379});
const io = new Server(); io.adapter(createAdapter(pub, pub.duplicate()));
setTimeout(() => { io.to(process.argv[2]!).emit("test.event", {hi: "from another instance"}); setTimeout(() => process.exit(0), 500); }, 500);