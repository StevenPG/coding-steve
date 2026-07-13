---
author: StevenPG
pubDatetime: 2026-07-23T12:00:00.000Z
title: "Flyway vs Liquibase in 2026: Which Should You Pick?"
slug: flyway-vs-liquibase-2026
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - database
  - postgres
description: The same schema evolved through the same 10 migrations in both Flyway and Liquibase, so the comparison is about the tools — versioning models, rollback, drift detection, and what actually differs in the free tiers in 2026.
---

# Flyway vs Liquibase in 2026: Which Should You Pick?

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Every Spring service needs schema migrations, both major tools are fine, and yet the choice keeps generating meetings. This post ends the meeting: I evolved **the same schema through the same 10 migrations in both Flyway and Liquibase** — including the data migrations and the multi-step column split where tools actually differ — and compared what it's like to live with each in 2026.

Both demo projects (each verifying its migrations against PostgreSQL 18 via [Testcontainers](/posts/ultimate-guide-testcontainers-spring-boot)) are at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/flyway-vs-liquibase).

The answer up front, because you came here for it: **default to Flyway; pick Liquibase when you need rollbacks or multi-database abstraction.** The rest of the post is the evidence.

## The Shared Scenario

Ten migrations, identical SQL where possible, covering the situations that actually occur in a service's life:

| Step | Change                                  | Why it's in the test              |
| ---- | --------------------------------------- | --------------------------------- |
| 1–2  | `customers`, `orders` tables            | baseline DDL                      |
| 3    | index on `orders.customer_id`           | trivial change                    |
| 4    | add `status` column with default        | additive change                   |
| 5    | backfill `status` by age                | **data** migration                |
| 6–8  | split `name` → `first_name`/`last_name` | expand/contract, 3 steps          |
| 9    | reporting view                          | dependent object                  |
| 10   | `total` → `total_cents`                 | destructive change + view rebuild |

## How Each Tool Thinks

**Flyway** is a filename convention. `V1__create_customers.sql` through `V10__orders_total_to_cents.sql`, applied in version order, checksummed into `flyway_schema_history`. The migration _is_ the SQL file; there is nothing else to learn. Spring Boot autodetects `db/migration/` and runs pending migrations at startup.

**Liquibase** is a changelog of _changesets_, each identified by `author:id` rather than position. The changelog can be XML/YAML/JSON or — the format I'd argue everyone should use — **formatted SQL**, which is plain SQL with structured comments:

```sql
--liquibase formatted sql

--changeset steve:004
ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'NEW';
--rollback ALTER TABLE orders DROP COLUMN status;
```

A YAML master changelog `includeAll`s the directory and Spring Boot runs it at startup, recording each changeset in `databasechangelog`.

For the ten forward migrations, honestly: **the experience is nearly identical.** Same SQL, same startup behavior, same result (both demos assert the same final schema). The differences live in three places.

## Difference 1: Rollback

That `--rollback` line is Liquibase's headline feature. `liquibase rollback-count 1` after step 10 puts the `total` column and the old view back, because I wrote down how. Flyway has undo migrations (`U10__...sql`) — but **undo remains a paid Teams/Enterprise feature**; Flyway OSS strictly rolls forward.

Three honest observations from actually exercising this in the demo:

1. **Rollback SQL is only as good as your discipline.** Nothing validates that my `--rollback` block actually inverts the change until you run it. Untested rollback is documentation, not capability. (Changeset 10's rollback block is six statements long — writing it was a useful forcing function, _and_ a reminder of why people give up on maintaining them.)
2. **Data migrations don't really roll back.** Step 5's backfill rollback restores statuses — but only because the transformation was trivially invertible. Step 8 (dropping the assembled `name` column) can only be _approximately_ rolled back. Rollback is a DDL feature that data changes merely tolerate.
3. **Roll-forward is the real strategy anyway.** In CI/CD, the fix for a bad migration is the next migration — you can't "unrun" a change that production traffic has already written against. Which is exactly Flyway's philosophical position, and why its OSS tier gets away with not having undo.

So: if your org _requires_ scripted rollbacks (regulated environments, DBA sign-off processes), Liquibase gives you real machinery for free. If "fix forward" is your culture, this difference evaporates.

## Difference 2: Drift Detection

Someone hot-fixed an index directly on production. What does each tool tell you?

**Flyway OSS:** `flyway validate` checks that _applied migrations_ match your files (checksums). It says nothing about objects created outside migrations — drift detection and schema diffing live in the paid tiers.

**Liquibase OSS:** `liquibase diff` compares two live databases and reports extra/missing/changed objects, and `diff-changelog` will even write the reconciling changeset for you:

```bash
liquibase diff \
  --url=jdbc:postgresql://prod:5432/app \
  --reference-url=jdbc:postgresql://staging:5432/app
```

This is the most under-advertised free-tier gap between the tools. If you inherit databases with a history of manual surgery, Liquibase's diff alone can justify the choice.

## Difference 3: The Abstraction Tax

Liquibase's XML/YAML changesets (`createTable`, `addColumn`...) are database-portable and support preconditions and contexts — genuinely valuable if you ship one product to customers running Postgres, Oracle, _and_ SQL Server. But if you run one database you control, the abstraction is pure tax: another syntax between you and the SQL, and anything interesting (generated columns, `USING GIN`, partition DDL) ends up in `<sql>` escape hatches anyway. Formatted SQL changelogs — as in the demo — dodge most of the tax while keeping rollback and diff. If you adopt Liquibase, adopt it in formatted SQL.

Flyway never had the abstraction, which is precisely why its learning curve is a filename.

## What Changed Recently (Why "in 2026" Is in the Title)

Worth knowing before you commit either way:

- **Flyway** moved Postgres support (like other databases) into companion modules — you need `flyway-database-postgresql` alongside `flyway-core`, the omission of which is now the #1 Flyway startup error on upgrade.
- **Liquibase** deprecated a pile of legacy CLI names in 4.x (kebab-case commands like `rollback-count` are current) and keeps investing in `diff`/policy checks as its differentiators.
- **Both** remain first-class citizens in Spring Boot 4 — auto-config, health indicators, and [Actuator endpoints](/posts/ultimate-guide-spring-boot-actuator) (`/actuator/flyway`, `/actuator/liquibase`) that list applied migrations at runtime.
- **Licensing reality:** both OSS cores remain genuinely free; both companies monetize the ops features (undo, drift, checks, dashboards). Evaluate the free tier you'll actually use, not the marketing page.

## The Decision Table

| Your situation                                         | Pick                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| Single database you control, fix-forward culture       | **Flyway** — least machinery, filename-deep learning curve |
| Scripted, auditable rollbacks are mandatory            | **Liquibase** (formatted SQL + `--rollback`)               |
| You ship to customers on heterogeneous databases       | **Liquibase** (XML/YAML abstraction earns its tax)         |
| Inherited databases with manual-change history         | **Liquibase** (`diff` / `diff-changelog` in OSS)           |
| Team already knows one of them                         | **That one** — the gap doesn't justify retraining          |
| Greenfield Spring Boot service, no special constraints | **Flyway** — the boring default for a reason               |

## Summary

Run both through the same ten migrations and the forward path is a tie — plain SQL in, correct schema out, one `databasechangelog` table apart. The real differences are Liquibase's free rollback machinery and drift diffing versus Flyway's near-zero conceptual overhead. Match those against your org's actual requirements (not aspirational ones — will anyone _really_ test the rollback scripts?) and the decision takes five minutes.

Both projects — 10 migrations each, Testcontainers-verified against Postgres 18 — are at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/flyway-vs-liquibase) to use as starting templates. Like the [Spring compatibility cheatsheet](/posts/ultimate-guide-spring-boot-4-migration), I'll revisit this comparison when the landscape moves.

[flyway-docs]: https://documentation.red-gate.com/flyway
[liquibase-docs]: https://docs.liquibase.com/
[formatted-sql]: https://docs.liquibase.com/concepts/changelogs/sql-format.html
