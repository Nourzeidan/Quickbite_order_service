# Phase 5 walkthrough — Archival

Built 2026-11-24. This explains **what** was added and **why**, file by file, in the order an order travels from the hot cluster to the archive.
Rules and decisions (D1–D10): [business-logic/archival.md](business-logic/archival.md). Contracts: [api-contracts §1.3, §7](api-contracts.md).

Two questions get their own sections because they are the heart of this phase:
- **§5 — the locks** in `archival.repo.ts`: what each one protects and what goes wrong without it.
- **§6 — why order ids are UUIDv7 and not UUIDv4**: the reason archival (and every order lookup) can find the right month without a query.

---

## 0. The idea in one picture

```
                    every night, 00–05 UTC, one region at a time
                                       │
  hot  order_service_eg                ▼                       archive  order_service_archive_eg
 ┌──────────────────────────┐   1 pick  ──►  2 load   ┌──────────────────────────┐
 │ orders 2026-…  (live)    │                         │                          │
 │ orders 2025-03 ──────────┼──► 3 copy (1 archive trx)──► orders 2025-03         │
 │   + items, sessions,     │   4 verify: rows identical? ◄─┤ + items, sessions,   │
 │     transactions,        │                         │     transactions,        │
 │     agent_earnings       │◄── 5 guarded delete (1 hot trx: lock, re-read,      │
 │                          │       compare, delete)  │     agent_earnings       │
 │ partition emptied? ──────┼──► 6 DROP the partition │                          │
 └──────────────────────────┘                         └──────────────────────────┘
            ▲                                                    ▲
            └──── API: current year → hot · prior year → archive + hot, merged ──┘
```

In one sentence: **copy first, prove the copy, only then delete** — because the two clusters are different databases and no single transaction can cover both.

At every moment a row is in hot, in the archive, or (briefly) in both — **never in neither**.

---

## 1. A third process: the archiver

**Why:** you asked for it (D7). The worker's jobs are short and time-critical — the offer job runs every 10 s, the payment sweep cancels unpaid orders. Archival is the opposite: long (up to ~100k orders a night), heavy (big reads, copies, deletes), never urgent. In the same process it would compete for the DB pools and Node's event loop, and an offer could arrive late.

| File | What it does |
|---|---|
| `src/archiver.ts` | The entry point. `npm run archiver` → an interval job every `ARCHIVE_INTERVAL_MIN` (60) that only works inside `ARCHIVE_WINDOW_UTC` (`0-5`). `npm run archive:once` → one pass now, ignoring the window, prints one JSON line per region (`{"archivalReport": …}`) and exits. Shutdown stops the job and closes pools; a batch cut off mid-way is finished by the next run (§4.2). |
| `package.json` | scripts `archiver`, `start:archiver`, `archive:once` |
| `src/lib/di/tokens.ts`, `container.ts` | `TOKENS.ArchivalService` → `ArchivalService` |

```
npm run dev        API + socket.io + core-events consumer     (serves requests)
npm run worker     offers · payment sweep · partitions · idempotency cleanup
npm run archiver   archival only                               ← new
```

---

## 2. The archive cluster

| File | Change | Why |
|---|---|---|
| `src/lib/config/env.ts` | `ARCHIVE_DB_<region>_*` **required** (was optional); `ARCHIVE_INTERVAL_MIN`, `ARCHIVE_WINDOW_UTC`, `ARCHIVE_BATCH_SIZE` (500), `ARCHIVE_MAX_BATCHES_PER_RUN` (200), `ARCHIVE_MIN_AGE_DAYS` (30), `ARCHIVE_STUCK_ALERT_DAYS` (60), `ARCHIVE_TEST_PAUSE_MS` (dev only, forced to 0 in production) | prior-year reads need the archive from day one (D10) |
| `.env.example` | the names above | |
| local Postgres | databases `order_service_archive_eg`, `order_service_archive_ksa` on the **same server** | pg_partman's SQL-only files are already in this server's `share/extension` |
| `npm run migrate:archive` | runs **every** migration on the archive databases | identical schema = the same repositories work on both clusters |

The archive's `orders` / `order_items` are partitioned too (same migrations). pg_partman only premakes **future** months, so the archiver creates past months on demand (`ensureMonthPartition` → `partman.create_partition_time`). Partition maintenance never runs on the archive.

**Schema guard** — `ArchivalService.checkSchema`: before the first batch of a region, the column list of every archived table is read from `information_schema` on both clusters. Different → the region stops with `run npm run migrate:archive`. Without this, a column added by a new migration on hot but not yet on the archive would be silently dropped by the copy.

---

## 3. Which orders move

`src/app/archival/repository/archival.repo.ts`:

| Function | Query | Why this way |
|---|---|---|
| `listMonthPartitions` (Q-X5) | `partman.show_partitions` × `show_partition_info` → name + start/end of each month | the archiver walks **one partition at a time**, oldest first; only months that end before Jan 1 |
| `findArchiveCandidates` (Q-X2) | `FROM orders_p20250301 WHERE created_at < cutoff AND status IN (delivered, cancelled, rejected) AND updated_at < now − 30 days AND id > :afterId ORDER BY id LIMIT 500` | queries the **partition table itself**, so only that month is read; `ORDER BY id` walks its PK; keyset by id so ineligible rows are stepped past, never re-read |
| `findOrdersWithOpenMoney` (Q-X6) | one `UNION`: pending ledger rows (except `refund-shortfall:*`) + open payment sessions, `WHERE order_id = ANY(:500 ids)` | **one** query for the whole batch — no N+1 |

Eligibility (archival.md §3) in plain words: **nothing can still change it.**

| Rule | What breaks without it |
|---|---|
| terminal status | an agent or the restaurant could still move it |
| untouched 30 days | an order delivered Dec 31 could not be refunded on Jan 2 |
| no pending ledger row | a refund waiting for Kashier's webhook would lose its row |
| no open session | a late payment webhook would find nothing |
| shortfalls don't block | a `refund-shortfall` is a permanent "owed" record nothing processes; blocking on it would keep the order hot forever |

Orders that fail a rule stay hot, are retried every night, and are reported as `ALERT archival.stuck_orders` (count + 20 public ids) once `ARCHIVE_STUCK_ALERT_DAYS` have passed since Jan 1.

---

## 4. Moving one batch — `ArchivalService.moveOrderBatch`

`src/app/archival/service/archival.service.ts`, steps numbered as in the design:

```
2. load      loadOrderRows(ids, range, hot)                     5 indexed queries (Q-X1)
3. months    ensureMonthPartition(orders / order_items, month, archive)
4. copy      ONE archive trx: upsertRows × 5 tables (FK order)
5. verify    loadOrderRows(ids, range, archive) === what was copied?   no → ArchiveVerifyError, region stops, hot untouched
6. delete    ONE hot trx: lockOrderRows → loadOrderRows again → same? → deleteOrderRows : rollback ("changed")
   after     orderCache.invalidateMany(batch)                   one Redis DEL for the batch
```

### 4.1 How rows are copied without changing them

```sql
-- read (hot)
SELECT row_to_json(t) AS row FROM transactions t WHERE order_id = ANY(?) AND order_created_at >= ? AND order_created_at < ?

-- write (archive)
INSERT INTO transactions (<every column>)
SELECT <every column> FROM json_populate_recordset(NULL::transactions, ?::json)
ON CONFLICT (id) DO UPDATE SET <every other column> = EXCLUDED.<column>
```

Why JSON instead of the usual `*_COLUMNS` + entities:
- **No JS conversion.** Going through JS `Date` would hit the bug noted in `pkg/utils/time.ts`: node-pg sends a `Date` with a local offset and Postgres ignores the offset on a `TIMESTAMP` column → every archived time would move by 2 hours. JSON keeps `"2025-03-10T10:00:00.354"` exactly as stored; BIGINT, DECIMAL and JSONB are untouched too.
- **Column list from the catalogue**, not a hand-written constant, so the copy can't forget a column (and `checkSchema` proves both sides have the same ones).
- `ON CONFLICT … DO UPDATE` (D4): a batch copied twice (after a crash, or after "changed") **refreshes** the archive instead of keeping a stale row.

`range` = `[min created_at, max created_at + 1 ms)` of the batch, so every query prunes `orders` / `order_items` to the batch's partition(s).

### 4.2 Why it's safe to crash anywhere

| Crash after… | State | Next run |
|---|---|---|
| step 4 (archive committed) | rows in both, identical | copies again (upsert = same values), verifies, deletes from hot |
| step 6 rolled back ("changed") | rows in both, archive a bit older | copies again (upsert refreshes), deletes |
| step 6 committed | rows only in the archive | not in hot anymore → never picked again |

Re-running with nothing left to move = one cheap candidate query per partition. That is the acceptance rule "re-running is a no-op", checked by the suite.

### 4.3 Deleting

`deleteOrderRows`: `agent_earnings` → `transactions` **refunds first** (a refund points at its charge through `refunded_payment_id`) → `transactions` → `payment_sessions` → `orders` (`order_items` go with `ON DELETE CASCADE`).

### 4.4 Rows without an order — `moveOrderless`

Payouts (`transactions WHERE order_id IS NULL`, Q-X3) and `payment_webhook_events` (Q-X4), older than `min(Jan 1, now − 30 days)`: the same copy → verify → lock → re-read → delete, by id. Both queries got an index in `20261124100000_add_archival_indexes.ts`; without them the nightly query is a full scan of two of the biggest tables.

That migration uses `CREATE INDEX CONCURRENTLY` (doesn't block writes while building) — which Postgres refuses inside a transaction, hence `export const config = {transaction: false}`.

### 4.5 Dropping emptied months

When a prior-year month has no rows left in hot (`isTableEmpty` on both `orders_pYYYYMM01` and `order_items_pYYYYMM01`), `dropMonthPartitions` detaches and drops them (items first: they reference orders). A `DELETE` only marks rows dead — the disk comes back after VACUUM; `DROP TABLE` returns it at once. This is where monthly partitioning pays off.

---

## 5. The locks in `archival.repo.ts`

A **lock** is a promise between transactions: "until I'm done, you wait (or give up)". The archival repo uses three different kinds, each for a different race.

| # | Lock | Where | Protects against |
|---|---|---|---|
| 1 | **advisory lock** (a named mutex) | `withAdvisoryLock`, line 239 | two archivers working on the same region |
| 2 | **row locks** `SELECT … FOR UPDATE` | `lockOrderRows` line 154, `lockRowsById` line 187 | a refund / webhook / settlement changing an order while it is being deleted |
| 3 | **`lock_timeout`** on a table lock | `dropMonthPartitions` line 81 | the partition drop freezing every query on `orders` |

### 5.1 The advisory lock — one archiver per region

```ts
// archival.repo.ts:239
const connection = await client.acquireConnection();               // pin ONE pooled connection
SELECT pg_try_advisory_lock(hashtext('archival:eg'))               // true = mine, false = someone has it
  … the whole run …
SELECT pg_advisory_unlock(hashtext('archival:eg'))                 // on the SAME connection
client.releaseConnection(connection)
```

- **What it is:** a lock on a *number* (`hashtext('archival:eg')`), not on a table or row. It locks no data at all; it only works because every archiver agrees to ask for it first. Think of a "room occupied" sign.
- **Why:** you may run two archivers (two machines, or `npm run archiver` + `npm run archive:once`). Both would pick the same 500 orders and copy / delete them at the same time. Correct in the end (upserts, guarded deletes) but double work and confusing reports. With the lock the second one gets `false` and reports `skipped: "locked"` — the suite tests exactly this.
- **`try`, not wait:** `pg_try_advisory_lock` returns immediately. Waiting would make the second archiver sit idle for minutes.
- **Why a session lock on a pinned connection:** a *session* advisory lock belongs to the connection that took it, and only that connection can release it. Knex normally runs each query on whichever pool connection is free, so the lock and the unlock could land on different connections. `acquireConnection()` pins one; `.connection(connection)` sends both queries through it. The batches themselves run on other pool connections — the lock is just held.
- **Why not a transaction lock** (`pg_try_advisory_xact_lock`): it is released at commit, so the transaction would have to stay open for the whole run (minutes). A long-open transaction stops VACUUM from cleaning dead rows on the **entire shard**. The session lock holds nothing open.
- **If the archiver crashes:** the connection closes and Postgres releases the lock by itself. No stale lock to clean up.

### 5.2 Row locks — the guarded delete

The race it closes (step 6 in §4):

```
time   archiver (hot)                              admin refund on order R
 ─┬─   copies R to the archive (charge only)
  │                                                locks R's charge  (SELECT … FOR UPDATE)
  │                                                inserts a refund row, commits
  │    deletes R's transactions                    ← WITHOUT a guard: the refund row is deleted
  ▼                                                  and it was never copied = money record LOST
```

With the guard, the hot transaction of step 6 does:

```ts
await lockOrderRows(ids, range, trx);        // 1. orders FOR UPDATE, then transactions, then payment_sessions
const current = await loadOrderRows(...);    // 2. a NEW statement re-reads everything
if (!same(copied, current)) → rollback       // 3. something changed → "changed", next run redoes the batch
else deleteOrderRows(...)                    // 4. nothing changed → delete; nobody can change it now
```

Three details matter:

1. **`FOR UPDATE` makes others wait.** While the archiver holds the locks, a refund that wants R's charge waits; when the archiver commits, the charge is gone and the refund gets `404 Payment not found`. Or the refund was first: the archiver waits for it, then sees the new row in step 2.
2. **Why re-read in a *new* statement.** Postgres runs at READ COMMITTED: each statement sees the data committed **when that statement started**. A `SELECT … FOR UPDATE` that waited for the refund to commit re-checks the rows it locked, but it does **not** see the brand-new refund row (it didn't exist when the statement started). The next statement starts later and does see it. That is why the code locks first and compares with a second query.
3. **Lock order: order row first, then transactions** — the same order as the settlement and the refund webhook (Phase 4 rule). If one transaction locked A→B and another B→A, each could wait for the other forever (a deadlock; Postgres kills one after a second). Same order everywhere = no deadlock. `ORDER BY id` inside each lock query keeps the order stable within a table too.

The suite stages this race for real: the archiver is paused between copy and delete (`ARCHIVE_TEST_PAUSE_MS`), a refund is inserted, and the run must report `batchesChanged ≥ 1` with the refund still hot — then the next run archives the order **with** the refund.

### 5.3 `lock_timeout` — dropping a partition without an outage

`ALTER TABLE orders DETACH PARTITION …` needs an **ACCESS EXCLUSIVE** lock on `orders` — the strongest lock, nobody else may even read. It only takes milliseconds, but:

```
long report query on orders  ─────────────────────────►
archiver DETACH                  waits for it ……………………
every new order query                 waits behind the archiver ……  ← the whole API stalls
```

A waiting ACCESS EXCLUSIVE request blocks everyone who arrives after it. `SET LOCAL lock_timeout = '2s'` (for this transaction only) makes the drop give up after 2 s; it is logged as `partition drop skipped` and retried next night. (`DETACH … CONCURRENTLY` avoids the strong lock, but Postgres forbids it inside a transaction and on a table with a default partition — we have one.)

---

## 6. Why order ids are UUIDv7, not UUIDv4

Both are 128-bit random-looking ids. The difference is the first 48 bits:

```
UUIDv4  3f9a2c71-8b4e-4d2a-9c1f-…   122 random bits — says nothing
UUIDv7  01957f7f-3e62-747c-bc62-8110eba3ac0b
        └──────┬─────┘ └ version 7
        48-bit Unix time in ms: 0x01957f7f3e62 = 1741600800354 = 2025-03-10T10:00:00.354Z
```

(That id is a real one from the Phase 5 test run — staged order A.)

### 6.1 What v7 gives this project

| Need | With UUIDv4 | With UUIDv7 (what we do) |
|---|---|---|
| **Find an order by public id in a partitioned table** | the id says nothing about the month → Postgres searches **every** monthly partition (24+ index lookups after two years) | `created_at` is **derived from the id** on insert (`order.repo.ts:64`, `uuid_extract_timestamp`), so a lookup by id also filters on `created_at` → **one** partition (Q-O1) |
| **Unique public id on a partitioned table** | a UNIQUE index on a partitioned table must include the partition key, so `UNIQUE (public_id, created_at)` would *not* stop the same id appearing in two months | `created_at` is a function of `public_id`, so `(public_id, created_at)` unique ⇔ `public_id` unique (comment in `create_orders_table.ts`) |
| **Which cluster has this order?** (Phase 5) | unknown → ask hot, then archive, for **every** detail request | the year is in the id → `timeOfUuidV7` (`pkg/utils/uuid.ts`) answers before any query: current year → hot through the cache; prior year → archive then hot (`order.service.ts:348`). The webhook uses it too (`webhook.service.ts:153`) to tell "archived order" from "unknown session". |
| **Index write cost** | random ids land on random B-tree pages: page splits, cache misses, bloat at 93 writes/s | ids grow with time: new entries go to the right edge of the index, like a sequence |
| **Sorting / cursors** | no meaning | roughly creation order (lists still sort by `created_at, public_id` explicitly) |

### 6.2 The trade-off

A v7 id **reveals when the order was created**. For orders that's fine — `createdAt` is in every API response anyway. Don't use v7 where the creation time is a secret (e.g. a password-reset token); those should stay random (v4).

Why not just expose the bigserial `id`? It reveals **how many** orders exist and lets anyone guess the next one (`/orders/1001`, `/orders/1002`…). The rule since Phase 1: internal bigserial ids never leave the service; the public id is a UUID.

---

## 7. Reads: prior year = archive + hot

**Why both and not "archive only"** (D3): a prior-year order can still be hot — in its 30-day grace (all of January for December orders), stuck (§3), or mid-batch. "Archive only" would make real orders disappear from the API.

| File | What it does |
|---|---|
| `src/lib/knex/read-sources.ts` | `readSourcesForRange(region, {from})`: range touches a prior year → `[archive, hot]`, else `[hot]`. A *source* = `{key: "eg" \| "eg:archive", conn}`. |
| `src/lib/http/pagination/keyset-merge.ts` | `mergeKeysetPages`: one query per source (parallel), merge newest first, keep `limit`, **drop a row seen twice** (same `publicId` / `id` in both clusters), move each source's cursor past exactly the rows it gave. Generalised from the admin `X-Region: all` merge you already had. |
| `src/pkg/utils/uuid.ts` | `timeOfUuidV7` (§6) |

The cursor now holds one position per source:

```json
{ "eg:archive": ["2025-03-10T10:00:00.354Z", "01957f7f-…"],   ← last archive row shown
  "eg": "end" }                                                ← hot has nothing more
```

| Endpoint | Change |
|---|---|
| `GET /customer/orders?year=`, `/restaurant/orders`, `/admin/orders` (`order.service.ts`) | `list(sources, …)` via `mergeKeysetPages`; item counts: one grouped query per source |
| `GET /orders/:publicId` | current year: hot + 5 s cache, as before. Prior year: archive, then hot, **no cache** (rare reads; the archiver moves these rows). The payment summary is read from the cluster the order was found on. |
| `GET /agents/earnings` (`agent.service.ts`) | page merged; totals = hot sum + archive sum (`sumTotals`) |
| `GET /restaurant/payouts` (`finance.service.ts`) | merged — the default 90 days reach into last year until April |
| `GET /payments/:id` (`payment.service.ts`) | the id has no date → hot, then archive |
| `GET /health` | `archiveShards: [{region, ok}]` — reported, never fails the check |

**Known trade-off (§6 of the design):** the earnings *total* adds hot + archive, so a batch present in both is counted twice — for milliseconds normally, or **until the next run** if the archiver crashed between copy and delete. Display only, never a money decision. The suite checks it on purpose.

---

## 8. Writes on archived orders

Writes always go to hot, so an archived order is simply "not found":

| Action | Result |
|---|---|
| status change, delivery accept / status | existing **404** `Order not found` |
| refund of an archived charge | existing **404** `Payment not found` (refunds are possible during the 30-day grace) |
| late Kashier webhook | **200** (so Kashier stops retrying), event recorded with `process_error = "order archived"` (`webhook.service.ts`) |

No new error messages.

**Known limit:** the archive keeps the unique constraints. If a client reuses an `Idempotency-Key` for a payout / admin refund a year later, archiving the second row hits the unique `idempotency_key`; that region's run stops with `ALERT archival failed` and nothing is deleted from hot.

---

## 9. Tests — `play/phase5-e2e.ts` (38/38)

There is no real 2025 data, so the suite **stages** it on hot eg: creates 2025 month partitions, copies real delivered orders of this year (every child row) under new ids, 2025 UUIDv7 ids (`uuidv7({msecs})`) and 2025 times, plus a 2025 payout and webhook event. Then it starts `src/archiver.ts --once` as a child process — the real code path.

| Order | Setup | Expected |
|---|---|---|
| A | online, with a refund | archived, identical |
| B | COD | archived |
| G | already in the archive with a stale value (crash leftover) | archived; stale value overwritten |
| R | a refund inserted while the archiver is paused between copy and delete | 1st run: delete rolled back; 2nd run: archived **with** the refund |
| F | pending `refund-shortfall` | archived (shortfalls don't block) |
| C | refund sent, waiting for Kashier | stays hot |
| D | still `ready` | stays hot |
| E | touched 5 days ago | stays hot |

Also: a 2nd archiver at the same time → `skipped: locked`; emptied months dropped, June kept; stuck orders reported; balances untouched; detail / lists / earnings / payouts / payment identical before and after; writes → 404; late webhook → 200; a 3rd run moves nothing.

**Lessons from writing it:**
1. A staged refund "reserved, never sent" was **sent by the running worker's refund sweep**, rejected by the Kashier sandbox, marked `failed` — and the order became legitimately archivable. Staged pending refunds now have `provider_requested_at` set (sent, waiting), which the sweep never resends.
2. The earnings total counted the G leftover twice — which widened the documented trade-off from "milliseconds" to "until the next run".

Regression after the change: ws 16/16, Phase 2 32/32, Phase 3 44/44, Phase 4 39/39.

---

## 10. How to run

```powershell
npm run migrate            # hot shards (adds the 2 archival indexes)
npm run migrate:archive    # archive shards (the archiver refuses to run if columns differ)

npm run archiver           # the nightly process (works 00–05 UTC)
npm run archive:once       # one pass now
npx tsx play/phase5-e2e.ts # the suite (API + worker + core running; it starts the archiver itself)
```

---

## 11. Glossary

| Term | Meaning here |
|---|---|
| hot cluster | `order_service_<region>` — the live database |
| archive cluster | `order_service_archive_<region>` — prior years, same schema, written only by the archiver |
| batch | ≤ 500 orders of one month moved together |
| upsert | `INSERT … ON CONFLICT DO UPDATE`: insert, or overwrite if the row is already there |
| advisory lock | a lock on a number, not on data; a mutex the archivers agree to use |
| `FOR UPDATE` | "lock these rows until my transaction ends; anyone who wants to change them waits" |
| READ COMMITTED | each statement sees what was committed when *that statement* started |
| ACCESS EXCLUSIVE | the strongest table lock: no reads, no writes, while it is held |
| source | one connection a read uses (`eg`, `eg:archive`); cursors keep one position per source |
| UUIDv7 | a UUID whose first 48 bits are the creation time in ms |
