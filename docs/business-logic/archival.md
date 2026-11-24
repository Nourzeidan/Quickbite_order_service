# Archival (Phase 5)

> **Status: BUILT (2026-11-24)** — all decisions D1…D10 accepted (D7 changed to a **separate `npm run archiver` process**, §4). `play/phase5-e2e.ts` 38/38 (§12).

Walkthrough (what/why file by file, the locks, UUIDv7): [../phase-5-walkthrough.md](../phase-5-walkthrough.md). Code: `src/archiver.ts` (the process), `src/app/archival/` (service + repository), year-aware reads in `order`, `agent`, `payment`, `restaurant-finance`. Clusters: hot `order_service_<region>` → archive `order_service_archive_<region>`.

## 1. What problem this solves

PRD: *only the current year is queryable from the hot database; older data moves to other storage.* At ~146 GB of orders a year, keeping every year in the hot cluster makes indexes, backups and VACUUM grow forever. Archival moves **finished, prior-year orders and everything attached to them** to a cold cluster with the **same schema**, and the read endpoints learn to look there.

```
            hot cluster (order_service_eg)                    archive cluster (order_service_archive_eg)
  ┌───────────────────────────────────────────┐          ┌───────────────────────────────────────────┐
  │ orders 2026-01 … 2026-12 (+4 premade)     │          │ orders 2025-01 … 2025-12                   │
  │ orders 2025-12  ← being moved             │ ───────► │ order_items / payment_sessions /           │
  │ restaurant_balances (never moves)         │  worker  │ transactions / agent_earnings /            │
  │ idempotency_keys (own cleanup job)        │  batches │ payment_webhook_events of those years      │
  └───────────────────────────────────────────┘          └───────────────────────────────────────────┘
                ▲                                                      ▲
                └──────── API reads: current year → hot only; prior year → archive + hot (merged) ─┘
```

## 2. What moves, what stays

| Table | Moves? | Rule |
|---|---|---|
| `orders` | yes | `created_at < Jan 1 of the current year (UTC)` **and** eligible (§3) |
| `order_items` | yes | with its order (same batch) |
| `payment_sessions` | yes | with its order |
| `transactions` with an `order_id` | yes | with its order (charge, refunds, commission, COD, adjustments) |
| `agent_earnings` | yes | with its order |
| `transactions` **without** an order (payouts, non-order adjustments) | yes | `created_at < cutoff − ARCHIVE_MIN_AGE_DAYS`, on their own (§5.3) |
| `payment_webhook_events` | yes | `received_at < cutoff − ARCHIVE_MIN_AGE_DAYS` (audit trail for money disputes) |
| `restaurant_balances` | **no** | running totals, not history (system-design §10.4) |
| `idempotency_keys` | **no** | already deleted by `idempotency-cleanup` after their TTL |
| `payment_providers` | **no** | lookup table, same rows on every cluster (migrations seed it) |

Ids are copied **as they are** (the bigserial values). The archive never creates rows of its own, so its sequences are never used and ids can't collide.

## 3. Which orders may move ("eligible")

An order moves only when **nothing can still change it**:

| Check | Why |
|---|---|
| `created_at < Jan 1 of this year` | the PRD rule |
| `status IN ('delivered','cancelled','rejected')` | terminal: no worker, agent or restaurant acts on it anymore |
| `updated_at < NOW() − ARCHIVE_MIN_AGE_DAYS` (default **30**) | a grace period: an order delivered on Dec 31 can still be refunded in January while it's hot |
| no `transactions` row with `status = 'pending'`, **except** `refund-shortfall:*` adjustments | a pending refund waits for a Kashier webhook, so it must stay hot. Shortfalls are a permanent "owed" record that nothing processes, so they can move |
| no `payment_sessions` with `status IN ('initialized','pending')` | an open session could still get a webhook |

Ineligible prior-year orders **stay hot** and the job tries again the next night. If one is still there 60 days after the cutoff, the job logs `archival.stuck_orders` (count + ids) so an admin can look. Reads still find it (§6), so nothing breaks while it waits.

## 4. When it runs

- In its **own process**, `npm run archiver` (`src/archiver.ts`), not in `npm run worker`. The worker's jobs are short and time-critical (offers every 10 s, the payment sweep); archival is long, heavy and never urgent, so it gets its own process, DB pools and event loop and can never delay an offer. Inside it: `startIntervalJob("archival", ARCHIVE_INTERVAL_MIN, archivalService.run)`.
- It only does work inside a night window, `ARCHIVE_WINDOW_UTC=0-5` (02:00–07:00 Egypt, 03:00–08:00 KSA). Outside the window a tick returns at once.
- Each tick processes at most `ARCHIVE_MAX_BATCHES_PER_RUN` batches per region, so one run never holds the worker for hours.
- **One archiver per region:** the run takes `pg_try_advisory_lock(hashtext('archival:<region>'))` on the hot shard. A second worker instance gets `false` and skips that region. This is the same idea as pg_partman's maintenance lock.
- `npm run archive:once` (new script) runs one pass immediately, ignoring the window. It's for tests and for ops after an outage.

Most nights between March and December there's nothing eligible, and a tick costs one cheap query per region.

## 5. How one batch moves — copy → verify → delete

The two clusters are **different databases**, so there is no transaction that covers both. Safety comes from the order of the steps: **a row is deleted from hot only after it has been proven to be in the archive.** At every moment, a row is in hot, in the archive, or briefly in both — never in neither.

```mermaid
sequenceDiagram
    participant W as archival worker
    participant H as hot (db(region))
    participant A as archive (dbArchive(region))
    W->>H: 1. pick ≤ 500 candidate orders of month M (keyset by id) + drop ineligible ids (§3)
    W->>H: 2. load children: items, sessions, transactions, earnings (one whereIn each, Q-X1)
    W->>A: 3. ensure partitions for month M exist (partman.create_partition_time)
    W->>A: 4. ONE archive trx: upsert orders → items → sessions → transactions (by id) → earnings
    W->>A: 5. verify: count per table for these order ids = what was copied
    W->>H: 6. ONE hot trx: lock orders + transactions FOR UPDATE, re-read, compare with the copy
    alt identical
        W->>H: delete earnings → transactions (refunds first) → sessions → orders (items cascade); commit
    else something changed in between
        W->>H: rollback; the batch is copied again next tick (upsert refreshes the archive)
    end
```

### 5.1 Step by step

1. **Pick candidates (Q-X2).** `orders WHERE created_at >= M AND created_at < M+1 month AND id > :lastId AND status IN (terminal) AND updated_at < :minAge ORDER BY id LIMIT 500`. Because of the `created_at` range, Postgres reads **only the month-M partition**, and `ORDER BY id` walks the PK `(id, created_at)`. No new index is needed.
   Then **one** query per check finds the ineligible ids among those 500 (pending transactions, open sessions: `WHERE order_id = ANY(:ids)`), and they're dropped from the batch. That's never a query per order (no N+1).
2. **Load children.** Four `whereIn` queries (Q-X1), the same pattern as `order_items` in the list endpoints.
3. **Archive partitions.** The archive runs the same migrations, so its `orders` / `order_items` are partitioned too. pg_partman only premakes *future* months, so before copying month M the worker calls `SELECT partman.create_partition_time('public.orders', ARRAY[:M])` (and the same for `order_items`). If the partition already exists, the call does nothing.
4. **Copy in one archive transaction.** Insertion follows FK order: orders → order_items → payment_sessions → transactions sorted by id (a refund always has a higher id than the charge its `refunded_payment_id` points to) → agent_earnings. Every insert is `ON CONFLICT (<pk>) DO UPDATE SET <all columns>`, so a re-run **overwrites with the latest hot values** instead of failing or keeping a stale copy.
5. **Verify.** One `count(*) … GROUP BY` per table on the archive for these order ids must equal the number of rows copied. A mismatch → log + stop this region for this run (hot is untouched, nothing lost).
6. **Delete from hot, guarded.** In one hot transaction:
   - `SELECT … FROM orders WHERE (id, created_at) IN (…) FOR UPDATE`, then `transactions … FOR UPDATE`. Lock order: **order row first, then transactions** — the project-wide rule, so this can't deadlock with settlement or the refund webhook.
   - **Re-read** the children with a *new* statement (in READ COMMITTED, a statement that had to wait for a lock still uses its old snapshot; a fresh SELECT sees what the other transaction just committed) and compare them with what was copied.
   - Identical → `DELETE` agent_earnings, transactions (refunds before charges, because of the self-FK), payment_sessions, orders (`order_items` go with `ON DELETE CASCADE`). Commit.
   - Different → rollback. Example: an admin refund on that charge committed between steps 2 and 6. Next tick the batch is copied again with the new refund row, and then deleted.
   - After the commit, the 5 s order cache entries for those publicIds are dropped (one `DEL` with every key, not one call per order).

### 5.2 Why this is idempotent and crash-safe

| Crash after… | State | Next run |
|---|---|---|
| step 4 (archive commit) | rows in both clusters, identical | copies again (upsert = no change), verifies, deletes from hot |
| step 6 rollback | rows in both | same as above |
| step 6 commit | rows only in the archive | they're no longer in hot, so they're never picked again |

Re-running the job with nothing left to move only runs the cheap candidate query and does nothing else. This is the acceptance rule "re-running the worker is a no-op".

### 5.3 Rows without an order

After the orders of a region are done for the night, the same copy → verify → guarded delete runs for:
- `transactions WHERE order_id IS NULL AND created_at < :cutoff − minAge` (payouts) — **Q-X3**, new partial index `idx_transactions_created_at_no_order` (payouts are few, but `transactions` is large: without it this would be a full table scan every night);
- `payment_webhook_events WHERE received_at < :cutoff − minAge` — **Q-X4**, new index `idx_payment_webhook_events_received_at`.

### 5.4 Emptied partitions are dropped

When a prior-year month has **no rows left in hot** (`SELECT 1 FROM orders_pYYYYMM01 LIMIT 1` is empty, same for `order_items`), the worker runs `ALTER TABLE order_items DETACH PARTITION …; DROP TABLE …` and then the same for `orders`. Dropping a table returns its disk at once. Plain `DELETE` only marks rows dead, so without the drop, a month of deleted rows would sit as bloat until VACUUM. This is where monthly partitioning pays off (database-design §4.0).

Prior-year rows found in `orders_default` (only if partition maintenance stopped running) are archived the same way, row by row. Nothing gets dropped there.

## 6. Reads: which cluster answers

The rule (replaces today's `readConnForYear`):

| The request is about… | Reads from | Why |
|---|---|---|
| only the current year | **hot** | the normal case, one query |
| any prior-year date | **archive + hot**, merged | a prior-year order may still be hot: in its 30-day grace, stuck (§3), or mid-batch |

One helper decides this, `lib/knex/read-sources.ts → readSourcesForRange(region, range): ReadSource[]` (archive first, then hot). Every year-aware repository call runs once per source, and `lib/http/pagination/keyset-merge.ts → mergeKeysetPages` merges the pages:

- **Lists** (`/customer/orders?year=`, `/restaurant/orders?from&to`, `/admin/orders`, `/agents/earnings`, `/restaurant/payouts`): the existing multi-shard keyset merge in `OrderService.list` (admin `X-Region: all`) already merges pages from several connections with a **cursor per source**. It's generalised from "per region" to "per source" (`eg`, `eg:archive`). Duplicates (the same row in both during step 4→6) are removed by `publicId` / `id`, so each order appears once.
- **Order detail** `GET /orders/:publicId`: `created_at` is inside the UUIDv7, so the year is known before any query. Current year → hot. Prior year → **archive first, then hot** (most prior-year orders are archived). The ledger summary uses the **same connection** the order was found on.
- **`GET /payments/:paymentId`**: the id carries no date → hot first, archive if not found.
- **Totals** (`/agents/earnings` sums): hot sum + archive sum. A batch that is in both clusters is counted twice: for milliseconds between step 4 and step 6 normally, or **until the next run** if the archiver crashed (or a batch changed) between its copy and its delete. Accepted: it only affects a displayed total over a range that includes a prior year, never a money decision, and the next run fixes it. Writing this down instead of hiding it (the suite checks it on purpose).
- **Not year-aware on purpose:** `/agents/tasks` (current year only), `/agents/available-orders`, `/restaurant/balance` (a running total that lives in hot).

`ARCHIVE_DB_<region>_*` is required (D10): the API and every process refuse to start without it.

## 7. Writes on archived orders

Writes always go to **hot** (`db(region)`). An archived order can only be terminal and past its grace period, so:
- `PATCH /orders/:publicId/status`, `POST /deliveries/:id/accept|status` → the existing **404 Order not found** (the state machine would reject it anyway).
- `POST /payments/:paymentId/refund` on an archived charge → the existing **404 Payment not found**. Refunds are only possible during the grace period. Product rule: refund disputes older than 30 days after the order finished are handled outside the system.
- A late Kashier webhook for an archived order: the event is recorded and `processed_at` set, `process_error = 'order archived'`, and the response is **200**, so Kashier stops retrying.

**Known limit.** The archive keeps the hot unique constraints (`transactions.idempotency_key`, `payment_sessions.merchant_order_ref`, webhook `provider_event_id`). If a client reuses an `Idempotency-Key` for a payout or admin refund a year later, the new row gets the same ledger key as an archived one; when it is archived, the upsert hits the unique constraint and the region's run stops with `ALERT archival failed` (nothing is deleted from hot). Ops renames the key on one row. Not handled automatically: it needs a client reusing a key across years.

No new error messages are needed. api-contracts §9 stays as it is.

## 8. Archive cluster setup

- `ARCHIVE_DB_<region>_HOST|PORT|USERNAME|PASSWORD|NAME` become **required** in `env.ts` (they're optional now).
- Locally: the same Postgres 18 server, new databases `order_service_archive_eg` and `order_service_archive_ksa`. pg_partman's SQL-only files are already in this server's `share/extension` (memory note), so `CREATE EXTENSION pg_partman` works there too.
- `npm run migrate:archive` (already exists) applies every migration to the archive databases.
- **No partition maintenance on the archive:** `partition-maintenance.ts` keeps running on hot shards only. Archive partitions are created on demand by step 3.
- Health: `GET /api/health` keeps failing only on hot shards. Archive shards are added as `archiveShards: [{ region, ok }]`, information only. If the archive is down, current-year traffic is unaffected and prior-year reads fail with 503.

## 9. Configuration (new env)

| Var | Default | Meaning |
|---|---|---|
| `ARCHIVE_INTERVAL_MIN` | `60` | how often the job wakes up |
| `ARCHIVE_WINDOW_UTC` | `0-5` | hours (UTC, inclusive start, exclusive end) when it may work; `0-24` = always |
| `ARCHIVE_BATCH_SIZE` | `500` | orders per batch |
| `ARCHIVE_MAX_BATCHES_PER_RUN` | `200` | per region per tick (≈ 100k orders) |
| `ARCHIVE_MIN_AGE_DAYS` | `30` | grace after an order's last change (and for payouts / webhook events) |
| `ARCHIVE_STUCK_ALERT_DAYS` | `60` | log `archival.stuck_orders` when prior-year orders are still hot this long after Jan 1 |

## 10. Decisions to approve

| # | Decision | Alternative considered | Why this one |
|---|---|---|---|
| **D1** | Move **row batches** (copy → verify → guarded delete), then **drop emptied month partitions** | detach a whole month partition and move it with `pg_dump` / postgres_fdw | partitions can't move between clusters without extra tooling; batches work inside the worker, are idempotent, and handle stuck orders and the default partition. Dropping the emptied partition still gives the "no bloat" benefit |
| **D2** | Eligibility = terminal + **30-day grace** + no pending money (§3) | archive everything on Jan 1 | otherwise Dec 31 orders could not be refunded on Jan 2, and pending refunds would lose their webhook |
| **D3** | Prior-year reads use **archive + hot merged** | prior year → archive only (what the plan said) | in January (grace) and for stuck orders, the archive-only rule would make real orders disappear from the API |
| **D4** | Upsert (`ON CONFLICT DO UPDATE`) into the archive | `ON CONFLICT DO NOTHING` (the plan) | with DO NOTHING, a re-copy after a change (e.g. a new refund) would keep the stale archive row |
| **D5** | Guarded delete: lock + re-read + compare before deleting | delete by id after verify | closes the race with an admin refund committed between copy and delete |
| **D6** | Payouts and webhook events move too (§5.3), **2 new indexes in 1 migration** | keep them hot forever | PRD "only the current year in hot"; without the indexes the nightly query is a full scan of the biggest tables |
| **D7** | **Separate process** `npm run archiver`, night window, advisory lock per region | inside the existing worker | the worker's jobs are short and time-critical; a long nightly copy must not compete with offers / the payment sweep for pools and the event loop. The lock makes several archivers safe |
| **D8** | Writes on archived orders → existing 404s; late webhooks → 200 + `process_error` | restore the order to hot on demand | archived orders are final by definition; restoring would be a whole feature for a case the grace period already covers |
| **D9** | No realtime events | — | nothing changes state for a client (implementation-plan Phase 5) |
| **D10** | `ARCHIVE_DB_*` required from this phase; local archive DBs on the same Postgres server | a second Postgres install | identical behaviour, zero extra setup on Windows |

## 11. Files changed

| File | Change |
|---|---|
| `src/migrations/20261124100000_add_archival_indexes.ts` | **new** — `idx_transactions_created_at_no_order` (partial), `idx_payment_webhook_events_received_at`; `CREATE INDEX CONCURRENTLY` (`transaction: false`), real `down()` |
| `src/lib/config/env.ts`, `.env.example` | `ARCHIVE_DB_*` required; the vars of §9 + `ARCHIVE_TEST_PAUSE_MS` (dev only, race test) |
| `src/lib/knex/knex.ts`, `migrate-all.ts` | `pingAllArchives`; stale "Phase 7" comments → Phase 5 |
| `src/lib/knex/read-sources.ts` | **new** — `readSourcesForRange`, `hotSource`, `archiveSource`, `touchesPriorYear` (§6) |
| `src/lib/http/pagination/keyset-merge.ts` | **new** — one keyset page over several sources, one cursor per source, duplicates dropped |
| `src/pkg/utils/uuid.ts` | **new** — `timeOfUuidV7` (an order's year from its public id) |
| `src/app/archival/types.ts`, `repository/archival.repo.ts`, `service/archival.service.ts` | **new module** — §5 (Q-X1…Q-X6, upserts, guarded delete, partition drop, advisory lock) |
| `src/archiver.ts`, `package.json` | **new process** — `npm run archiver`, `npm run archive:once`, `start:archiver` |
| `src/lib/di/tokens.ts`, `container.ts` | `ArchivalService` |
| `src/app/order/service/order.service.ts` | lists merge per source (`mergeKeysetPages`); detail: prior year → archive then hot, without the order cache; `readConnForYear` removed |
| `src/app/agent/service/agent.service.ts` | earnings page + totals over archive + hot |
| `src/app/restaurant-finance/service/finance.service.ts` | payouts list over archive + hot |
| `src/app/payment/service/payment.service.ts`, `webhook.service.ts` | `GET /payments/:id` hot → archive; webhook for an archived order → 200 + `order archived` |
| `src/app/health/health.routes.ts` | `archiveShards` in the response (never fails it) |
| `src/migrations/20261104100200_create_order_items_table.ts` | comment only |
| `play/phase5-e2e.ts` | **new** — §12 |
| docs | this file; implementation-plan Phase 5; system-design §3, §10; database-design §4.0, §5.5, §6, §8; api-contracts §1.3, §7; folder-structure; CLAUDE.md; session-handoff |

## 12. Tests (`play/phase5-e2e.ts`)

There is no real 2025 data, so the suite **stages** it on hot: it creates the 2025 month partitions (`partman.create_partition_time`) and inserts orders whose UUIDv7 `public_id` carries a 2025 timestamp, with items, a charge + partial refund, a session, a commission row, an agent earning, plus a 2025 payout and webhook event. Then it runs `npm run archive:once`.

| Area | Checks |
|---|---|
| Move | every staged row is in the archive **identical** to its hot copy (column by column); gone from hot; emptied 2025 partitions dropped on hot |
| Eligibility | a 2025 order with a pending refund, one still `ready`, one updated 5 days ago → stay hot |
| Reads | `GET /customer/orders?year=2025` returns archived **and** still-hot 2025 orders, each once, newest first, paging across both; detail of an archived order (with payment summary); `/restaurant/orders` 2025 range; `/agents/earnings` range incl. 2025 + totals; `/restaurant/payouts` range incl. 2025 |
| Writes | status change / refund on an archived order → 404; late webhook → 200 + `process_error` |
| Idempotency | 2nd `archive:once` → nothing moved, nothing changed; crash simulation: archive copy present but hot rows still there (staged) → next run finishes it |
| Race | a refund inserted between copy and delete (test hook `ARCHIVE_TEST_PAUSE_MS`, dev only) → batch rolled back, archived next run with the refund |
| Money | `restaurant_balances` untouched; reconciliation (restaurant-finance §6) over hot + archive still equals the balance |
| Concurrency | two `archive:once` at the same time → one does the work, the other skips (advisory lock) |
| Regression | ws 16, Phase 2 32, Phase 3 44, Phase 4 39 |

**Result (2026-11-24): 38/38**, twice in a row (the 2nd without cleanup). Regression: ws 16/16, Phase 2 32/32, Phase 3 44/44, Phase 4 39/39.
Two lessons from writing it: (1) a staged "reserved, never sent" refund was sent by the running worker's refund sweep, failed at Kashier, and so its order became archivable — staged pending refunds must be *sent* (`provider_requested_at` set) to stay blocked; (2) the earnings total counted a crash leftover twice, which widened the documented trade-off in §6 from "milliseconds" to "until the next run".
