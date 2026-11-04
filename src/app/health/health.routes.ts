import {Router} from "express";
import {pingAll} from "../../lib/knex/knex.js";

export const healthRouter = Router();

// every hot shard must answer; archive shards are not checked (they may not exist before Phase 7)
healthRouter.get("/health", async (req, res) => {
    const shards = await pingAll();
    const ok = shards.every((shard) => shard.ok);
    res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "error",
        shards: shards.map(({region, ok}) => ({region, ok})),
    });
});
