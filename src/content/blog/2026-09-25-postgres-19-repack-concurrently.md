---
author: StevenPG
pubDatetime: 2026-09-25T12:00:00.000Z
title: "PostgreSQL 19's REPACK CONCURRENTLY vs VACUUM FULL: What Your Application Feels"
slug: postgres-19-repack-concurrently
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - postgres
  - database
  - performance
description: PostgreSQL 19 replaces VACUUM FULL and CLUSTER with REPACK, and REPACK (CONCURRENTLY) finally rewrites a bloated table without locking out writes. Measured against a live pgbench writer, plus pg_plan_advice for pinning query plans, and the "PostgreSQL 19 features" that didn't actually ship.
---

## Table of Contents

[[toc]]

# The table that never shrinks

Every long-lived Postgres database eventually has one: a table that was 30 GB of live data at its peak, lost
most of its rows to a retention job, and is still 30 GB on disk. Plain `VACUUM` marks dead space as reusable
but doesn't give it back to the operating system. The fix has always been to rewrite the table, and until now
every built-in way to rewrite it took an `ACCESS EXCLUSIVE` lock for the whole rewrite. No reads, no writes,
for however long it took to copy.

So in practice people installed [`pg_repack`](https://github.com/reorg/pg_repack), an extension that rebuilds the
table with triggers and swaps it in at the end. It worked, it was one more extension to keep version-matched
through upgrades, and it isn't available on every managed service.

PostgreSQL 19 (GA expected in October, Beta 4 out now) moves this into core:

- **`REPACK`** is a new command that _replaces_ `VACUUM FULL` and `CLUSTER`. `REPACK t` is `VACUUM FULL t`, and
  `REPACK t USING INDEX i` is `CLUSTER t USING i`. The old commands still work.
- **`REPACK (CONCURRENTLY)`** copies the table while reads and writes continue. It captures the changes made
  during the copy through logical decoding, replays them, and takes `ACCESS EXCLUSIVE` only for the final file swap.

That's the claim. This post measures what an application writing to the table actually experiences under each
option. Everything is in
[DemosAndArticleContent/blog/postgres-19-repack-concurrently](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/postgres-19-repack-concurrently).

Everything here ran against `postgres:19beta4`. The benchmark numbers are from my M3 Pro MacBook in Docker Desktop
(2 CPUs), with an earlier cloud-container run for comparison where the extra table size shows something the M3 run
couldn't.

# The benchmark

**The table.** 2M rows of aircraft positions with a primary key and an `(aircraft_id, ts DESC)` index. Then
`DELETE` 70% of them and run a plain `VACUUM`. The table is now about three times the size of its live data, and it
stays that way.

**The writer.** pgbench with 8 clients. Each transaction inserts a new position, reads the latest ten positions
for one aircraft through the index, and updates a surviving row. It's the shape of a real ingest service.

**The method.** After 10 seconds of steady load, the harness runs one of:

```sql
VACUUM (FULL) positions;
REPACK positions;
REPACK (CONCURRENTLY) positions;
```

**What's measured.** pgbench's per-second aggregate log (`--aggregate-interval=1`) gives every second's commit count
and worst latency. For the seconds the method was running, the harness reports:

- **seconds with zero commits**: what an exclusive lock looks like from the application
- **worst single transaction latency**, compared with the worst in the baseline
- average writer throughput during the rewrite, compared with before
- heap and index size before, and the moment the command returns

## Results

On the M3 Pro, with 2M rows (a 281 MB heap, 70% of it dead) and 8 writers:

| Method                  | Duration | Writer tps before → during | Seconds with zero commits | Worst writer transaction (baseline) |
| ----------------------- | -------: | -------------------------: | ------------------------: | ----------------------------------: |
| `VACUUM FULL`           |    0.8 s |              8,654 → 8,138 |                         0 |                     **706 ms** (22) |
| `REPACK`                |    0.7 s |            12,915 → 10,980 |                         0 |                     **585 ms** (56) |
| `REPACK (CONCURRENTLY)` |    1.2 s |            13,728 → 10,384 |                         0 |                      **38 ms** (30) |

And the space each one gave back, which doesn't depend on the hardware:

| Method                  | Heap MB before → after | Indexes MB before → after |
| ----------------------- | ---------------------: | ------------------------: |
| `VACUUM FULL`           |               281 → 91 |                  103 → 34 |
| `REPACK`                |               281 → 92 |                  103 → 34 |
| `REPACK (CONCURRENTLY)` |               281 → 93 |                  103 → 34 |

A note on that second table. My harness originally recorded the "after" size at the end of the writer's
measurement window, by which point pgbench had inserted another million rows, so the table looked like it had
barely shrunk. It now measures the moment the command returns. The sizes above come from a re-run with that fix, in
the cloud container.

## What the numbers say

**All three reclaim the same space.** 67% off the heap and 67% off the indexes, matching the 70% of rows that were dead.
Plain `VACUUM` had left all of that in place. `CONCURRENTLY` doesn't give you a worse table for not locking.

**The lock shows up in the worst transaction, not in the averages.** On the M3 each rewrite finished in about a
second, so there was never a whole second with zero commits. But under `VACUUM FULL` and `REPACK` the unluckiest
writer waited **0.6–0.7 s**, basically the entire rewrite, against a baseline of 20–60 ms. Under `CONCURRENTLY` the
worst writer waited **38 ms**, 8 ms over its baseline. That's the whole argument for the feature in two numbers.

**At this size, per-second throughput doesn't rank them.** A lock that lasts 0.7 s lands inside one or two
one-second buckets, and the queued transactions commit in a burst straight after, so the "during" averages mostly
measure noise. (The `VACUUM FULL` row also ran first, while the writer was still warming up, which is why its
baseline is lower.) What the averages do show is that `CONCURRENTLY` costs the writer something while it runs, about
a quarter of its throughput here, because it's copying the table and replaying changes alongside the load.

**The lock grows with the table.** A run on an 8M-row table (1.1 GB heap) in a 4-core cloud container shows what the
M3 run was too fast to show:

| Method                  | Duration | Seconds with zero commits | Worst writer transaction (baseline) | Writer tps before → during |
| ----------------------- | -------: | ------------------------: | ----------------------------------: | -------------------------: |
| `VACUUM FULL`           |    5.7 s |                         4 |                       5,585 ms (14) |                5,496 → 382 |
| `REPACK`                |    3.4 s |                         2 |                       3,198 ms (29) |              4,290 → 1,098 |
| `REPACK (CONCURRENTLY)` |    5.0 s |                     **0** |                     **108 ms** (16) |              5,447 → 3,623 |

With a locking rewrite, the worst write takes as long as the whole command, and whole seconds go by with no commits
at all. Extrapolate that to the 30 GB table from the opening and you're talking minutes of downtime. `CONCURRENTLY`
kept its worst transaction around 100 ms, which is the final swap, and never stopped the writer.

**CONCURRENTLY takes longer.** It was 1.2 s against 0.7–0.8 s on the M3, and 5.0 s against 3.4 s for plain `REPACK`
in the container. It copies, catches up and then swaps. You're trading wall-clock time for availability, which is
the right trade for anything user-facing.

## What CONCURRENTLY needs

Less than I expected, and a few hard limits:

- **`wal_level=replica` is enough.** I assumed that "uses logical decoding" meant switching the cluster to
  `wal_level=logical`. On 19beta4 it doesn't. REPACK uses its own replication slots, capped by the new
  `max_repack_replication_slots` (default 5). That cap is also how many concurrent repacks you can run.
- **A primary key or index-based replica identity is required.** Tables without one are refused.
- **It isn't for partitioned tables** (repack the partitions), `UNLOGGED` tables, system catalogs, or anything
  that isn't a heap table. It can't run inside a transaction block.
- **It still takes `ACCESS EXCLUSIVE` at the end.** It's brief, but it's a lock. If a long-running transaction is
  holding the table, the swap queues behind it, and every new query queues behind the swap. `lock_timeout` in the
  session running it makes the command give up instead. The catch: it gives up on the _whole_ command, so the copy
  work is thrown away and you retry later. Check `pg_stat_activity` for old transactions first.

```sql
SET lock_timeout = '5s';
REPACK (CONCURRENTLY) positions;
```

If you've read my post on [zero-downtime partition swapping](/posts/zero-downtime-partition-swapping-postgres), the
same rule applies: the short exclusive lock is never the problem. The queue that forms behind it is.

# pg_plan_advice: pin a plan without rewriting the query

The other PostgreSQL 19 feature I'd use right away is aimed at the 3 a.m. incident where a query that has run
fine for a year suddenly picks a terrible plan after an `ANALYZE`. Postgres has famously refused planner hints.
`pg_plan_advice` is its answer: _advice_ the planner follows, with feedback on whether it could.

It's a contrib module you `LOAD` (or preload). `EXPLAIN (PLAN_ADVICE)` prints the advice that would reproduce the
plan it just chose:

```sql
LOAD 'pg_plan_advice';
EXPLAIN (COSTS OFF, PLAN_ADVICE)
SELECT a.tail, count(*) FROM flight f JOIN aircraft a ON a.id = f.aircraft_id
WHERE a.type = 'E175' GROUP BY a.tail;
```

```
 Finalize GroupAggregate
   ...
         ->  Hash Join
               Hash Cond: (f.aircraft_id = a.id)
               ->  Parallel Seq Scan on flight f
               ->  Hash
                     ->  Seq Scan on aircraft a
 Generated Plan Advice:
   JOIN_ORDER(f a)
   HASH_JOIN(a)
   SEQ_SCAN(f a)
   GATHER_MERGE((f a))
```

Set `pg_plan_advice.advice` and the planner follows it, and `EXPLAIN` says whether each piece matched:

```sql
SET pg_plan_advice.advice = 'JOIN_ORDER(a f) NESTED_LOOP_PLAIN(f) INDEX_SCAN(f flight_aircraft)';
```

```
 HashAggregate
   ->  Nested Loop
         ->  Seq Scan on aircraft a
         ->  Index Scan using flight_aircraft on flight f
 Supplied Plan Advice:
   INDEX_SCAN(f flight_aircraft) /* matched */
   JOIN_ORDER(a f) /* matched */
   NESTED_LOOP_PLAIN(f) /* matched */
```

The feedback is the part I like most. Advice that can't be followed says so in `EXPLAIN`, instead of being silently
ignored:

```
 Supplied Plan Advice:
   INDEX_SCAN(f no_such_index) /* matched, inapplicable, failed */
   HASH_JOIN(zzz) /* not matched */
```

## Pinning it for everyone: pg_stash_advice

Setting a GUC per session doesn't help an application you can't change. The companion `pg_stash_advice`
(preloaded in the project's `compose.yaml`) stores advice by **query ID** and applies it automatically to any
session that opts into the stash:

```sql
CREATE EXTENSION pg_stash_advice;
SELECT pg_create_advice_stash('prod');
SELECT pg_set_stashed_advice('prod', <query_id>, 'JOIN_ORDER(a f) NESTED_LOOP_PLAIN(f) INDEX_SCAN(f flight_aircraft)');

ALTER ROLE app_user SET pg_stash_advice.stash_name = 'prod';
```

The query ID comes from `EXPLAIN (VERBOSE)`. The demo script pulls it out of the JSON plan in a `DO` block. Because
it's the _normalized_ query's ID, the advice applies to every literal. In the demo, advice stashed for
`type = 'E175'` also drives the plan for `type = 'A320'`.

Treat it the way you'd treat a pinned dependency version: a fix for today with an owner and an expiry, not a
permanent schema feature.

# The smaller changes that will bite someone

From the release notes, confirmed on the beta:

- **JIT is off by default.** It used to switch on based on cost estimates, which the project decided were
  unreliable. If you run big analytical queries and relied on it, set `jit = on` deliberately and measure.
- **`max_locks_per_transaction` defaults to 128, up from 64**, because lock-table sizing changed. If you set it
  explicitly, **double your value** to keep the same capacity.
- **Parallel autovacuum exists but is off.** `autovacuum_max_parallel_workers` defaults to `0`. Set it, or the
  per-table `autovacuum_parallel_workers` storage parameter, to let autovacuum process a big table's indexes in parallel.
- **New views** worth adding to your dashboards: `pg_stat_lock` (per-lock-type waits and wait time),
  `pg_stat_autovacuum_scores` (why autovacuum picks the table it picks), and `pg_stat_recovery`.
- `standard_conforming_strings` is forced on, RADIUS auth is gone, and `json_array()` over zero rows now returns
  `[]` instead of `NULL`. Check the full migration section before upgrading.

## Two features that aren't in 19

Several "what's new in PostgreSQL 19" articles list `GROUP BY ALL` and SQL:2011 `UPDATE ... FOR PORTION OF`.
Neither is in the release notes, and both are syntax errors on 19beta4:

```
ERROR:  syntax error at or near ";"
LINE 1: SELECT v % 3 AS bucket, count(*) FROM probe GROUP BY ALL;
ERROR:  syntax error at or near "FOR"
LINE 1: UPDATE rate FOR PORTION OF valid FROM '2026-06-01' TO '2026-...
```

The same goes for SQL/PGQ property graphs, which were reverted before release: `CREATE PROPERTY GRAPH` is a syntax
error on the beta too. When a release is this close, check the release notes and the beta, not the preview posts. `sql/whats-new-19.sql` in the repo does that in one command.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/postgres-19-repack-concurrently
docker compose up -d
python3 scripts/repack_bench.py run
docker exec -i pg19-repack psql -U postgres -X -f /sql/plan-advice.sql
```
