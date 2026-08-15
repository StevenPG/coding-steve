---
author: StevenPG
pubDatetime: 2026-08-05T12:00:00.000Z
title: "Zero-Downtime Partition Swapping in Postgres with Spring Boot 4 and Kafka"
slug: zero-downtime-partition-swapping-postgres
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - postgres
  - kafka
  - database
  - performance
description: How to ingest Kafka into PostgreSQL 18 at 100k+ rows/second by COPYing into detached, index-free staging tables and swapping them in with ATTACH PARTITION. Includes a measured head-to-head against plain Spring Data JPA saveAll(), the three mechanisms that make the swap metadata-only, and the scaling wall I benchmarked and then argued against fixing.
---

# Zero-Downtime Partition Swapping in Postgres with Spring Boot 4 and Kafka

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Back in [Partitioning Tables with Postgres](/posts/partitioning-tables-postgres) I walked through what partitioning _is_ and how to set it up. This post is the advanced follow-up: **how do you use partitioning as a high-throughput ingestion strategy**, where new data is loaded into a table nobody can see and then swapped into the readers' view atomically?

There's a tax on every row you insert into an indexed table. An `INSERT` into a table with three indexes is really four writes — one heap tuple and three index tuples — plus the WAL for all of them, plus the buffer churn of keeping three B-trees hot while readers are traversing them. At a few hundred rows per second nobody notices. At thousands per second, index maintenance _is_ your write path, and the indexes your dashboards depend on are what's throttling ingestion.

The warehouse answer is: **don't index while you load.** Load into a bare table as fast as the disk will take it, build the indexes once at the end, then swap the loaded table into the readers' view in one metadata operation.

We'll cover:

1. Why `COPY` is a different thing from a faster `INSERT`, with a measured comparison against Spring Data JPA
2. The three mechanisms that make `ATTACH PARTITION` metadata-only instead of a table-scale operation under lock
3. Partitioning by arrival time (and why event time can't work for an automated swap)
4. Failure handling that doesn't wedge a Kafka partition forever
5. What the design costs you, and when the boring single-table approach is the right call

Everything here runs against **Spring Boot 4**, **Java 25**, and **PostgreSQL 18**. The full project — two services, a JPA baseline for comparison, and a benchmark harness — lives at [github.com/StevenPG/DemosAndArticleContent][demo-repo] so you can reproduce every number yourself.

## The Headline Number First

Draining the same 300,000 Kafka messages into the same PostgreSQL 18 instance, three ways:

| Implementation | Throughput (median of 3) | Relative |
| -------------- | ------------------------ | -------- |
| COPY into staging partitions | **112,994 rows/s** | 1.0× |
| `saveAll()`, tuned (batching, 6 threads, `synchronous_commit=off`) | 46,649 rows/s | 2.4× slower |
| `saveAll()`, stock Spring Data defaults | 2,859 rows/s | 39.5× slower |

I want to be upfront about which of those rows matters. **The tuned row is the honest one.** A competently configured ORM is only 2.4× behind, and ~46,000 rows/s is more than most services will ever need. The 39.5× is a story about _defaults_, not about JPA — and we'll get to exactly which defaults, because two of them are one-line fixes that most teams don't know they need.

> I originally wrote in my own notes that JPA was "the wrong tool by two orders of magnitude." Then I built the baseline and measured it. It's 1.6 orders naive and 0.4 orders tuned. Building the thing you're comparing against is the only way to avoid publishing folklore.

## The Shape of the System

Two Spring Boot services, deliberately separate processes:

```
                     ┌────────────── ingest-service ─────────────────┐
  producer ────────► │  Kafka topic ──► 6 listener threads           │
                     │                    └─► COPY FROM STDIN        │
                     └──────────────────────────┬───────────────────-┘
                                                ▼
                              sensor_readings_p20260805_1432   ◄─ detached,
                              sensor_readings_p20260805_1433      index-free
                     ┌────────── maintenance-service ───────────┐
                     │  every minute at :10 —                   │
                     │    1. ADD PRIMARY KEY, CREATE INDEX ×2   │
                     │    2. ADD CHECK (bounds)  ── scan        │
                     │    3. ANALYZE                            │
                     │    4. SET lock_timeout; ATTACH PARTITION │
                     │    5. DROP the now-redundant CHECK       │
                     └──────────────────┬───────────────────────┘
                                        ▼
                      sensor_readings   (partitioned parent)
                                        ▲
                    Spring Data JPA read API — never blocked,
                    never sees an unindexed or half-loaded row
```

- **ingest-service** owns the hot write path. It must never do anything slower than a `COPY`. Index builds are CPU- and I/O-hungry; if they ran here they could stall `poll()` loops and trigger consumer-group rebalances.
- **maintenance-service** owns DDL: the swap, retention, and the read API.

They share no state and never talk to each other. **The Postgres catalog is the coordination channel** — more on that later, because it's my favourite part of the design.

## Why COPY, Not INSERT

Spring Data JPA is in this project — on the _read_ side, where it's excellent. On the write side it's the wrong tool, and it's worth being precise about why.

A JPA `saveAll()` of 10,000 entities is, at best, 10,000 rows funneled through the extended query protocol in batches, each row planned into an `INSERT`, all of it flowing through the persistence context's dirty-checking machinery. `JdbcTemplate` batching drops the ORM overhead but keeps the protocol overhead.

`COPY ... FROM STDIN` is **a different protocol mode, not a faster INSERT.** The pgjdbc driver streams raw row data over the wire; Postgres parses it straight into heap tuples. One statement, one stream, one commit for the entire batch.

Batches come from Kafka for free:

```yaml
spring:
  kafka:
    listener:
      type: batch # hand the whole poll() result over as one List
```

One poll, one COPY, one offset commit. A single COPY is atomic — all rows or none — so a crash mid-batch means Kafka redelivers the whole batch and the staging table never holds a partial one. Clean at-least-once semantics with no distributed-transaction machinery.

### Stream the Payload, Don't Build It

Here's the implementation everyone writes first, and it quietly gives back a good chunk of what COPY just bought you:

```java
// Don't do this.
String payload = encodeBatch(events);
copyManager.copyIn(copySql, new StringReader(payload));
```

At 10,000 rows that's a multi-megabyte `char[]` — two bytes per character — which then gets encoded to UTF-8 on the way out. Two full copies of every batch, on every listener thread, straight into the young generation.

Encode directly to UTF-8 bytes in a buffer the thread owns and reuses, and drain it every 64 KB through pgjdbc's lower-level `CopyIn` handle:

```java
CopyIn copyIn = copyManager.copyIn(copySql);
try {
    for (SensorReadingEvent event : events) {
        encoder.appendRow(event, ingestedAtBytes);
        if (encoder.length() >= FLUSH_THRESHOLD) {
            copyIn.writeToCopy(encoder.buffer(), 0, encoder.length());
            encoder.reset();
        }
    }
    if (encoder.length() > 0) {
        copyIn.writeToCopy(encoder.buffer(), 0, encoder.length());
    }
    return copyIn.endCopy();
} catch (SQLException | RuntimeException e) {
    if (copyIn.isActive()) {
        copyIn.cancelCopy();   // else the pooled connection stays in COPY mode
    }
    throw e;
}
```

Peak footprint is now flat — about 72 KB per writer — regardless of batch size.

> **Steal the `cancelCopy()`.** An abandoned COPY leaves the connection stuck in COPY mode, and the pool hands that broken connection to the next batch. It's the kind of bug that surfaces as a cascade of unrelated failures ten minutes after the real problem.

## Parallelism Is Three Settings, Not One

This is the mistake that silently caps most COPY-based ingesters, and I hit it in my own demo before I benchmarked it. The listener concurrency default is **1**:

```yaml
spring:
  kafka:
    listener:
      type: batch
      concurrency: 6 # one consumer thread per topic partition
```

Six topic partitions with a single listener thread means one COPY at a time no matter how much hardware you have. But raising it alone isn't enough — three settings have to agree or the other two are decoration:

| Setting | Why it matters |
| ------- | -------------- |
| Topic partition count | **The ceiling.** A thread owns whole partitions, so concurrency above this just creates idle threads. |
| `spring.kafka.listener.concurrency` | Must move in lockstep with the partition count. |
| `spring.datasource.hikari.maximum-pool-size` | Must be **≥** concurrency, or writers serialize on connection checkout. |

And one more that bites differently:

```yaml
max.poll.interval.ms: 300000
```

This has to comfortably exceed the worst-case COPY of a `max.poll.records`-sized batch. If it doesn't, a heavy batch trips a rebalance, the rebalance redelivers the batch, the redelivery makes the next batch heavier, and the pipeline oscillates itself to death.

> **A Spring default that surprised me:** `spring.task.scheduling.pool-size` is **1**. Every `@Scheduled` method in your app shares one thread. In the maintenance service that means a long index build delays retention behind it. Set it to 4.

## Partition by Arrival Time, Not Event Time

The schema, owned by the ingest service's [Flyway migration](/posts/flyway-vs-liquibase-2026):

```sql
CREATE TABLE sensor_readings (
    id          uuid             NOT NULL,   -- UUIDv7, time-ordered
    device_id   text             NOT NULL,
    metric      text             NOT NULL,
    reading     double precision NOT NULL,
    recorded_at timestamptz      NOT NULL,   -- event time, from the producer
    ingested_at timestamptz      NOT NULL,   -- arrival time; THE PARTITION KEY
    CONSTRAINT sensor_readings_pkey PRIMARY KEY (id, ingested_at)
) PARTITION BY RANGE (ingested_at);
```

Partitioning on `ingested_at` rather than the event's own `recorded_at` is load-bearing. An automated swap has to answer "is this minute's table _complete_?" — and with event-time partitioning it can't. An event recorded at 14:32 can arrive at 14:37, so that partition is forever open to stragglers.

Arrival time is monotonic from the writer's perspective: once minute 14:32 has passed, plus a few seconds of grace for an in-flight COPY, its staging table is provably done. Late events land in the partition of the minute they _arrived_, with their event time preserved in `recorded_at` for any query that cares. It's the same watermark trade-off every stream processor makes, applied to table layout.

Two more schema notes:

**The primary key includes `ingested_at`** because on a partitioned table every unique constraint must contain the partition key. So `id` uniqueness is enforced per partition — the standard, acceptable trade for append-only telemetry.

**The ids are UUIDv7**, for all the reasons in [UUIDv7 in Spring Boot and Postgres](/posts/uuidv7-in-spring-boot-and-postgres). One wrinkle specific to this design: PostgreSQL 18 gives you `uuidv7()` natively, and I deliberately don't use it. The id identifies the event across Kafka, so it has to exist in the producer long before any row reaches Postgres — and COPY always supplies the column, so a `DEFAULT` would never fire anyway. Right tool, different problem.

## The Swap, and What It Actually Locks

Here's the whole promotion as real SQL:

```sql
-- Phase 1 & 2: on the DETACHED table. Readers cannot be affected.
ALTER TABLE sensor_readings_p20260805_1432
    ADD CONSTRAINT sensor_readings_p20260805_1432_pkey PRIMARY KEY (id, ingested_at);
CREATE INDEX sensor_readings_p20260805_1432_ingested_at_idx
    ON sensor_readings_p20260805_1432 (ingested_at);
CREATE INDEX sensor_readings_p20260805_1432_device_metric_idx
    ON sensor_readings_p20260805_1432 (device_id, metric, ingested_at);
ALTER TABLE sensor_readings_p20260805_1432
    ADD CONSTRAINT sensor_readings_p20260805_1432_bounds
    CHECK (ingested_at >= '2026-08-05 14:32:00+00' AND ingested_at < '2026-08-05 14:33:00+00');
ANALYZE sensor_readings_p20260805_1432;

-- Phase 3: the only statement that touches the parent.
SET lock_timeout = '2000 ms';
ALTER TABLE sensor_readings
    ATTACH PARTITION sensor_readings_p20260805_1432
    FOR VALUES FROM ('2026-08-05 14:32:00+00') TO ('2026-08-05 14:33:00+00');
ALTER TABLE sensor_readings_p20260805_1432
    DROP CONSTRAINT sensor_readings_p20260805_1432_bounds;
RESET lock_timeout;
```

**Three separate mechanisms** conspire to make that `ATTACH` effectively free. Miss any one and the "instant" attach quietly does table-scale work while holding a lock.

### 1. Since Postgres 12, ATTACH takes only SHARE UPDATE EXCLUSIVE

Before v12 it took `ACCESS EXCLUSIVE` — a full stop for readers. `SHARE UPDATE EXCLUSIVE` conflicts with other DDL and with vacuum, but **not** with `SELECT`, `INSERT`, `UPDATE`, or `DELETE`. This single version change is what turned attach-based loading from "brief outage" into "zero downtime."

### 2. The pre-validated CHECK skips the attach-time scan

`ATTACH PARTITION` must prove every row falls inside the declared bounds. Without help it proves it the hard way: scanning the table _while holding its locks_. But if a valid `CHECK` constraint already implies the partition bounds, Postgres skips the scan entirely.

So we pay for that scan in Phase 2, on the detached table, where it blocks nobody. Measured at 3M rows:

| | Time |
| --- | --- |
| `ADD CONSTRAINT … CHECK` (on the detached table) | 2,696 ms |
| `ATTACH` **without** the bounds CHECK | 1,221 ms |
| `ATTACH` **with** the pre-validated CHECK | **5.6 ms** |

Related: the parent deliberately has **no DEFAULT partition**. A default partition would have to be scanned on every attach to prove it holds no rows belonging to the incoming range, reinstating the very problem we just removed.

### 3. Pre-built matching indexes get linked, not built

The parent's indexes are _partitioned_ indexes — templates every partition must implement. If the incoming table already has structurally matching indexes, `ATTACH` wires them into the template in the catalog. If it doesn't, `ATTACH` builds them right there, under lock.

You can verify it:

```sql
SELECT parent.relname AS parent_index, child.relname AS partition_index
FROM pg_inherits i
JOIN pg_class parent ON parent.oid = i.inhparent
JOIN pg_class child  ON child.oid  = i.inhrelid
WHERE parent.relkind = 'I';
```

> **A benchmarking trap I fell into.** My first attempt to measure the CHECK optimisation showed 13.9s vs 11.4s and I concluded it didn't work. It did — neither test table had indexes, so _both_ attaches were dominated by index building and the validation scan was noise beside it. An attach has two independent table-scale costs; leave one uncontrolled and it'll hand you the wrong answer.

## lock_timeout: The Non-Obvious One

"Takes a weak lock" is not the same as "can't cause an outage." Lock acquisition in Postgres is **queued**: if the attach's `SHARE UPDATE EXCLUSIVE` request is waiting behind a long-running autovacuum or a stray manual DDL, then every request that conflicts with _the waiter_ queues behind it. A parked DDL statement can dam the whole river.

```java
for (int attempt = 1; attempt <= props.attachAttempts(); attempt++) {
    try {
        execute(connection, attachSql);
        return;
    } catch (SQLException e) {
        if (!"55P03".equals(e.getSQLState())) throw e;   // real failure
        sleepQuietly(200L * attempt);                     // lost the race, retry
    }
}
```

`SET lock_timeout` caps how long the attach may sit in that queue; SQLState `55P03` is `lock_not_available`. If every attempt loses, the staging table just waits for the next tick. Nothing lost, nothing blocked.

**This is the discipline to copy into any production DDL you run against hot tables**, partition-related or not.

## Durability You Can Afford to Lose

The largest single throughput knob for a bulk loader isn't in your application at all:

```yaml
spring:
  datasource:
    hikari:
      connection-init-sql: SET synchronous_commit = off
```

Two things make this defensible rather than reckless. First, **it is not `fsync = off`** — the database stays crash-safe and will never corrupt; only the commit _acknowledgement_ becomes asynchronous. Second, **Kafka is the source of truth.** The offsets for anything lost were never committed either, so the consumer replays exactly those records on restart. We're trading durability we can reconstruct for latency we can't.

Note it's set on the ingest pool only. The maintenance service keeps full durability — its DDL isn't replayable from anywhere.

Now, a caution I only found because I upgraded mid-project:

| | COPY p50 | COPY p99 |
| --- | --- | --- |
| PostgreSQL 16.13, `synchronous_commit = on` | 5.73 ms | ~109 ms |
| PostgreSQL 16.13, `off` | 4.44 ms | **~18 ms** |
| PostgreSQL 18.4, `on` | 6.26–6.78 ms | 22–46 ms |
| PostgreSQL 18.4, `off` | 5.49 ms | 21–27 ms |

On Postgres 16 this knob was worth roughly **6× at the tail**. On 18 it's worth about 15% at p50 with a much tighter tail — PostgreSQL 18's asynchronous I/O (`io_method`, defaulting to `worker`) reshapes the commit path enough that the stock configuration is already far better behaved.

**Re-measure your tuning after a major version upgrade.** A knob worth 6× on one release can quietly become a 15% knob on the next.

## When a Batch Can't Be Written

The default behaviour of a Kafka listener that throws is worth stating plainly, because it's the failure mode most ingestion demos ship with: offsets are never committed, Kafka redelivers the same batch immediately, and the loop spins as fast as the CPU allows. **One malformed record silently wedges a partition forever.**

The policy has two halves, and the split matters more than either half.

**Transient failures retry forever.** The database being down is not the batch's fault. COPY failures are classified by SQLState _class_:

```java
return switch (stateClass) {
    // 22 data exception, 23 integrity violation, 42 syntax/access rule
    case "22", "23", "42" -> new PoisonBatchException(message, e);
    // 08 connection, 40 rollback/deadlock, 53 resources, 57 shutdown, …
    default               -> new TransientIngestException(message, e);
};
```

Note the direction of the default: **anything unrecognised is transient.** A stalled partition is visible, alertable, and drains itself when the database comes back. A batch dead-lettered because Postgres was mid-failover is silent data loss.

**Un-processable data is dead-lettered immediately.** Getting this right for a _batch_ listener has three parts that are each easy to miss, and I got two of them wrong first:

1. **`ErrorHandlingDeserializer` signals failure with a null value.** Without it, a malformed record throws inside `poll()` where no error handler can catch it.
2. **The listener must take `ConsumerRecord`s, not values.** A listener declared `List<SensorReadingEvent>` can't distinguish that null and just throws `NullPointerException` deep in the write path — which the handler treats as a generic, retryable failure. Same wedge, more confusing stack trace.
3. **`BatchListenerFailedException` carries the failing record's index**, which lets the handler commit everything before it, dead-letter that one record, and redeliver the rest.

And the trap I walked straight into: because the retry policy above is deliberately _unlimited_, the poison record inherits it — retried forever, never reaching the recoverer, partition wedged anyway. The exceptions that identify un-processable data have to be excluded explicitly:

```java
handler.addNotRetryableExceptions(
        PoisonBatchException.class,
        BatchListenerFailedException.class);
```

## The Alarm You Actually Need

This architecture's worst failure mode is silent. If promotion stops — wedged scheduler, permanently failing phase, an attach losing every lock race — ingestion keeps working, staging tables keep being created, and the read API keeps returning HTTP 200. The only symptom is that queries quietly stop returning recent data. **Liveness and readiness probes both pass the entire time.**

So the [Actuator health indicator](/posts/ultimate-guide-spring-boot-actuator) measures what actually matters to a reader: how old is the oldest minute still not visible through the parent table?

```json
{
  "status": "DOWN",
  "details": {
    "stagingBacklog": 1,
    "oldestUnattachedTable": "sensor_readings_p20260805_0333",
    "oldestUnattachedAgeSeconds": 1881,
    "stalenessThresholdSeconds": 180,
    "reason": "partition promotion is falling behind; readers cannot see data older than the threshold"
  }
}
```

It reads that from the catalog on every check rather than from in-process bookkeeping — deliberately. If the scheduler thread is dead, cached state is exactly what would keep reporting healthy.

## Coordination Through the Catalog, Not a Queue

How does the maintenance service know which tables to promote? It asks the only component that actually knows:

```sql
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND c.relkind = 'r'
  AND c.relname LIKE 'sensor_readings_p%'
  AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
```

A table matching the naming contract with no `pg_inherits` row **is** the work queue. Created-but-not-attached is exactly the state "waiting for promotion," and attaching removes it from the result atomically. The two services share only a naming convention, and that buys real properties:

- **Crash safety for free.** Every phase is idempotent. Die between building the PK and attaching, and the next tick picks up where you left off. Down for an hour, and the next tick drains the backlog in chronological order.
- **Horizontal safety.** Multiple maintenance instances race politely via `pg_try_advisory_lock`.
- **Connection discipline.** The whole promotion runs on one dedicated JDBC connection, deliberately below JdbcClient/JPA: `SET lock_timeout` and advisory locks are connection-scoped, and a pool that hands each statement a different connection silently breaks both.

## The Read Side Never Finds Out

The payoff is what the read side _doesn't_ contain:

```java
@Entity
@Immutable                      // rows arrive via COPY; never dirty-check these
@Table(name = "sensor_readings")
@IdClass(SensorReadingId.class)
public class SensorReading { ... }
```

Nothing in the entity, the repository, or the controllers knows partitions exist. A row invisible at 14:32:59 is visible at 14:33:10 — already indexed, already analyzed — through the same JPQL query, because attach changed the _catalog_, not the query.

And because every query carries a predicate on `ingested_at`, the planner prunes:

```
 Aggregate
   ->  Append
         Subplans Removed: 2
         ->  Index Only Scan using sensor_readings_p20260805_0324_ingested_at_idx
```

## Retention: Where the Gap Is Structural

Deleting a minute of data isn't a `DELETE`:

```sql
ALTER TABLE sensor_readings DETACH PARTITION sensor_readings_p20260805_1432 CONCURRENTLY;
DROP TABLE sensor_readings_p20260805_1432;
```

Measured against the flat-table equivalent holding the same 300,000 rows:

| | Operation | Time | Space reclaimed | Blocks readers |
| --- | --- | --- | --- | --- |
| **Partitioned** | `DETACH CONCURRENTLY` + `DROP` | **9.6 ms** | immediately, in full | **never** |
| Flat | `DELETE` (293,391 rows) | 192 ms | **none** — still 44 MB | no |
| Flat | `VACUUM FULL` to reclaim | 34 ms | full (44 MB → 976 kB) | **ACCESS EXCLUSIVE** |

The wall-clock difference understates it. The `DELETE` only _marks_ rows dead: every one leaves a dead tuple in the heap and in all three indexes, and the table stays at full size until vacuumed. Reclaiming it needs `VACUUM FULL`, which takes `ACCESS EXCLUSIVE` and rewrites the table — the exact outage this whole architecture exists to avoid.

**Dropping a partition is O(1) in rows. Deleting from a flat table is O(rows), plus vacuum debt, plus bloat, forever.**

## The Numbers

Running at 2,000 events/sec, filling each per-minute partition with about 120,000 rows:

```
ingest: 20000 rows in 100 batches (2000 rows/s, 200 rows/batch) | copy p50 3.92 ms, p99 15.71 ms

[sensor_readings_p20260805_0422] promoted to live partition: ~120000 rows |
    pk 139 ms, indexes 266 ms, bounds-check 13 ms, analyze 85 ms,
    attach 2 ms, drop-check 1 ms, total 516 ms
```

The line to internalize is the last one. Promoting 120,000 rows into the live table costs **516 ms of work, of which the parent table is involved for 2 ms** — in a lock mode that doesn't conflict with readers anyway. The other 514 ms happens on a table no reader can see.

The ratio holds as the partition grows. At 3M rows the same attach took 5.6 ms while the bounds validation it skipped cost 1.2 s: a 25× larger partition moved the off-table work up 25× and the on-table work barely at all.

**Run it yourself — the absolute numbers will differ on your machine, the ratios won't.** All of mine come from a 4-vCPU container with default Postgres settings. One caveat I'd rather state than bury: the COPY figure varies by about a third run-to-run because the drain finishes in under three seconds, so page-cache and checkpoint state are a large fraction of the measurement. Read it as "roughly 100k rows/s on this hardware," not three significant figures.

## The Scaling Wall I Benchmarked and Then Argued Against

Six threads COPY into the same staging table, and folklore says they'll queue on Postgres's **relation extension lock** — the lock taken to add a page to a heap. Bulk loading is nothing but page extension, so it's a legitimate worry, and the fix (sub-partitioning each minute by writer shard) is a real design.

I benchmarked it before recommending it, and the result went the other way. Eight concurrent COPY writers, 1.6M rows:

| Target | Wall time |
| ------ | --------- |
| One shared table | **9,797 ms** |
| Eight separate tables | **10,511 ms** |

Sharding was **7% slower**. Sampled wait events show `LWLock:WALWrite` and `IO:DataFileWrite` dominating, and **`LWLock:extend` never appears at all**. Postgres has mitigated single-block extension since 9.6, reworked the path in 16, and added async I/O in 18; spreading writes across eight files just made the I/O less sequential.

So: **measure before you build.** Sample `pg_stat_activity` for `LWLock:extend` under peak load and only reach for sharded staging if it's actually near the top:

```sql
SELECT wait_event_type || ':' || wait_event AS wait, count(*)
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend' AND wait_event IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;
```

The conditions where it _does_ show up: PostgreSQL 15 or older, writer counts well beyond core count, and storage fast enough that I/O isn't the ceiling. If you have none of those, spend the effort on WAL configuration instead.

## When the Boring Approach Is Right

I don't want anyone rewriting a working service off the back of this post. The flat-table JPA design is _simpler_, and simpler wins by default. Choose it when:

- Ingestion is comfortably inside a few thousand rows/second
- Retention is handled by something other than bulk deletion, or the table never gets large enough for bloat to matter
- Reads are point lookups rather than time-range scans — and this one is measured too: on an indexed device+metric lookup the partitioned and flat layouts touched **23 buffers each**, with partitioning marginally _slower_. Partitioning helps queries that scan a time range; it does nothing for point lookups.

Choose the partition-swap design when sustained ingestion is high enough that index maintenance dominates the write path, when old data must be dropped continuously without lock spikes, or when reads are overwhelmingly recent-window queries.

And if you keep the JPA path — **at minimum set `hibernate.jdbc.batch_size` and fix the persist-versus-merge behaviour.** That's roughly 16× for two lines of configuration and one interface implementation. The second one is the sneaky one: with an application-assigned id, Spring Data sees a non-null id, assumes the row exists, and calls `merge()` — **one SELECT per row before every INSERT.** Implementing `Persistable` and returning `true` from `isNew()` removes it.

## Production Checklist

- Partition by **arrival time**, not event time, whenever an automated process needs to know a window is complete
- Build indexes and constraints on the **detached** table, and `ANALYZE` before anyone can query it
- Ensure pre-built indexes structurally match the parent's partitioned indexes, or `ATTACH` rebuilds them under lock
- Add a pre-validated bounds `CHECK` so `ATTACH` skips its validation scan; drop it afterwards
- No `DEFAULT` partition — it forces a scan on every attach
- `SET lock_timeout` plus a retry loop around **every** piece of DDL on a hot table
- `synchronous_commit = off` on the replayable write path only, never on DDL — and re-measure after major version upgrades
- Classify failures: retry infrastructure errors forever, dead-letter un-processable data immediately, and default the unknown to "transient"
- Alert on **promotion staleness**, not just liveness — the failure mode is silent
- Set `spring.task.scheduling.pool-size`; the default of 1 shares one thread across every `@Scheduled` method

## Summary

The trick underneath all of this is one idea: **index maintenance is deferrable work.** Build indexes once per partition on a table nobody can see, rather than once per row on a table everyone is querying, and then make the handover a catalog operation instead of a data operation. Three mechanisms make that handover free — the PG12+ lock mode, the pre-validated bounds `CHECK`, and pre-built matching indexes — and you need all three.

Whether it's worth it for you is a real question, which is why the [demo repo][demo-repo] ships the boring JPA version alongside it and a benchmark harness that runs both. Clone it, run `./benchmark.sh`, and decide with your own numbers instead of mine.

[demo-repo]: https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/zero-downtime-partition-swap
[pg-attach]: https://www.postgresql.org/docs/18/sql-altertable.html
[pg-copy]: https://www.postgresql.org/docs/18/sql-copy.html
[pg18-release]: https://www.postgresql.org/docs/18/release-18.html
[spring-kafka]: https://docs.spring.io/spring-kafka/reference/
