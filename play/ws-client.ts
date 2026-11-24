import {io} from "socket.io-client";
const [token, room] = process.argv.slice(2);
const s = io("http://localhost:4000", {path: "/ws", auth: {token}});
s.on("connect_error", (e) => console.log("connect_error:", e.message));
s.on("hello", (m) => { console.log("hello", m); s.emit("subscribe", room, (r: unknown) => console.log("subscribe", room, r)); });
s.on("test.event", (m) => console.log("RECEIVED", m));