---
author: StevenPG
pubDatetime: 2026-07-17T12:00:00.000Z
title: Do You Really Need Elasticsearch? Postgres Full-Text Search in Spring Boot
slug: postgres-full-text-search-vs-elasticsearch
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - postgres
  - database
description: Before you add Elasticsearch to your stack, try the database you already run. Full-text search, fuzzy matching, and relevance ranking in plain Postgres with Spring Boot — with a runnable demo and latency numbers.
---

# Do You Really Need Elasticsearch? Postgres Full-Text Search in Spring Boot

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Today's trouble: someone on the team says "we need search," and twenty minutes later there's an Elasticsearch cluster in the architecture diagram — with its own JVM tuning, its own upgrade cycle, its own sync pipeline, and its own 3am pages.

For a large class of applications, the database you already run does this job. This post implements the same search three ways in **plain PostgreSQL 18 + Spring Boot 4** — an `ILIKE` baseline, real full-text search with `tsvector`, and typo-tolerant fuzzy matching with `pg_trgm` — with latency numbers from a 50,000-row corpus. The runnable demo is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/postgres-full-text-search).

Postgres keeps earning its place as the boring-but-right answer on this blog — it [runs in 140MB when asked nicely](/posts/postgres-on-less-than-150mb-of-memory) and [handles time-ordered keys natively now](/posts/uuidv7-in-spring-boot-and-postgres). Search is another one of those capabilities people don't realize they already have.

## The Three Contenders

| Strategy         | What it does                                                   | Typo tolerance | Relevance ranking | Index       |
| ---------------- | -------------------------------------------------------------- | -------------- | ----------------- | ----------- |
| `ILIKE '%term%'` | substring match                                                | ❌             | ❌                | none usable |
| `tsvector` FTS   | real text search: stemming, stop words, phrase/boolean queries | ❌             | ✅ `ts_rank`      | GIN         |
| `pg_trgm`        | trigram similarity                                             | ✅             | ✅ `similarity()` | GIN         |

The punchline up front: **FTS for the search box, trigram for the "did you mean" path, ILIKE for nothing.**

## The Schema That Does the Work

Everything interesting happens in one migration. PostgreSQL 12+ supports _generated columns_, which means the `tsvector` maintains itself — no triggers, no application code keeping a search index in sync (the #1 operational cost of the Elasticsearch route):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE articles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    -- Kept in sync by Postgres itself. Title matches rank above body matches.
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', title), 'A') ||
        setweight(to_tsvector('english', body), 'B')
    ) STORED
);

CREATE INDEX idx_articles_search ON articles USING GIN (search_vector);
CREATE INDEX idx_articles_title_trgm ON articles USING GIN (title gin_trgm_ops);
```

The `setweight` calls are the part most tutorials skip: they let `ts_rank` score a match in the title higher than the same match buried in paragraph twelve. That one detail is most of the difference between "search that works" and "search that feels right."

## The Spring Boot Side

I'm using `JdbcClient` rather than JPA here on purpose — the SQL _is_ the feature, and hiding it behind `@Query` annotations helps no one. (The demo still runs Flyway + JPA infrastructure so it drops into a typical service unchanged.)

```java
@Repository
public class SearchRepository {

    private final JdbcClient jdbc;

    public SearchRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Full-text search: websearch syntax, GIN index, ts_rank ordering. */
    public List<SearchResult> fullText(String query) {
        return jdbc.sql("""
                        SELECT id, title,
                               ts_rank(search_vector, websearch_to_tsquery('english', :q)) AS score
                        FROM articles
                        WHERE search_vector @@ websearch_to_tsquery('english', :q)
                        ORDER BY score DESC
                        LIMIT 20
                        """)
                .param("q", query)
                .query((rs, i) -> new SearchResult(
                        rs.getLong("id"), rs.getString("title"), rs.getDouble("score")))
                .list();
    }

    /** Fuzzy: trigram similarity on the title, survives typos. */
    public List<SearchResult> fuzzy(String query) {
        return jdbc.sql("""
                        SELECT id, title, similarity(title, :q) AS score
                        FROM articles
                        WHERE title % :q
                        ORDER BY score DESC
                        LIMIT 20
                        """)
                .param("q", query)
                .query((rs, i) -> new SearchResult(
                        rs.getLong("id"), rs.getString("title"), rs.getDouble("score")))
                .list();
    }
}
```

Notes on the choices in that SQL:

- **`websearch_to_tsquery`** accepts what users actually type — quoted phrases, `-exclusions`, bare words — and never throws on malformed input. The older `to_tsquery` explodes on unbalanced quotes; don't wire raw user input to it.
- **The `%` operator** is `pg_trgm`'s "similar enough" test (default threshold 0.3). `similarity()` gives the score for ranking. Try `/search/fuzzy?q=Postgress performence` in the demo — two typos, still finds the right articles.

## Latency: 50,000 Rows, Real Numbers

The demo seeds 50k articles via Flyway and ships a Testcontainers benchmark (`SearchLatencyTest`) that runs 500 iterations of each strategy after warmup — clone it and run `./gradlew test --tests SearchLatencyTest` for your own numbers. Representative results from my machine:

| Strategy        | p50    | p99    |
| --------------- | ------ | ------ |
| `ILIKE '%...%'` | ~35 ms | ~60 ms |
| `tsvector` FTS  | ~2 ms  | ~6 ms  |
| `pg_trgm` fuzzy | ~5 ms  | ~12 ms |

The shape of these numbers is the story: ILIKE sequential-scans the whole table on every keystroke and degrades linearly with table size. The two indexed strategies stay flat into the millions of rows. Single-digit milliseconds for indexed search on 50k documents — for a search box on your app, that's _done_.

## So When Do You Actually Need Elasticsearch?

Honest list. Reach for a dedicated search engine when you hit one of these:

1. **Search is the product.** Faceted navigation, aggregations-heavy dashboards, "more like this" — Elasticsearch's feature depth is real.
2. **Massive scale with search-specific tuning.** Hundreds of millions of documents where you want search on its own hardware with its own scaling story.
3. **Cross-language analysis chains.** Postgres FTS language support is decent but Elasticsearch's analyzer ecosystem is deeper.
4. **True semantic search at scale.** Though note: `pgvector` covers embedding search inside Postgres too — that pairs naturally with the [local embedding models from yesterday's post](/posts/ultimate-guide-spring-ai-ollama), and it's the natural fourth strategy to bolt onto this same table.

What's _not_ on the list: "we have 200k rows and want a search box with typo tolerance and ranking." That's a Tuesday for Postgres.

And the costs you skip by staying in Postgres are the ones that hurt on the ops side: no sync pipeline between your source of truth and your search index (and no drift between them — search is **transactional** with your writes), no second distributed system to upgrade, no extra infra bill idling at 2% utilization.

## Summary

Start with Postgres. One migration gives you self-maintaining, weighted, ranked full-text search; one extension adds typo tolerance; both stay transactionally consistent with your data at single-digit-millisecond latency. Put the search box on it, ship, and revisit only if you hit one of the four genuine Elasticsearch triggers above.

The demo — three endpoints, seeded corpus, latency benchmark — is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/postgres-full-text-search).

[pg-fts-docs]: https://www.postgresql.org/docs/current/textsearch.html
[pg-trgm-docs]: https://www.postgresql.org/docs/current/pgtrgm.html
[pgvector]: https://github.com/pgvector/pgvector
