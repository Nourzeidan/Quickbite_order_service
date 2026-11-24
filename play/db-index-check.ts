// Realistic index check for Q-O2 / Q-O3: inserts ~60k synthetic orders INSIDE a transaction,
// ANALYZEs, prints the plans, then ROLLS BACK (nothing is left behind).
//   npx tsx play/db-index-check.ts [region]
import {db, destroyAll} from "../src/lib/knex/knex.js";

const region = process.argv[2] ?? "eg";
const trx = await db(region).transaction();
try{
    await trx.raw(`
        INSERT INTO orders (region, public_id, country_code, restaurant_id, branch_id, customer_id, customer_address_id,
                            delivery_lat, delivery_lng, delivery_address_text_snapshot, status,
                            subtotal, delivery_fee, service_fee, total, currency, payment_method, created_at, updated_at)
        SELECT ?, gen_random_uuid(), 'EG', 1 + g % 200, 1000 + g % 500, 100000 + g % 6000, 1,
               30.0, 31.0, 'synthetic', (ARRAY['placed','accepted','preparing','delivered'])[1 + g % 4],
               1000, 500, 0, 1500, 'EGP', 'cod', ts, ts
        FROM generate_series(1, 60000) g,
             LATERAL (SELECT timestamp '2026-07-01' + (g * interval '3 minutes') AS ts) t`, [region]);
    await trx.raw("ANALYZE orders");

    const year = new Date().getUTCFullYear();
    for(const [title, sql, bindings] of [
        ["Q-O2 customer orders this year", `SELECT id FROM orders WHERE customer_id = ? AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC, public_id DESC LIMIT 21`, [100042, `${year}-01-01`, `${year + 1}-01-01`]],
        ["Q-O3 branch orders by status, one month", `SELECT id FROM orders WHERE branch_id = ? AND status = 'placed'
            AND created_at >= '2026-08-01' AND created_at < '2026-09-01' ORDER BY created_at DESC, public_id DESC LIMIT 21`, [1004]],
    ] as const){
        const {rows} = await trx.raw(`EXPLAIN ${sql}`, bindings as unknown as unknown[]);
        console.log(`\n=== ${title}`);
        for(const row of rows) console.log("  " + row["QUERY PLAN"]);
    }
}finally{
    await trx.rollback();
    await destroyAll();
    console.log("\n(rolled back: no synthetic rows kept)");
}
