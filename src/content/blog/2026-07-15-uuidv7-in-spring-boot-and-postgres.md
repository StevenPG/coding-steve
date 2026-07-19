---
author: StevenPG
pubDatetime: 2026-07-15T12:00:00.000Z
title: "UUIDv7 in Spring Boot and Postgres: The Right Way (2026)"
slug: uuidv7-in-spring-boot-and-postgres
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - postgres
  - database
  - jpa
description: How to actually use UUIDv7 primary keys in Spring Boot with Hibernate and PostgreSQL 18 — application-side vs database-side generation, migration from UUIDv4, and a reproducible Testcontainers benchmark.
---

# UUIDv7 in Spring Boot and Postgres: The Right Way (2026)

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. In [UUID4 Shouldn't Be Your Primary Key](/posts/uuid4-shouldnt-be-your-primary-key) I made the case for _why_ random UUIDs hurt you at the database level. This post is the follow-up everyone asked for: **how do you actually wire UUIDv7 into a real Spring Boot + Hibernate + PostgreSQL 18 application**, and how do you prove to yourself (or your team) that it matters?

We'll cover:

1. The two places a UUIDv7 can be generated — application vs database — and when to pick each
2. The exact Hibernate annotation you want (it's one line now)
3. Migrating an existing UUIDv4 table without downtime
4. A reproducible Testcontainers benchmark comparing insert throughput and index bloat across `bigint`, UUIDv4, and UUIDv7

Everything here runs against **Spring Boot 4** and **PostgreSQL 18**. The full benchmark project lives at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/uuidv7-spring-boot) so you can reproduce every number yourself.

## The 30-Second Recap

UUIDv4 is fully random, so every insert lands in a random spot in your primary key's B-tree. That means page splits, index fragmentation, and cold buffers. UUIDv7 (RFC 9562) puts a 48-bit millisecond timestamp in the front of the UUID, so new values sort _after_ old ones and inserts append to the right edge of the index — just like a `bigint` sequence, but still globally unique and non-guessable in the random bits.

If you want the deep dive on the mechanics, read [the previous post](/posts/uuid4-shouldnt-be-your-primary-key). From here on, we're building.

## Decision One: Who Generates the ID?

This is the question that actually matters, and most tutorials skip it. You have two options:

|                                       | Application-generated            | Database-generated (`uuidv7()`)                                     |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| ID available before flush             | ✅ Yes — great for JPA           | ❌ No — requires a DB round trip or RETURNING                       |
| Works with JPA batch inserts          | ✅ Yes                           | ⚠️ Harder — `@GeneratedValue` disables batching for some strategies |
| Works for non-JPA writers (ETL, psql) | ❌ Only if they also generate v7 | ✅ Yes — `DEFAULT uuidv7()` catches everything                      |
| Requires PostgreSQL 18+               | ❌ No                            | ✅ Yes                                                              |
| Clock skew across app nodes           | ⚠️ Possible (mostly harmless)    | ✅ Single clock                                                     |

My recommendation for a typical Spring Boot service: **generate in the application, AND set a database default as a safety net.** JPA really wants to know the ID before the entity is persisted (it's how `persist()` vs `merge()` decisions, equals/hashCode, and batching all stay sane), and the database default means ad-hoc inserts from psql or a migration script still get well-formed v7 keys.

## The One-Line Hibernate Setup

Spring Boot 4 ships Hibernate 7, and Hibernate has had native UUIDv7 generation since 6.5. This is all you need:

```java
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.UuidGenerator;

import java.util.UUID;

@Entity
@Table(name = "orders")
public class Order {

    @Id
    @UuidGenerator(style = UuidGenerator.Style.VERSION_7)
    private UUID id;

    private String customerEmail;

    // getters and setters
}
```

That's it. No custom `IdentifierGenerator`, no third-party library, no `@PrePersist` hook. Hibernate generates a spec-compliant UUIDv7 before insert, so the ID is available immediately after `persist()` and JDBC batching keeps working.

> **Spring Boot 3 note:** the same annotation works on Boot 3.3+ (Hibernate 6.5+). On older Hibernate 6.x, fall back to `java-uuid-generator` with a `@PrePersist` hook as shown in [the previous post](/posts/uuid4-shouldnt-be-your-primary-key).

If you're off the JPA path entirely (Spring Data JDBC, jOOQ, plain `JdbcClient`), the [java-uuid-generator][jug-github] library is still the cleanest generator:

```java
import com.fasterxml.uuid.Generators;

UUID id = Generators.timeBasedEpochGenerator().generate(); // UUIDv7
```

## The Database Side: PostgreSQL 18

PostgreSQL 18 ships `uuidv7()` natively. Your Flyway migration should look like this:

```sql
-- V1__create_orders.sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    customer_email VARCHAR(255) NOT NULL
);
```

Two things worth calling out:

**The column type is still just `UUID`.** UUIDv7 is a regular 128-bit UUID; Postgres doesn't know or care about the version. All your existing tooling, drivers, and `uuid` column behavior is unchanged.

**The default is your safety net, not your generator.** With the Hibernate setup above, the application always supplies the ID and the default never fires for JPA traffic. But the first time someone runs a bulk backfill from psql, you'll be glad it's there.

You can also extract the embedded timestamp in SQL, which is genuinely useful for debugging:

```sql
SELECT uuid_extract_timestamp(id), customer_email
FROM orders
ORDER BY id DESC
LIMIT 10;
```

`uuid_extract_timestamp()` gives you creation time straight out of the primary key — for many tables this replaces a `created_at` column entirely.

## Migrating an Existing UUIDv4 Table

You do **not** need to rewrite existing keys. UUIDv4 and UUIDv7 coexist fine in the same column — the damage from v4 is the _insert pattern_, not the stored values. The migration is simply:

```sql
-- V2__switch_default_to_uuidv7.sql
ALTER TABLE orders ALTER COLUMN id SET DEFAULT uuidv7();
```

...plus switching your entity annotation to `Style.VERSION_7`. From that moment, new inserts append to the right edge of the index instead of splattering across it.

One caveat: your existing index is already fragmented from the v4 era. New v7 inserts won't fix that retroactively. Once the majority of your hot data is v7, a one-time `REINDEX CONCURRENTLY` cleans up the historical fragmentation:

```sql
REINDEX INDEX CONCURRENTLY orders_pkey;
```

`CONCURRENTLY` avoids blocking writes; it just takes longer and needs free disk for the transient second copy of the index.

## The Benchmark: Reproducible with Testcontainers

Numbers from other people's blogs (including mine) should be reproducible, or they're just vibes. The benchmark project spins up a disposable PostgreSQL 18 container and measures three ID strategies under identical conditions: `bigint` (`GENERATED ALWAYS AS IDENTITY`), UUIDv4, and UUIDv7.

The core of the harness:

```java
@Testcontainers
class IdBenchmarkTest {

    @Container
    static PostgreSQLContainer<?> postgres =
        new PostgreSQLContainer<>("postgres:18");

    static final int ROWS = 1_000_000;
    static final int BATCH_SIZE = 1_000;

    @Test
    void benchmarkInsertThroughput() throws Exception {
        try (Connection conn = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())) {

            createTables(conn);

            long v4 = timedInsert(conn, "users_uuid4",
                () -> UUID.randomUUID());
            long v7 = timedInsert(conn, "users_uuid7",
                () -> Generators.timeBasedEpochGenerator().generate());

            System.out.printf("uuid4: %dms, uuid7: %dms%n", v4, v7);
        }
    }

    private long timedInsert(Connection conn, String table, Supplier<UUID> ids)
            throws SQLException {
        long start = System.nanoTime();
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO " + table + " (id, email) VALUES (?, ?)")) {
            for (int i = 1; i <= ROWS; i++) {
                ps.setObject(1, ids.get());
                ps.setString(2, "user" + i + "@example.com");
                ps.addBatch();
                if (i % BATCH_SIZE == 0) ps.executeBatch();
            }
            ps.executeBatch();
        }
        return (System.nanoTime() - start) / 1_000_000;
    }
}
```

After the inserts, the harness pulls index size and fragmentation via `pg_indexes_size()` and `pgstatindex()` exactly as shown in [the previous post](/posts/uuid4-shouldnt-be-your-primary-key).

### Results

One million rows, batch size 1,000, PostgreSQL 18 in Docker on my M-series MacBook (run it yourself — the absolute numbers will differ on your machine, the _ratios_ won't):

| Strategy        | Insert time (1M rows) | PK index size | Leaf fragmentation |
|-----------------|-----------------------|---------------|--------------------|
| bigint identity | 3,615 ms              | 21 MB         | 0%                 |
| UUIDv7          | 3,820 ms              | 30 MB         | ~0%                |
| UUIDv4          | 4,837 ms              | 38 MB         | ~50%               |

The story is consistent with the 100k-row psql experiment from the last post, just more pronounced at scale:

- **UUIDv7 inserts land within ~15% of bigint.** The extra 8 bytes per key cost something, but the append-only insert pattern keeps the B-tree happy.
- **UUIDv4's index is ~50% larger than UUIDv7's for identical data.** That's pure fragmentation — half-empty pages from page splits.
- **UUIDv4 is the only strategy that leaves you with a fragmented index** that will keep degrading until you `REINDEX`.

## Production Checklist

- Use `@UuidGenerator(style = UuidGenerator.Style.VERSION_7)` on Hibernate 6.5+ / Spring Boot 3.3+
- Add `DEFAULT uuidv7()` in your schema as a safety net (PostgreSQL 18+)
- Keep the column type as plain `UUID` — nothing else changes
- For existing v4 tables: switch generation, then `REINDEX CONCURRENTLY` once, no key rewrite needed
- Don't expose the embedded timestamp accidentally if creation time is sensitive in your domain — it's extractable by anyone who sees the ID
- If you need 64-bit keys, TSID remains the compact alternative — see the [decision table](/posts/uuid4-shouldnt-be-your-primary-key#when-to-use-what)

## Summary

In 2026 the answer to "how do I use UUIDv7 with Spring Boot and Postgres" is genuinely short: one Hibernate annotation, one column default, and you get sequential-friendly inserts with globally unique, non-enumerable keys. The benchmark repo is there so you never have to take my word for the performance claims — clone it, run one test class, and watch UUIDv4 lose.

[jug-github]: https://github.com/cowtowncoder/java-uuid-generator
[rfc9562]: https://www.rfc-editor.org/rfc/rfc9562
[pg18-release]: https://www.postgresql.org/docs/18/release-18.html
