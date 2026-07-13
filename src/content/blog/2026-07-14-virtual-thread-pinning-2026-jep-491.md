---
author: StevenPG
pubDatetime: 2026-07-14T12:00:00.000Z
title: "Virtual Thread Pinning in 2026: What JEP 491 Fixed and What Still Pins"
slug: virtual-thread-pinning-2026-jep-491
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - virtual threads
  - performance
  - spring boot
description: JDK 24's JEP 491 fixed synchronized-based virtual thread pinning, but production apps in 2026 still hit pinning from native code and memory bloat from thread-locals. What actually pins today, how to detect it with JFR, and how to fix each case.
---

# Virtual Thread Pinning in 2026: What JEP 491 Fixed and What Still Pins

## Table of Contents

[[toc]]

## Introduction

Virtual threads are the single most-adopted Java feature of the last few years, and "pinning" is the word that has haunted them since JDK 21. If you read anything about virtual threads in 2023–2024, you read a warning that `synchronized` blocks would pin your virtual threads to their carriers and quietly destroy your throughput.

Here's the thing: **most of that advice is now outdated.** JEP 491 shipped in JDK 24 (March 2025) and eliminated the `synchronized` pinning problem at the JVM level. If you're on JDK 24, or on the JDK 25 LTS that most of us deployed over the past year, the number one thing the internet told you to fear no longer exists.

But pinning is not gone. It moved. And a second problem — thread-local memory bloat — has quietly replaced it as the thing that actually takes virtual-thread apps down in production.

My goal is to make posts like this the SIMPLEST place on the internet to learn things that caused me trouble. This post covers what JEP 491 actually changed, what still pins in 2026, how to detect all of it with JFR, and the fixes for each case. If you want proof that virtual-thread-style concurrency matters for real workloads, I benchmarked Spring Boot's concurrency stack head-to-head against Go in my [GraalVM Native Spring Boot vs Go benchmark](/posts/go-vs-spring-boot-native-benchmark) — the concurrency model is exactly where the interesting differences showed up.

## A 60-Second Refresher: What Pinning Is

A virtual thread runs by being *mounted* on a platform ("carrier") thread from a small scheduler pool — by default, one carrier per CPU core. When a virtual thread blocks (socket read, lock wait, sleep), the JVM *unmounts* it, freeing the carrier to run another virtual thread. That's the entire trick: millions of cheap blocking threads multiplexed over a handful of expensive OS threads.

**Pinning** is when the JVM cannot unmount a blocked virtual thread. The virtual thread stays welded to its carrier, the carrier can't run anything else, and if enough virtual threads pin simultaneously you exhaust the carrier pool. Best case: latency spikes. Worst case: a hard deadlock, because the virtual threads that would release the locks can't get a carrier to run on.

Before JDK 24, there were two big triggers:

1. Blocking inside a `synchronized` block or method
2. Blocking inside native code (JNI / FFM downcalls)

## What JEP 491 Fixed

[JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491) landed in JDK 24. The JVM's monitor implementation previously tracked lock ownership by *carrier thread* identity — so if a virtual thread entered `synchronized` and then blocked, the JVM couldn't unmount it without corrupting the ownership bookkeeping. JEP 491 reimplemented monitors to track ownership by *virtual thread* identity, with the bookkeeping updated at every mount and unmount.

The consequences, on JDK 24+ (including JDK 25 LTS):

- Blocking on I/O **inside a `synchronized` block** no longer pins. The virtual thread unmounts; the monitor stays owned by the virtual thread; when the I/O completes it remounts (possibly on a different carrier) still holding the lock.
- Blocking **while waiting to enter** a contended `synchronized` block no longer pins.
- `Object.wait()` inside virtual threads no longer pins.

This is why the classic advice — "replace all your `synchronized` with `ReentrantLock` before adopting virtual threads" — is dead. Worse than dead: it caused real harm. Teams did mass mechanical rewrites of stable, battle-tested synchronization code, introduced subtle bugs (a `ReentrantLock` doesn't release itself when you forget the `finally`), and got nothing for it on modern JDKs. If you're on JDK 24+, `synchronized` is fine. Leave your code alone.

The related diagnostic changed too: `-Djdk.tracePinnedThreads` is **gone** (it was removed along with the old implementation). The JFR event `jdk.VirtualThreadPinned` is now the tool, and it got better — more on that below.

### The Version Matrix

| JDK | `synchronized` pins? | `Object.wait()` pins? | Native/JNI pins? | Notes |
|---|---|---|---|---|
| 21 (LTS) | Yes | Yes | Yes | Original virtual threads GA. All the old warnings apply. |
| 22–23 | Yes | Yes | Yes | No pinning changes. |
| 24 | **No** | **No** | Yes | JEP 491. |
| 25 (LTS) | **No** | **No** | Yes | The LTS most production apps target in 2026. |
| 26 | **No** | **No** | Yes | Native-frame pinning is architectural, not a bug backlog item. |

If you are still running virtual threads on JDK 21 in mid-2026: the single highest-leverage performance change available to you is moving to JDK 25. Not tuning, not rewriting — upgrading.

## What Still Pins in 2026

### 1. Native Frames: JNI and FFM Downcalls

When a virtual thread has a **native frame** on its stack — it called into C code via JNI or a Foreign Function & Memory API downcall — and blocks, it pins. This is architectural: native code may hold pointers into the stack, use OS thread-local storage, or make assumptions about the OS thread identity. The JVM cannot relocate a stack that native code is looking at, so it cannot unmount the thread.

This will not be "fixed" in a future JEP. It's the permanent boundary of the model.

Where this actually bites in production:

- **JDBC drivers with native components.** Pure-Java drivers (PostgreSQL's `pgjdbc`, MySQL Connector/J, modern MS SQL drivers) are fine — they block in Java socket code, which unmounts cleanly. The trouble is drivers that route through native client libraries: Oracle OCI-mode (thick) driver, DB2 type-2 drivers, SQLite via JNI (`sqlite-jdbc`), DuckDB's JDBC driver. Every query on those holds a carrier for its full duration.
- **Native cryptography providers** — PKCS#11 HSM integrations, Conscrypt, native OpenSSL bindings.
- **Native compression/media libraries** — anything wrapping zstd, image codecs, ffmpeg.
- **gRPC with the Netty native transport** is mostly fine because Netty does its blocking on its own event-loop platform threads, but watch any library that does *blocking* JNI calls on *your* request threads.

**The fix** is confinement, not avoidance: run native-blocking calls on a small, dedicated, *bounded* platform-thread pool so they can't eat your carriers:

```java
// A bounded platform-thread island for native-blocking work.
// Size it like a classic connection/worker pool - it IS one.
private static final ExecutorService NATIVE_POOL =
    Executors.newFixedThreadPool(16, Thread.ofPlatform()
        .name("native-io-", 0)
        .factory());

Result queryViaNativeDriver(Query q) throws Exception {
    // Virtual thread parks here (unmounts cleanly - Future.get is Java blocking),
    // while the native call runs on a platform thread that's allowed to block.
    return NATIVE_POOL.submit(() -> nativeDriverCall(q)).get();
}
```

The virtual thread blocks on `Future.get()`, which is ordinary Java blocking and unmounts fine. The native call happens on a platform thread whose entire job is to be blocked. You've re-invented a worker pool, yes — that's the point. Virtual threads don't eliminate pools; they eliminate pools *for Java-blocking work*.

### 2. Class Initializers and Other Corner Cases

Blocking inside a class's static initializer (`<clinit>`) can still pin, because class initialization holds a JVM-internal lock with special semantics. You'd have to be blocking on I/O during class-load — lazy config fetching in a static block, say — which is a thing I have absolutely seen in enterprise codebases. Move that work out of static initializers (you should anyway).

`ThreadLocalRandom` is fine, file I/O is fine (it consumes a thread from an internal pool on some platforms but doesn't pin), and `System.out.println` — the classic "it's synchronized!" worry — stopped mattering with JEP 491.

### 3. The Problem That Replaced Pinning: Thread-Local Memory Bloat

Here's my actual production-issues ranking for virtual threads in 2026:

1. Thread-local memory bloat
2. Unbounded concurrency downstream (connection pool exhaustion)
3. Native pinning
4. `synchronized` pinning (only on stale JDKs)

The thread-local problem: a decade of Java libraries adopted the pattern *"this object is expensive (a `SimpleDateFormat`, a Jackson buffer, a crypto cipher, a 64KB scratch array), so cache one per thread in a `ThreadLocal`."* That pattern has a hidden assumption — **threads are few and long-lived, so the cache amortizes.**

Virtual threads invert both assumptions. You have *millions* of threads and they live for *one request*. Now every thread-local "cache" is allocated once, used once, and garbage — or worse, if virtual threads are kept alive (queued, waiting), you're holding `live_threads × cached_object_size` on the heap. A 64KB buffer cached per-thread across 100,000 in-flight virtual threads is 6.4GB of "cache" doing nothing.

The signature in production is **non-linear heap growth as concurrency scales** — everything is fine at 1,000 concurrent requests and OOMs at 50,000, with the heap dominated by whatever the library was caching.

Detection tools:

```bash
# Trace every thread-local mutation on virtual threads, with stack traces
java -Djdk.traceVirtualThreadLocals ...

# Watch native + heap growth under load
java -XX:NativeMemoryTracking=summary ...
jcmd <pid> VM.native_memory summary
```

Fixes, in order of preference:

1. **Upgrade the library.** Most major libraries (Jackson, Netty, modern JDBC drivers) have shipped virtual-thread-aware pooling since 2024 — bounded shared pools instead of per-thread caching.
2. **Replace your own `ThreadLocal` caches with a small object pool** (or just... allocate. Modern GCs eat short-lived allocation for breakfast; the per-thread cache was often a 2010-era optimization).
3. **For context propagation** (not caching), migrate `ThreadLocal` to **Scoped Values** ([JEP 506](https://openjdk.org/jeps/506), final in JDK 25). Scoped values are immutable, bounded to a scope, cheap to inherit across `StructuredTaskScope` forks, and cannot leak the way thread-locals do.

```java
// Before: context via ThreadLocal
static final ThreadLocal<RequestContext> CTX = new ThreadLocal<>();

// After: context via ScopedValue (JDK 25+)
static final ScopedValue<RequestContext> CTX = ScopedValue.newInstance();

ScopedValue.where(CTX, requestContext).run(() -> handleRequest());
// CTX.get() anywhere below this frame; automatically unbound when run() returns
```

## Detecting Pinning with JFR

The `jdk.VirtualThreadPinned` event is your early-warning system, and it's enabled in JFR's default configuration (it fires when a pin lasts longer than 20ms by default).

```bash
# Continuous recording in production - negligible overhead
java -XX:StartFlightRecording=name=vt,maxsize=256m,maxage=12h ...

# Dump and inspect
jcmd <pid> JFR.dump name=vt filename=vt.jfr
jfr print --events jdk.VirtualThreadPinned vt.jfr
```

Post-JEP-491 the event carries the *reason* and the blocking stack trace, so a native pin looks unmistakably like one — you'll see the JNI/FFM frame right there. The second event worth alerting on is `jdk.VirtualThreadSubmitFailed`, which fires when the scheduler can't accept work — the smoke alarm for carrier exhaustion.

If you run Spring Boot with Micrometer, `jvm.threads.started` exploding while `jvm.threads.live` stays flat is normal for virtual threads (that's the model working); what you alert on is pinned-event *rate* and carrier pool utilization (`jdk.internal.misc` scheduler metrics are exposed via JFR; Boot's `executor` metrics cover your explicit pools).

For load-shaped experiments before production, the methodology from my [Go vs Spring Boot benchmark post](/posts/go-vs-spring-boot-native-benchmark) applies directly: a downstream echo server with deliberate 10ms latency and a fixed-concurrency load generator makes carrier starvation visible within seconds — pinned carriers show up as a hard throughput ceiling at `carrier_count / pin_duration` requests per second, a flat line where you expected linear scaling.

## Spring Boot Specifics

For Spring Boot 3.2+ / 4.x, virtual threads are one property:

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

That switches Tomcat's request handling, `@Async` (unless you defined your own executor), Kafka listener containers, and scheduled tasks onto virtual threads. Things to know in 2026:

- **JDK floor:** if you enable this, run JDK 25. Running virtual threads on JDK 21 in 2026 means volunteering for the pre-JEP-491 pinning behavior for no reason. (Spring Boot 4 requires 21+; see my [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration).)
- **Connection pools are still finite.** Virtual threads remove the *thread* ceiling, which means the next ceiling — usually Hikari's default 10 connections — arrives immediately. If you turn on virtual threads and latency gets *worse*, check `hikaricp.connections.pending` first. Size the pool for the database's capacity, and let virtual threads queue on the pool (that's cheap now).
- **`@Async` context propagation** got meaningfully better in Spring Boot 4.1 — Micrometer context (trace IDs) now follows work across thread boundaries automatically. I cover this in the [Spring Boot 4.0 → 4.1 post](/posts/spring-boot-4-1-whats-new-what-breaks).
- **Semaphores are your rate limiter.** The virtual-thread-native way to protect a fragile downstream is a plain `java.util.concurrent.Semaphore` around the call, not a thread pool size.

## The 2026 Checklist

1. **Get on JDK 25.** Erases `synchronized` pinning entirely.
2. **Delete `ReentrantLock` conversions you made "for virtual threads"** next time you touch that code — they're noise now (don't do a rewrite crusade in reverse either).
3. **Audit for native code**: `find` your dependency tree for JNI/FFM users — thick JDBC drivers, native crypto, native compression. Confine each behind a bounded platform-thread pool.
4. **Audit `ThreadLocal` usage** with `-Djdk.traceVirtualThreadLocals` under a load test. Caching → pools or plain allocation. Context → Scoped Values.
5. **Run JFR continuously** and alert on `jdk.VirtualThreadPinned` rate and `jdk.VirtualThreadSubmitFailed`.
6. **Re-check downstream limits**: Hikari pool size, HTTP client connection pools, and semaphores around fragile services.

Pinning went from "the reason to be scared of virtual threads" to "one bounded, detectable, fixable issue on a list of three." That's what maturity looks like.

## Resources

- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 506: Scoped Values](https://openjdk.org/jeps/506)
- [Java 24 — Thread pinning revisited (mikemybytes)](https://mikemybytes.com/2025/04/09/java24-thread-pinning-revisited/)
- [GraalVM Native Spring Boot vs Go — Build, Boot, and Benchmark](/posts/go-vs-spring-boot-native-benchmark) (my benchmark methodology)
- [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration)
