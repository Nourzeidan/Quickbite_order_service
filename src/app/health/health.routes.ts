import {Router} from "express";
import {pingAll, pingAllArchives} from "../../lib/knex/knex.js";

export const healthRouter = Router();

// every hot shard must answer. Archive shards are reported but never fail the check: when one is
// down only prior-year reads fail (archival.md §8)
healthRouter.get("/health", async (req, res) => {
    const [shards, archiveShards] = await Promise.all([pingAll(), pingAllArchives()]);
    const ok = shards.every((shard) => shard.ok);
    res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "error",
        shards: shards.map(({region, ok}) => ({region, ok})),
        archiveShards: archiveShards.map(({region, ok}) => ({region, ok})),
    });
});
