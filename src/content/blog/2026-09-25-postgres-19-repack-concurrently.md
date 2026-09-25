---
author: StevenPG
pubDatetime: 2026-09-25T15:00:00.000Z
title: "PostgreSQL 19's REPACK CONCURRENTLY vs VACUUM FULL: What Your Application Feels"
slug: postgres-19-repack-concurrently
featured: false
draft: true
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

- **`REPACK`** is a new command that *replaces* `VACUUM FULL` and `CLUSTER`. `REPACK t` is `VACUUM FULL t`, and
  `REPACK t USING INDEX i` is `CLUSTER t USING i`. The old commands still work.
- **`REPACK (CONCURRENTLY)`** copies the table while reads and writes continue. It captures the changes made
  during the copy through logical decoding, replays them, and takes `ACCESS EXCLUSIVE` only for the final file swap.

That's the claim. This post measures what an application writing to the table actually experiences under each
option. Everything is in
[DemosAndArticleContent/blog/postgres-19-repack-concurrently](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/postgres-19-repack-concurrently).

> **[DRAFT NOTE: numbers pending]** The SQL output and feature findings are real, from `postgres:19beta4`. The
> benchmark table is a placeholder until the run on my M3, which should also be against 19 GA or RC.

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
- heap and index size before and after

## Results

| Method | Duration | Heap MB before → after | Writer tps before → during | Seconds with zero commits | Worst writer latency (baseline) |
|---|---:|---:|---:|---:|---:|
| `VACUUM FULL` | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `REPACK` | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `REPACK (CONCURRENTLY)` | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |

What to look for:

- **`VACUUM FULL` and `REPACK` should look identical.** They're the same operation under two names. Every writer
  queues behind the lock for the whole rewrite, so the zero-commit seconds should roughly equal the duration.
- **`REPACK (CONCURRENTLY)` should keep committing throughout**, with some throughput loss because it competes for
  I/O and replays the concurrent changes, and **one latency spike** at the final swap. How big that spike is on
  real hardware is the number I care about most.
- **CONCURRENTLY will take longer end to end.** It copies, then catches up, then swaps. You're trading wall-clock
  time for availability, and that's the right trade for anything user-facing.

A preliminary run on a shared cloud container (8M rows, a 1.1 GB heap) already showed the shape clearly. Under
`VACUUM FULL` and `REPACK`, the worst writer transaction took as long as the whole rewrite (seconds, against a
baseline of ~20 ms), and there were whole seconds in which not one transaction committed. Under `CONCURRENTLY`
there were none. The worst transaction was about 100 ms, consistent with a single short lock at the swap, and
throughput dipped by about a third while the copy ran. It took a little longer than plain `REPACK`, as expected.

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
  session running it makes the command give up instead. The catch: it gives up on the *whole* command, so the copy
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
`pg_plan_advice` is its answer: *advice* the planner follows, with feedback on whether it could.

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

The feedback is the part that makes this better than the hint extensions people have used for years. Advice
that can't be followed says so, instead of being silently ignored:

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
it's the *normalized* query's ID, the advice applies to every literal. In the demo, advice stashed for
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

The same goes for SQL/PGQ property graphs, which were reverted before release: `CREATE PROPERTY GRAPH` is a syntax error on the beta too. When a release is this close, check the
release notes and the beta, not the preview posts. `sql/whats-new-19.sql` in the repo does that in one command.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/postgres-19-repack-concurrently
docker compose up -d
python3 scripts/repack_bench.py run
docker exec -i pg19-repack psql -U postgres -X -f /sql/plan-advice.sql
```
