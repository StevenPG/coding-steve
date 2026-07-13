---
author: StevenPG
pubDatetime: 2026-07-17T12:00:00.000Z
title: "Spring Boot 4.0 → 4.1: What's New and What Breaks"
slug: spring-boot-4-1-whats-new-what-breaks
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - kotlin
  - migration
description: A practical guide to upgrading from Spring Boot 4.0 to 4.1 — lazy datasource connections, @Async context propagation, cookie handling changes, Kotlin 2.3, first-party gRPC, SSRF hardening, and the small breaking changes that will actually bite you.
---

# Spring Boot 4.0 → 4.1: What's New and What Breaks

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. I wrote the [Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration) for the big 3.x → 4.0 jump; this is the follow-up for the much smaller — but not zero-effort — hop from 4.0 to 4.1, released June 10, 2026.

Minor releases in the Spring Boot world are supposed to be boring, and 4.1 mostly is. But "mostly boring" still includes a handful of behavior changes that will surface as failing tests or subtly different runtime behavior, plus several genuinely useful new features you should opt into deliberately rather than discover by accident. This post covers both halves: what's new worth adopting, and what breaks.

If you're coming from 3.x, do the [4.0 migration](/posts/ultimate-guide-spring-boot-4-migration) first — this post assumes you're already on 4.0.

## The Version Bump

```kotlin
// build.gradle.kts
plugins {
    id("org.springframework.boot") version "4.1.0"
    id("io.spring.dependency-management") version "1.1.7"
}
```

Key managed dependency changes in 4.1:

| Dependency | 4.0 | 4.1 |
|---|---|---|
| Spring Framework | 7.0.x | 7.0.8+ |
| Kotlin | 2.2 | **2.3** |
| Micrometer | 1.16 | 1.17 |
| OpenTelemetry | — | 1.62 |
| Spring gRPC | (external) | **1.1.0, first-party** |

## What's New

### Lazy DataSource Connections

The headline quality-of-life feature. Historically, Spring's `DataSourceTransactionManager` grabs a physical connection from the pool the moment a `@Transactional` method starts — even if the method does a cache lookup, decides it has nothing to do, and returns without touching the database. Under load, that's pool pressure for nothing.

4.1 adds a property that wraps the auto-configured pool in Spring's long-existing `LazyConnectionDataSourceProxy`:

```yaml
spring:
  datasource:
    connection-fetch: lazy   # default: eager
```

With `lazy`, the physical connection is fetched from Hikari only when a JDBC `Statement` is actually created. Transactions that never execute SQL never take a connection.

Where this pays off:

- **Cache-heavy services** — `@Transactional` service methods that usually hit Redis/Caffeine and only fall through to the DB on a miss.
- **Virtual threads** — with `spring.threads.virtual.enabled=true`, request concurrency can massively exceed pool size; deferring acquisition shortens each request's connection hold time. (Related reading: [Virtual Thread Pinning in 2026](/posts/virtual-thread-pinning-2026-jep-491).)
- **Startup** — connection acquisition moves off the startup path for eagerly-initialized components that open transactions.

One caveat before you flip it on globally: anything that relies on connection acquisition happening at transaction start — `SET` statements applied by a connection customizer, read-only routing that inspects the connection early, some multi-tenancy datasource routers — needs a test pass. The proxy defers *when* the connection appears, and code that assumed "transaction open = connection held" can be surprised. This is exactly the kind of change to roll out env-by-env behind your config layering.

### @Async Context Propagation

Trace IDs vanishing inside `@Async` methods has been a recurring papercut since the Sleuth days. In 4.1, Micrometer context (trace/span, baggage) automatically propagates into `@Async` executions — no more `TaskDecorator` boilerplate:

```java
// Before 4.1: you wrote this bean, or your traces broke at every @Async boundary
@Bean
TaskDecorator taskDecorator() {
    return ContextPropagatingTaskDecorator::new; // and wired it into the executor...
}

// 4.1: delete it. @Async methods pick up the caller's observation context.
@Async
public void enrichOrder(Order order) {
    // log statements here now carry the parent traceId/spanId
}
```

If you already had a custom `TaskDecorator` doing this, remove it during the upgrade so you don't double-wrap. If your decorator did *more* than context propagation, keep it but strip the propagation part.

### First-Party gRPC

Spring Boot 4.1 makes gRPC a first-party feature — starters under `org.springframework.boot`, versions in Boot's BOM, real autoconfiguration for servers and clients, and test support. This one deserved its own deep-dive and got one: [The Ultimate Guide to gRPC with Spring Boot 4.1](/posts/ultimate-guide-spring-grpc). Short version here:

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-grpc-server")
    implementation("org.springframework.boot:spring-boot-starter-grpc-client")
}
```

If you're on the third-party `grpc-spring-boot-starter`, 4.1 is the release where you should plan the switch.

### SSRF Hardening with InetAddressFilter

4.1 adds `org.springframework.boot.http.client.InetAddressFilter` — declare one bean and every auto-configured HTTP client (`RestClient`, `RestTemplate` via builder, and reactive `WebClient`) refuses to connect to addresses the filter rejects. Blocking cloud metadata endpoints (`169.254.169.254`) and RFC 1918 ranges application-wide is now a ten-line bean instead of a custom connector per client.

This also got its own post, because security keywords deserve complete treatment: [SSRF Hardening in Spring Boot 4.1 with InetAddressFilter](/posts/spring-boot-4-1-ssrf-inetaddressfilter).

### Kotlin 2.3

The Kotlin baseline moves from 2.2 to **2.3.21**. For most codebases this is a drop-in bump, but note:

- Kotlin 2.3 fully supports Java 25 targets.
- The experimental **unused return value checker** is worth enabling — it flags call sites that ignore a function's return value, which catches real bugs in `copy()`-style immutable APIs:

```kotlin
// build.gradle.kts
kotlin {
    compilerOptions {
        freeCompilerArgs.add("-Xreturn-value-checker=check")
    }
}
```

- If you pin a Kotlin version in your build (kapt/ksp processors, compiler plugins like `all-open`), bump them together. Mismatched compiler-plugin versions are the classic "works locally, fails in CI" of Kotlin upgrades.

### Smaller Additions Worth Knowing

- **OpenTelemetry:** a global `management.opentelemetry.enabled` toggle, OTLP exemplar support, and SSL bundles for OTLP exporters. If you were disabling OTel via a pile of individual properties, consolidate.
- **Spring Batch on MongoDB:** new `spring-boot-batch-data-mongo` starter with schema initialization via `spring.batch.data.mongo.schema.initialize`. (Batch 6 itself is covered in my [Ultimate Guide to Spring Batch 6](/posts/ultimate-guide-spring-batch-6).)
- **`@RedisListener` auto-configuration** — annotated listener methods are discovered and wired automatically, configured via `spring.data.redis.listener.*`.
- **Log4j2 file rotation** — size, time, size-and-time, and cron rotation strategies configurable via properties.

## What Breaks

Now the important half. None of these are 4.0-migration-sized, but each one is capable of eating an afternoon if it catches you blind.

### Cookie Handling in TestRestTemplate and HTTP Clients

`TestRestTemplate`'s cookie behavior now aligns with `RestTemplate` — meaning it no longer silently retains cookies across requests the way older configurations could. Integration tests that *accidentally* depended on session cookies persisting between calls (login in test A, authenticated call in test B against the same instance) will start failing with 401s.

The fix is to be explicit. Cookie handling is now a first-class setting:

```java
// Per-client, in tests
TestRestTemplate template = new TestRestTemplate().withCookieHandling();
```

```yaml
# Or globally for auto-configured clients
spring:
  http:
    clients:
      cookie-handling: true
```

My advice: treat any test that breaks here as a smell. Tests that depend on cookie state leaking between requests were coupled to incidental behavior; make the session explicit or use a dedicated authenticated client per test.

### Reactor HTTP Clients Now Respect System Proxy Properties

`ReactorClientHttpRequestFactoryBuilder` and `ReactorClientHttpConnectorBuilder` now configure `proxyWithSystemProperties()` by default, aligning with Spring Framework's behavior. If your JVM runs with `-Dhttp.proxyHost=...` set (very common in corporate environments, often set at the base-image level where nobody remembers it), your reactive `WebClient`s will start routing through that proxy after the upgrade.

Symptom: reactive outbound calls that worked in 4.0 start timing out or hitting a corporate proxy's auth wall in exactly one environment. Check `JAVA_TOOL_OPTIONS` and startup flags for proxy properties before you upgrade, and if you need the old behavior, configure the connector explicitly with `ProxyProvider` settings (or clear the system properties).

### Spring Data JPA Bootstrap Modes

Two related changes for people using deferred/lazy JPA bootstrapping to speed up startup:

- **`deferred` mode now requires a suitable `AsyncTaskExecutor` bean** and throws at startup if one isn't available. Previously it fell back quietly.
- **`lazy` mode no longer sets the auto-configured bootstrap executor** at all.

If you set `spring.data.jpa.repositories.bootstrap-mode: deferred` years ago and forgot about it, 4.1 may greet you with a startup exception. Either provide the executor bean it now demands or re-evaluate whether you still need deferred bootstrap at all — with [AOT caching](/posts/project-leyden-vs-graalvm-native-image) and CDS improvements, plain `default` mode plus a JVM-level startup cache often beats the deferred-bootstrap complexity now.

### Removals and Deprecations

- **Everything deprecated in 4.0 is removed.** If you upgraded to 4.0 with deprecation warnings still firing and ignored them, those calls are now compile errors. This is the release that collects.
- **Apache Derby is deprecated** (`DatabaseDriver.DERBY`, `EmbeddedDatabaseConnection.DERBY`). Migrate embedded-database tests to H2 or HSQLDB. Mechanical change, but if your test fixtures use Derby-specific SQL, budget time.
- **Layertools jar mode removed** — use the `tools` jar mode for extracting layered jars in Dockerfiles. If your Dockerfile says `-Djarmode=layertools`, change it to `-Djarmode=tools` and update the extract command syntax.
- **`-DskipTests` no longer skips AOT processing** in the Maven plugin — use `-Dmaven.test.skip` if you want both skipped. CI pipelines that relied on `skipTests` to shave AOT time off non-release builds will get slower until you adjust.
- **DevTools LiveReload is deprecated** (it was already disabled-by-default in 4.0). The direction of travel is clear; stop depending on it.
- **Dynatrace V1 API** configuration is deprecated — move to the V2 exporter configuration if you're on Dynatrace.

### The Upgrade Checklist

1. Bump the Boot plugin/BOM to 4.1.x; let the BOM move Kotlin to 2.3 and align your compiler plugins.
2. Fix compile errors from removed 4.0-deprecated APIs.
3. Search your Dockerfiles for `layertools`; replace with `tools`.
4. Check startup flags/base images for `http.proxyHost` etc. before deploying reactive apps.
5. Run the integration test suite; triage cookie-related 401s with explicit `withCookieHandling()` or better test design.
6. If you use `bootstrap-mode: deferred`, provide the `AsyncTaskExecutor` or drop the mode.
7. *Then*, deliberately adopt the new features: `connection-fetch: lazy` (with a test pass), delete your context-propagating `TaskDecorator`, add an `InetAddressFilter` bean, and enable the Kotlin return-value checker.

Steps 1–6 are an afternoon for a typical service. Step 7 is where the actual value is — don't skip it just because the upgrade "already works."

## Should You Wait?

The 4.1.x line had its `.0` release in June 2026; by now (mid-July) `4.1.1` is the sensible target — first patch releases in the Boot world reliably mop up the integration issues early adopters find. There's no reason to sit on 4.0 deliberately: 4.0.x open-source support ends on the standard 13-month clock, and everything interesting (gRPC, SSRF filtering, lazy connections) is landing on 4.1+.

## Resources

- [Spring Boot 4.1 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.1-Release-Notes)
- [InfoQ: Spring Boot 4.1 Adds gRPC Auto-Configuration, SSRF Mitigation, and Kotlin 2.3](https://www.infoq.com/news/2026/06/spring-boot-4-1/)
- [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration) (the 3.x → 4.0 companion to this post)
- [The Ultimate Guide to gRPC with Spring Boot 4.1](/posts/ultimate-guide-spring-grpc)
- [SSRF Hardening in Spring Boot 4.1 with InetAddressFilter](/posts/spring-boot-4-1-ssrf-inetaddressfilter)
- [Virtual Thread Pinning in 2026](/posts/virtual-thread-pinning-2026-jep-491)
