---
author: StevenPG
pubDatetime: 2026-01-25T12:00:00.000Z
title: UUID4 Shouldn't Be Your Primary Key
slug: uuid4-shouldnt-be-your-primary-key
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - postgres
  - database
  - java
  - spring boot
description: A comparison of UUID4, UUID7, TSID, and sequential IDs for database primary keys with practical PostgreSQL 18 examples and Spring Boot integration.
---

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, no one has to do the same digging I had to do.

In this post, we're going to walk through why UUID4 isn't the best choice for primary keys, and what alternatives exist. I'll include practical examples using PostgreSQL 18 with Docker so you can follow along and see the differences yourself.

Also, since it's 2026, these examples aren't just AI input and output. These are all manually validated, and you can try them yourself. I try to always include EVERYTHING needed to run the examples. I hate tutorials that skip steps.

# Why Not Just Use Sequential IDs?

Before we dive into the UUID discussion, let's address the elephant in the room: why not just use auto-incrementing integers?

Sequential IDs are great for performance. They're compact, indexed efficiently, and insert in order. But they come with a significant problem in many modern applications.

The classic advice I've seen online once is: "never make your primary key customer data." But when you need to expose IDs externally, prevent enumeration attacks, or generate IDs across distributed systems without coordination, you need something else.

What really sold me on time-sorted identifiers was realizing that UUID7 embeds the creation timestamp directly in the ID. This means you can often skip adding a separate `created_at` column entirely. The timestamp is right there in the primary key, extractable when needed. That's one less column to maintain, one less index to worry about, and a cleaner schema overall.

If you find yourself in a situation where UUIDs make sense, you'll want to choose the right type. And UUID4 isn't it.

# The Problem with UUID4

UUID4 (random UUIDs) are what most developers reach for by default. They're simple to generate and widely supported. But they have a significant problem when used as primary keys: **they're completely random**.

Why does randomness matter? It comes down to how databases store and index data.

### B-Tree Index Fragmentation

Most databases use B-tree indexes for primary keys. B-trees work best when new values are inserted in roughly sequential order. When you insert random UUID4 values:

1. **Page splits occur frequently** - The database has to reorganize index pages constantly
2. **Poor cache utilization** - Random access patterns mean data isn't in memory when you need it
3. **Increased I/O** - More disk reads are required to find and insert records
4. **Index bloat** - The index becomes fragmented and larger than necessary

### Write Amplification

With random UUIDs, every insert potentially touches a different part of the index. This means:
- More pages need to be written to disk
- WAL (Write-Ahead Logging) generates more data
- Replication and backup processes are slower

# Enter Time-Sorted Identifiers

The solution is to use identifiers that are both unique AND roughly time-ordered. This gives us the best of both worlds: the uniqueness guarantees of UUIDs with the index-friendly properties of sequential IDs.

There are two main contenders: **TSID** and **UUID7**.

## TSID (Time-Sorted Unique Identifier)

[TSID][tsid-github] is a library created by Vlad Mihalcea that generates time-sorted unique identifiers. The format is:

- 42 bits for timestamp (millisecond precision, ~69 years from epoch)
- 22 bits for random/node data

This results in a 64-bit value that can be stored as a `BIGINT` in the database, which is more compact than a 128-bit UUID.

**Advantages:**
- Compact storage (8 bytes vs 16 bytes for UUID)
- Time-sorted for efficient indexing
- Can be formatted as a 13-character string

**Disadvantages:**
- Not a standard UUID format
- Requires a library to generate
- Less ecosystem support

## UUID7 (Time-Ordered UUID)

[UUID7][rfc9562] is part of the new UUID specification (RFC 9562). It's been gaining traction and is now natively supported in PostgreSQL 18!

The format includes:
- 48 bits for timestamp (millisecond precision)
- 4 bits for version
- 12 bits for random sub-millisecond sequencing
- 62 bits for random data

**Advantages:**
- Standard UUID format (128-bit, familiar hyphenated string representation)
- Native database support (PostgreSQL 18+)
- Time-sorted for efficient indexing
- Broad ecosystem compatibility

**Disadvantages:**
- Larger storage footprint (16 bytes)
- Requires PostgreSQL 18+ for native support (or application-level generation)

# PostgreSQL 18 UUID7 Support

PostgreSQL 18 adds native support for UUID7 generation via the `uuidv7()` function. This is a significant development because it means you don't need application-level libraries to generate time-sorted UUIDs.

More details are available in the [PostgreSQL 18 documentation][pg18-uuidv7].

# Using TSID and UUID7 in Spring Boot

If you're working with Spring Boot, you have options for generating these identifiers at the application level.

## TSID with Hypersistence TSID

The [hypersistence-tsid][tsid-github] library makes it easy to generate TSIDs in Java applications.

### Dependencies

build.gradle
```groovy
dependencies {
    implementation 'io.hypersistence:hypersistence-tsid:2.1.3'
}
```

### Basic Usage

```java
import io.hypersistence.tsid.TSID;

public class TsidExample {

    // Generate a new TSID
    TSID tsid = TSID.fast();

    // Get the long value for database storage
    long tsidLong = tsid.toLong();

    // Get the string representation (13 characters)
    String tsidString = tsid.toString(); // e.g., "0HJBZJM5V3YC8"

    // Extract the timestamp
    Instant createdAt = tsid.getInstant();
}
```

### JPA Entity with TSID

```java
import io.hypersistence.tsid.TSID;
import jakarta.persistence.*;

@Entity
@Table(name = "users_tsid")
public class User {

    @Id
    private Long id;

    private String email;

    @PrePersist
    public void prePersist() {
        if (id == null) {
            id = TSID.fast().toLong();
        }
    }

    // Convenience method to get creation time from the ID
    public Instant getCreatedAt() {
        return TSID.from(id).getInstant();
    }

    // getters and setters
}
```

### Custom ID Generator (Optional)

For a cleaner approach, you can create a custom Hibernate ID generator:

```java
import io.hypersistence.tsid.TSID;
import org.hibernate.engine.spi.SharedSessionContractImplementor;
import org.hibernate.id.IdentifierGenerator;

public class TsidGenerator implements IdentifierGenerator {

    @Override
    public Object generate(SharedSessionContractImplementor session, Object object) {
        return TSID.fast().toLong();
    }
}
```

Then use it in your entity:

```java
@Entity
@Table(name = "users_tsid")
public class User {

    @Id
    @GenericGenerator(name = "tsid", type = TsidGenerator.class)
    @GeneratedValue(generator = "tsid")
    private Long id;

    private String email;

    // getters and setters
}
```

## UUID7 in Spring Boot

For UUID7, you can use Java libraries until your database supports it natively, or let PostgreSQL 18 handle generation.

### Option 1: Database-Generated UUID7

Let PostgreSQL 18 generate the UUID7:

```java
@Entity
@Table(name = "users_uuid7")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    @Column(columnDefinition = "UUID DEFAULT uuidv7()")
    private UUID id;

    private String email;

    // getters and setters
}
```

Note: You'll need to ensure the default is set in your schema or use a native query for inserts.

### Option 2: Application-Generated UUID7

Using the [java-uuid-generator][jug-github] library:

build.gradle
```groovy
dependencies {
    implementation 'com.fasterxml.uuid:java-uuid-generator:5.1.0'
}
```

```java
import com.fasterxml.uuid.Generators;
import com.fasterxml.uuid.impl.TimeBasedEpochGenerator;

import java.util.UUID;

public class Uuid7Example {

    private static final TimeBasedEpochGenerator UUID7_GENERATOR =
        Generators.timeBasedEpochGenerator();

    public static UUID generateUuid7() {
        return UUID7_GENERATOR.generate();
    }
}
```

JPA Entity:

```java
@Entity
@Table(name = "users_uuid7")
public class User {

    @Id
    private UUID id;

    private String email;

    @PrePersist
    public void prePersist() {
        if (id == null) {
            id = Generators.timeBasedEpochGenerator().generate();
        }
    }

    // getters and setters
}
```

### Extracting Timestamp from UUID7

One of the benefits of UUID7 is the embedded timestamp:

```java
public static Instant extractTimestamp(UUID uuid7) {
    // UUID7 stores milliseconds since Unix epoch in the first 48 bits
    long timestamp = (uuid7.getMostSignificantBits() >> 16) & 0xFFFFFFFFFFFFL;
    return Instant.ofEpochMilli(timestamp);
}
```

# Hands-On Comparison

Let's set up a PostgreSQL 18 environment and compare these different ID strategies in practice.

## Docker Compose Setup

I can't stand when posts have examples that don't work or obviously weren't verified. And in the
age of AI this is all the more likely. I've personally verified all of this code works as-is, so
this should all be easily reproducible.

Create a `docker-compose.yml` file:

```yaml
services:
  postgres:
    image: postgres:18
    container_name: uuid-comparison
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: uuid_test
    ports:
      - "5432:5432"
```

Start the container:

```bash
docker compose up -d
```

Connect to the database:

```bash
docker exec -it uuid-comparison psql -U postgres -d uuid_test
```

## Create Test Tables

```sql
-- Table with sequential ID (baseline)
CREATE TABLE users_serial (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table with UUID4 (random)
CREATE TABLE users_uuid4 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table with UUID7 (time-sorted) - PostgreSQL 18+
CREATE TABLE users_uuid7 (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table with BIGINT for TSID (application-generated)
CREATE TABLE users_tsid (
    id BIGINT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Then you can run `\d` to see the list of tables we've created.

```SQL
                 List of relations
 Schema |        Name         |   Type   |  Owner
--------+---------------------+----------+----------
 public | users_serial        | table    | postgres
 public | users_serial_id_seq | sequence | postgres
 public | users_tsid          | table    | postgres
 public | users_uuid4         | table    | postgres
 public | users_uuid7         | table    | postgres
(5 rows)
```

## Insert Test Data

Let's insert a significant amount of data to see the differences:

```sql
-- Insert 100,000 rows into each table
INSERT INTO users_serial (email)
SELECT 'user' || generate_series || '@example.com'
FROM generate_series(1, 100000);

INSERT INTO users_uuid4 (email)
SELECT 'user' || generate_series || '@example.com'
FROM generate_series(1, 100000);

INSERT INTO users_uuid7 (email)
SELECT 'user' || generate_series || '@example.com'
FROM generate_series(1, 100000);

-- For TSID, we'll simulate with sequential bigints (in practice, use a TSID library)
INSERT INTO users_tsid (id, email)
SELECT generate_series, 'user' || generate_series || '@example.com'
FROM generate_series(1, 100000);
```

## Analyze Index Efficiency

After inserting, let's look at the index statistics:

```sql
-- Check table and index sizes
SELECT
    relname as table_name,
    pg_size_pretty(pg_total_relation_size(relid)) as total_size,
    pg_size_pretty(pg_relation_size(relid)) as table_size,
    pg_size_pretty(pg_indexes_size(relid)) as index_size
FROM pg_stat_user_tables
WHERE relname LIKE 'users_%'
ORDER BY pg_total_relation_size(relid) DESC;
```

(Raw output formatted into a nice markdown table)

|  table_name  | total_size | table_size | index_size  |
|--------------|------------|------------|-------------|
| users_uuid4  | 12 MB      | 7480 kB    | 4368 kB     |
| users_uuid7  | 10 MB      | 7480 kB    | 3104 kB     |
| users_serial | 8904 kB    | 6664 kB    | 2208 kB     |
| users_tsid   | 8904 kB    | 6672 kB    | 2208 kB     |

## Query Performance Comparison

Let's run some queries with `EXPLAIN ANALYZE` to see the performance differences:

### Range Queries (Fetch Recent Records)

```sql
-- Serial - range query on ID
EXPLAIN ANALYZE
SELECT * FROM users_serial WHERE id > 90000;

-- UUID7 - range query showing time-ordering benefit
EXPLAIN ANALYZE
SELECT * FROM users_uuid7
WHERE id > (SELECT id FROM users_uuid7 ORDER BY id OFFSET 90000 LIMIT 1);

-- UUID4 - range query (no time ordering benefit)
EXPLAIN ANALYZE
SELECT * FROM users_uuid4
WHERE id > (SELECT id FROM users_uuid4 ORDER BY id OFFSET 90000 LIMIT 1);
```

###### Serial

```
Index Scan using users_serial_pkey on users_serial  (cost=0.29..371.14 rows=9877 width=33) (actual time=0.048..2.628 rows=10000.00 loops=1)
   Index Cond: (id > 90000)
   Index Searches: 1
   Buffers: shared hit=114
 Planning Time: 0.139 ms
 Execution Time: 3.436 ms
```

###### UUID7

```
Index Scan using users_uuid7_pkey on users_uuid7  (cost=2747.67..4165.99 rows=33333 width=45) (actual time=17.746..18.736 rows=9999.00 loops=1)
   Index Cond: (id > (InitPlan 1).col1)
   Index Searches: 1
   Buffers: shared hit=484
   InitPlan 1
     ->  Limit  (cost=2747.22..2747.25 rows=1 width=16) (actual time=17.705..17.706 rows=1.00 loops=1)
           Buffers: shared hit=348
           ->  Index Only Scan using users_uuid7_pkey on users_uuid7 users_uuid7_1  (cost=0.42..3052.42 rows=100000 width=16) (actual time=0.096..12.456 rows=90001.00 loops=1)
                 Heap Fetches: 0
                 Index Searches: 1
                 Buffers: shared hit=348
 Planning:
   Buffers: shared hit=34
 Planning Time: 0.447 ms
 Execution Time: 19.090 ms
```

###### UUID4

```
Seq Scan on users_uuid4  (cost=3316.05..5501.05 rows=33333 width=45) (actual time=18.231..23.018 rows=9999.00 loops=1)
   Filter: (id > (InitPlan 1).col1)
   Rows Removed by Filter: 90001
   Buffers: shared hit=1424
   InitPlan 1
     ->  Limit  (cost=3316.02..3316.05 rows=1 width=16) (actual time=18.196..18.197 rows=1.00 loops=1)
           Buffers: shared hit=489
           ->  Index Only Scan using users_uuid4_pkey on users_uuid4 users_uuid4_1  (cost=0.42..3684.42 rows=100000 width=16) (actual time=0.056..12.782 rows=90001.00 loops=1)
                 Heap Fetches: 0
                 Index Searches: 1
                 Buffers: shared hit=489
 Planning:
   Buffers: shared hit=20
 Planning Time: 0.672 ms
 Execution Time: 23.467 ms
```

| Type   | Planning Time | Execution Time |
|--------|---------------|----------------|
| Serial | 0.139 ms      | 3.436 ms       |
| UUID7  | 0.447 ms      | 19.090 ms      |
| UUID4  | 0.672 ms      | 23.467 ms      |

**What This Means:** Range queries fetch multiple consecutive records, which benefits from time-ordered IDs. Serial IDs perform best because they're perfectly sequential. UUID7 performs significantly better than UUID4 because its time-based ordering means "recent" records are physically close together on disk. UUID4 performs worst because it requires scanning through random parts of the index - notice it falls back to a Sequential Scan rather than efficiently using the index. The buffer hits tell the story: UUID4 requires 1424 shared buffers compared to UUID7's 484, showing how random ordering forces the database to read more pages from memory.

### Point Lookups

```sql
-- Get a sample ID from each table first
-- Then run point lookups

-- Serial
EXPLAIN ANALYZE
SELECT * FROM users_serial WHERE id = 50000;

-- UUID4 (replace with actual UUID from your test)
EXPLAIN ANALYZE
SELECT * FROM users_uuid4 WHERE id = '8b9a33c1-12a5-4d61-a415-655d08a4a9cb';

-- UUID7 (replace with actual UUID from your test)
EXPLAIN ANALYZE
SELECT * FROM users_uuid7 WHERE id = '019c01d7-531f-7beb-93f6-910bac9a0c58';

-- TSID
EXPLAIN ANALYZE
SELECT * FROM users_tsid WHERE id = 50000;
```

###### Serial

```
Index Scan using users_serial_pkey on users_serial  (cost=0.29..8.31 rows=1 width=33) (actual time=0.022..0.023 rows=1.00 loops=1)
   Index Cond: (id = 50000)
   Index Searches: 1
   Buffers: shared hit=3
 Planning:
   Buffers: shared hit=5
 Planning Time: 0.295 ms
 Execution Time: 0.054 ms
```

###### UUID4

```
Index Scan using users_uuid4_pkey on users_uuid4  (cost=0.42..8.44 rows=1 width=45) (actual time=0.117..0.119 rows=1.00 loops=1)
   Index Cond: (id = '8b9a33c1-12a5-4d61-a415-655d08a4a9cb'::uuid)
   Index Searches: 1
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=35
 Planning Time: 0.674 ms
 Execution Time: 0.185 ms
```

###### UUID7

```
Index Scan using users_uuid7_pkey on users_uuid7  (cost=0.42..8.44 rows=1 width=45) (actual time=0.122..0.125 rows=1.00 loops=1)
   Index Cond: (id = '019c01d7-531f-7beb-93f6-910bac9a0c58'::uuid)
   Index Searches: 1
   Buffers: shared hit=4
 Planning Time: 0.092 ms
 Execution Time: 0.147 ms
```

###### TSID

```
Index Scan using users_tsid_pkey on users_tsid  (cost=0.29..8.31 rows=1 width=37) (actual time=0.213..0.214 rows=1.00 loops=1)
   Index Cond: (id = 50000)
   Index Searches: 1
   Buffers: shared hit=6
 Planning:
   Buffers: shared hit=38 dirtied=1
 Planning Time: 0.912 ms
 Execution Time: 0.257 ms
```

| Type   | Planning Time | Execution Time |
|--------|---------------|----------------|
| Serial | 0.295 ms      | 0.054 ms       |
| UUID7  | 0.092 ms      | 0.147 ms       |
| UUID4  | 0.674 ms      | 0.185 ms       |
| TSID   | 0.912 ms      | 0.257 ms       |

**What This Means:** Point lookups (single record by ID) are B-tree index operations that all types handle reasonably well. However, the differences are still revealing. Serial IDs are fastest due to their compact size (4 bytes) and optimal tree structure. UUID7 performs nearly identically to UUID4 for point lookups - both use the same 4 buffer hits and similar execution times. This shows that UUID7 doesn't sacrifice read performance; it simply organizes data better for range queries and writes. The planning time differences reflect index complexity: Serial's simpler index structure requires less planning overhead, while UUIDs require more work to locate the specific value in a larger key space.

### Insert Performance

```sql
-- Test insert performance (run multiple times and average)

-- Serial
EXPLAIN ANALYZE
INSERT INTO users_serial (email) VALUES ('newuser@example.com');

-- UUID4
EXPLAIN ANALYZE
INSERT INTO users_uuid4 (email) VALUES ('newuser@example.com');

-- UUID7
EXPLAIN ANALYZE
INSERT INTO users_uuid7 (email) VALUES ('newuser@example.com');
```

###### Serial

```
Insert on users_serial  (cost=0.00..0.02 rows=0 width=0) (actual time=0.201..0.202 rows=0.00 loops=1)
   Buffers: shared hit=4
   ->  Result  (cost=0.00..0.02 rows=1 width=528) (actual time=0.030..0.030 rows=1.00 loops=1)
         Buffers: shared hit=1
 Planning Time: 0.080 ms
 Execution Time: 0.259 ms
```

###### UUID4

```
Insert on users_uuid4  (cost=0.00..0.02 rows=0 width=0) (actual time=0.387..0.388 rows=0.00 loops=1)
   Buffers: shared hit=8 dirtied=3
   ->  Result  (cost=0.00..0.02 rows=1 width=540) (actual time=0.057..0.058 rows=1.00 loops=1)
 Planning:
   Buffers: shared hit=3
 Planning Time: 0.094 ms
 Execution Time: 0.418 ms
```

###### UUID7

```
Insert on users_uuid7  (cost=0.00..0.02 rows=0 width=0) (actual time=0.164..0.164 rows=0.00 loops=1)
   Buffers: shared hit=8 dirtied=3
   ->  Result  (cost=0.00..0.02 rows=1 width=540) (actual time=0.026..0.026 rows=1.00 loops=1)
 Planning:
   Buffers: shared hit=3
 Planning Time: 0.063 ms
 Execution Time: 0.177 ms
```

| Type   | Planning Time | Execution Time |
|--------|---------------|----------------|
| Serial | 0.080 ms      | 0.259 ms       |
| UUID7  | 0.063 ms      | 0.177 ms       |
| UUID4  | 0.094 ms      | 0.418 ms       |

**What This Means:** Insert performance reveals the core problem with UUID4. Notice that UUID4 requires 8 shared buffer hits and dirties 3 pages, while also taking significantly longer to execute (0.418ms vs 0.177ms for UUID7). This is because inserting a random UUID4 forces the database to find the correct location in the B-tree index, potentially splitting pages and reorganizing data. UUID7, being time-ordered, appends near the end of the index, similar to Serial IDs. This means fewer page splits, less reorganization, and better performance. The "dirtied" metric shows how many pages were modified - UUID7 and UUID4 both dirty 3 pages compared to Serial's 0, but UUID7's sequential nature makes those writes more efficient. At scale with thousands of inserts per second, UUID4's performance penalty compounds significantly.

## Index Fragmentation Check

```sql
-- Check index fragmentation using pgstattuple extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- Check each index
SELECT
    'users_serial_pkey' as index_name,
    leaf_fragmentation
FROM pgstatindex('users_serial_pkey')
UNION ALL
SELECT
    'users_uuid4_pkey',
    leaf_fragmentation
FROM pgstatindex('users_uuid4_pkey')
UNION ALL
SELECT
    'users_uuid7_pkey',
    leaf_fragmentation
FROM pgstatindex('users_uuid7_pkey')
UNION ALL
SELECT
    'users_tsid_pkey',
    leaf_fragmentation
FROM pgstatindex('users_tsid_pkey');
```

```
    index_name     | leaf_fragmentation
-------------------+--------------------
 users_serial_pkey |                  0
 users_uuid4_pkey  |              49.35
 users_uuid7_pkey  |                  0
 users_tsid_pkey   |                  0
```

**What This Means:** Index fragmentation measures how scattered the index pages are, with higher values indicating worse fragmentation. The `leaf_fragmentation` metric shows the percentage of leaf pages that are not in sequential order. Sequential IDs (Serial and TSID) will show very low fragmentation (close to 0%) because new records are always appended to the end. UUID7 will show slightly higher fragmentation but still remain relatively low because its time-based ordering keeps related records together. UUID4, however, will show significantly higher fragmentation (often 30-60% or more) because every insert goes to a random location in the index, causing the index structure to become scattered across disk. This fragmentation translates directly to slower query performance, as the database has to jump around to different physical locations to traverse the index. Over time, this fragmentation worsens, making regular REINDEX operations necessary to maintain performance - an expensive maintenance operation that UUID7 and TSID largely avoid.

# When to Use What

Here's a quick decision guide:

| Use Case                                    | Recommendation                |
|---------------------------------------------|-------------------------------|
| Internal-only IDs, single database          | Sequential (SERIAL/BIGSERIAL) |
| Distributed systems, multiple ID generators | UUID7 or TSID                 |
| External API exposure                       | UUID7 (familiar format)       |
| Maximum storage efficiency                  | TSID (64-bit)                 |
| PostgreSQL 18+ with native support          | UUID7                         |
| Legacy systems / broad compatibility        | UUID7 (still a valid UUID)    |
| Never                                       | UUID4 for primary keys        |

# Summary

UUID4 has been the default choice for many developers needing non-sequential identifiers, but it comes with real performance costs due to its random nature. The database has to work harder to maintain indexes, and you'll see increased I/O and storage overhead.

UUID7 and TSID solve this problem by incorporating time into the identifier, giving you roughly sequential ordering while maintaining global uniqueness. With PostgreSQL 18 adding native `uuidv7()` support, there's never been a better time to switch.

If you're starting a new project or have the opportunity to migrate, consider:

1. **UUID7** if you want standard UUID format and are on PostgreSQL 18+
2. **TSID** if you need maximum storage efficiency (64-bit vs 128-bit)
3. **Sequential IDs** if you don't need the distributed/non-enumerable properties of UUIDs

The performance difference may seem small on individual queries, but at scale, these differences compound into significant resource savings.

[tsid-github]: https://github.com/vladmihalcea/hypersistence-tsid
[rfc9562]: https://www.rfc-editor.org/rfc/rfc9562
[pg18-uuidv7]: https://neon.com/postgresql/postgresql-18/uuidv7-support
[vlad-uuid]: https://vladmihalcea.com/uuid-database-primary-key/
[jug-github]: https://github.com/cowtowncoder/java-uuid-generator
