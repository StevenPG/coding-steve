---
author: StevenPG
pubDatetime: 2026-07-26T12:00:00.000Z
title: "Structured Concurrency (JEP 525): A Practical Guide"
slug: structured-concurrency-jep-525-practical-guide
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - virtual threads
  - concurrency
description: A hands-on guide to Java's structured concurrency API as of JEP 525 in JDK 26 — StructuredTaskScope, every built-in Joiner, custom joiners, timeouts, cancellation semantics, ScopedValue integration, and how to use preview APIs in a real Gradle build.
---

# Structured Concurrency (JEP 525): A Practical Guide

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Structured concurrency has been previewing in the JDK since Java 19, and [JEP 525](https://openjdk.org/jeps/525) in JDK 26 is the **sixth preview** — with API changes small enough that the message is unmistakable: this is the shape it will finalize in, and finalization is expected before the end of 2026.

Which means now is exactly the right time to learn it. This guide covers the current API in full: `StructuredTaskScope.open()`, every built-in `Joiner`, timeouts, cancellation semantics, custom joiners, and how it composes with Scoped Values and virtual threads. Everything here targets **JDK 26 with `--enable-preview`**.

If virtual threads are new to you, read my [Virtual Thread Pinning in 2026](/posts/virtual-thread-pinning-2026-jep-491) post first — structured concurrency is the *organizing principle* for the millions of cheap threads that virtual threads give you.

> **Maintenance note:** when JEP 525's successor finalizes, I'll update this post and bump the `modDatetime` — the API below is expected to carry into finalization with at most cosmetic changes.

## The Problem: Unstructured Concurrency

Here's the standard "aggregate two backends" method, written with what we had before:

```java
Response handle(String userId) throws Exception {
    Future<Profile> profileF = executor.submit(() -> fetchProfile(userId));
    Future<List<Order>> ordersF = executor.submit(() -> fetchOrders(userId));
    return new Response(profileF.get(), ordersF.get());
}
```

Count the failure modes:

1. `fetchProfile` throws → `profileF.get()` throws → **`ordersF` keeps running**, burning a thread and a downstream connection for a response nobody will read. That's a thread *leak*.
2. `fetchOrders` fails instantly → we don't find out until `profileF.get()` returns; the failure is *delayed* by the slower sibling.
3. The handling thread is interrupted → neither subtask is cancelled. They're orphans.
4. Read a thread dump next week: nothing tells you these three threads were related.

Every fix (cancellation callbacks, `CompletableFuture.allOf` with `whenComplete` cleanup, try/finally cancel chains) adds code that's easy to get subtly wrong. The insight of structured concurrency is that this is the same disease `goto` had: concurrent lifetimes that don't nest. The cure is the same one structured programming applied to control flow — **make the lifetime a block**. A task's subtasks must all complete before the task leaves the block, the same way a called function returns before its caller does.

## The Basic Pattern

```java
import java.util.concurrent.StructuredTaskScope;

Response handle(String userId) throws InterruptedException {
    try (var scope = StructuredTaskScope.open()) {
        var profile = scope.fork(() -> fetchProfile(userId));
        var orders  = scope.fork(() -> fetchOrders(userId));

        scope.join();   // wait for both; throws if either failed

        return new Response(profile.get(), orders.get());
    }
}
```

What you get, mechanically:

- **`open()`** creates a scope; each **`fork()`** starts a subtask on a *new virtual thread* (that's the default and almost always what you want).
- **`join()`** blocks until the scope's policy says we're done. With the default policy (all subtasks succeed or the first failure wins), a failure in either subtask **cancels the other** — cancellation means interrupting its thread — and `join()` throws a `FailedException` with the original exception as its cause.
- **The try-with-resources close** guarantees no subtask outlives the block, even if you exit exceptionally. If you forget `join()`, `close()` throws `StructureViolationException` — the API refuses to be misused quietly.
- Interrupt the handling thread and the interruption propagates: both subtasks get cancelled, the scope unwinds. Failure mode #3 from above is just... gone.
- In a thread dump (`jcmd <pid> Thread.dump_to_file -format=json ...`), the subtasks appear **as children of the scope** — the runtime knows the tree, so you can read it.

`fork()` returns a `Subtask<T>`, not a `Future`. It has no blocking `get`-with-timeout, no cancel — deliberately. You interrogate it **after `join()`**: `subtask.get()` for a success, `subtask.exception()` for a failure, `subtask.state()` to ask which.

## Joiners: The Policy Layer

Everything above used the default policy. The `Joiner` you pass to `open(...)` decides what "done" means and what `join()` returns. The built-ins cover the four patterns that make up ~95% of real fan-out code:

### 1. All succeed, heterogeneous results — `awaitAllSuccessfulOrThrow()`

The default (what no-arg `open()` gives you). `join()` returns `void`; you pull each typed result from its own `Subtask`. Use when subtasks return *different types* — the profile-and-orders example above.

### 2. All succeed, homogeneous results — `allSuccessfulOrThrow()`

```java
List<Quote> fetchAllQuotes(List<Supplier> suppliers) throws InterruptedException {
    try (var scope = StructuredTaskScope.open(
            StructuredTaskScope.Joiner.<Quote>allSuccessfulOrThrow())) {
        suppliers.forEach(s -> scope.fork(() -> s.quote()));
        return scope.join();   // List<Quote>, in fork order
    }
}
```

As of JEP 525, `join()` here returns a materialized **`List<T>` in fork order** — earlier previews returned a `Stream` of subtasks, and the list is one of the sixth preview's quality-of-life refinements. Join first, then consume.

### 3. First success wins — `anySuccessfulResultOrThrow()`

Hedging: race replicas, take the fastest, cancel the rest.

```java
Quote fetchFastest(List<Endpoint> replicas) throws InterruptedException {
    try (var scope = StructuredTaskScope.open(
            StructuredTaskScope.Joiner.<Quote>anySuccessfulResultOrThrow())) {
        replicas.forEach(r -> scope.fork(() -> queryReplica(r)));
        return scope.join();   // first success; losers are cancelled
    }
}
```

The cancellation is the point — with plain futures, hedged requests usually leak the losers, and downstream services feel it. Here the losing requests are interrupted the moment a winner lands. `join()` throws only if *every* subtask failed.

### 4. Run to completion regardless — `awaitAll()`

No short-circuit on failure; wait for everything, then inspect subtasks individually. This is for "notify all three systems, then report which ones failed" — batch semantics where one failure shouldn't abort the siblings.

### Timeouts

Deadline handling is a configuration function on `open`, not another joiner:

```java
try (var scope = StructuredTaskScope.open(
        StructuredTaskScope.Joiner.<Quote>allSuccessfulOrThrow(),
        cf -> cf.withTimeout(Duration.ofSeconds(2))
                .withName("quote-fanout"))) {
    suppliers.forEach(s -> scope.fork(() -> s.quote()));
    return scope.join();   // TimeoutException after 2s; stragglers cancelled
}
```

The timeout covers the *whole scope* — one deadline for the fan-out, not a per-call timeout multiplied across retries. When it fires, every unfinished subtask is cancelled and `join()` throws. `withName` labels the scope's threads for dumps and JFR, which future-you will appreciate during an incident. The sixth preview also gave *custom* joiners a timeout callback (`onTimeout`) so a bespoke policy can decide what a deadline means — return partial results, say — instead of always failing.

### Custom Joiners: Partial Results

The built-ins fail hard or wait for all. A common production need is in between — "give me whatever arrived within the deadline":

```java
// Collect successes; never cancel siblings; on timeout, keep what we have.
class PartialResults<T> implements StructuredTaskScope.Joiner<T, List<T>> {
    private final Queue<T> results = new ConcurrentLinkedQueue<>();

    @Override
    public boolean onComplete(StructuredTaskScope.Subtask<? extends T> subtask) {
        if (subtask.state() == StructuredTaskScope.Subtask.State.SUCCESS) {
            results.add(subtask.get());
        }
        return false;   // false = don't cancel the scope; keep waiting
    }

    @Override
    public List<T> result() {
        return List.copyOf(results);
    }
}
```

Wire it with a timeout and you have the "best-effort aggregation" pattern (search results, recommendation tiles, dashboard widgets) in one small class instead of a `CompletableFuture` sculpture. A `Joiner` implementation must be thread-safe (`onComplete` runs on subtask threads) and fresh per scope — don't share instances.

## Scoped Values: Context Without ThreadLocal

Structured concurrency's companion API is `ScopedValue` (final since JDK 25). Bindings visible in the parent frame are **automatically inherited by every `fork`**, immutable, and unbound when the scope ends:

```java
static final ScopedValue<RequestContext> CTX = ScopedValue.newInstance();

Response handle(Request req) throws InterruptedException {
    return ScopedValue.where(CTX, RequestContext.from(req)).call(() -> {
        try (var scope = StructuredTaskScope.open()) {
            var a = scope.fork(() -> serviceA());  // CTX.get() works in here
            var b = scope.fork(() -> serviceB());  // ...and in here
            scope.join();
            return combine(a.get(), b.get());
        }
    });
}
```

With `ThreadLocal` + raw executors, context propagation into pooled threads was a per-framework adventure (and a memory-bloat hazard I covered in the [pinning post](/posts/virtual-thread-pinning-2026-jep-491)). Here it's structural: the child can see the parent's bindings *because* its lifetime nests inside the parent's. The runtime even enforces the nesting — close scopes out of order and you get `StructureViolationException`.

## Running Preview Code in a Real Build

Preview APIs need the flag at compile time *and* runtime, same JDK feature version for both:

```kotlin
// build.gradle.kts — JDK 26
java { toolchain { languageVersion = JavaLanguageVersion.of(26) } }

tasks.withType<JavaCompile> { options.compilerArgs.add("--enable-preview") }
tasks.withType<Test> { jvmArgs("--enable-preview") }
tasks.withType<JavaExec> { jvmArgs("--enable-preview") }
```

Rules I follow for previews in shipped code, having been burned before:

- **Confine usage** behind your own small interface (`Fanout.all(tasks)`, `Fanout.fastest(tasks)`). When the final API lands (or tweaks a method name, as previews 1→6 repeatedly did — `open()` itself only appeared in the fifth preview), you touch one class.
- **Libraries should not ship preview APIs**; applications, which control their own runtime flag, can.
- Class files compiled with `--enable-preview` are stamped with the exact JDK feature version — they will not load on 25 or 27. Plan your rollout accordingly.

## Where This Fits in a Spring Boot Service

Until Spring grows first-class support (it will), the natural insertion point is *inside* service methods that fan out — the transaction/request machinery around them doesn't need to know:

```java
@Service
class CheckoutService {
    ProductPage productPage(String sku) throws InterruptedException {
        try (var scope = StructuredTaskScope.open(
                StructuredTaskScope.Joiner.awaitAllSuccessfulOrThrow(),
                cf -> cf.withTimeout(Duration.ofMillis(800)))) {
            var details = scope.fork(() -> catalogClient.details(sku));
            var price   = scope.fork(() -> pricingClient.price(sku));
            var stock   = scope.fork(() -> inventoryClient.stock(sku));
            scope.join();
            return new ProductPage(details.get(), price.get(), stock.get());
        }
    }
}
```

Two Spring-specific cautions. First, **transactions do not follow forks** — a `fork` runs on a new thread with no transaction context; do your fan-out for *reads* and keep writes on the request thread. Second, security/observability context: `ScopedValue`-native propagation is coming to the frameworks, but today Micrometer context propagation covers `@Async` ([new in Boot 4.1](/posts/spring-boot-4-1-whats-new-what-breaks)), not hand-rolled scopes — if you need trace continuity inside forks, capture the context before forking and restore it in the subtask.

## When *Not* to Use It

- **Pipelines and streams** — structured concurrency models *hierarchical* fan-out/fan-in. Staged dataflow (consume→transform→publish) is better served by queues or reactive streams / [Spring Cloud Stream](/posts/ultimate-guide-spring-cloud-streams).
- **Long-lived background work** — a scope is request-scoped by nature; a task that outlives the request *should* be unstructured (that's what schedulers and message queues are for).
- **CPU-bound parallelism** — `ForkJoinPool`/parallel streams already do work-stealing decomposition well; virtual threads add nothing for pure computation.

The heuristic: if you'd draw it as a tree that collapses back to one node, it's structured concurrency. If you'd draw it as a conveyor belt, it isn't.

## Summary

- Structured concurrency makes concurrent lifetimes nest like function calls: fork inside a scope, join before you leave, nothing leaks — enforced by the runtime, visible in thread dumps.
- JEP 525 (JDK 26, sixth preview) is the stabilization lap: `allSuccessfulOrThrow()` now returns a `List` in fork order, custom joiners get timeout callbacks, and finalization is expected within the year.
- Learn the four built-in joiners; reach for a custom `Joiner` when you need partial results; put deadlines on the scope, not the calls.
- Pair it with `ScopedValue` for context and virtual threads for scale — the three features are one design.

## Resources

- [JEP 525: Structured Concurrency (Sixth Preview)](https://openjdk.org/jeps/525)
- [JEP 505: Structured Concurrency (Fifth Preview)](https://openjdk.org/jeps/505) (where `open()` was introduced)
- [JEP 506: Scoped Values](https://openjdk.org/jeps/506)
- [InfoQ: JEP 525 Brings Timeout Handling and Joiner Refinements](https://www.infoq.com/news/2026/01/timeout-joiner-refinements/)
- [Virtual Thread Pinning in 2026: What JEP 491 Fixed and What Still Pins](/posts/virtual-thread-pinning-2026-jep-491) (my companion post)
- [The Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams) (for when the answer is a pipeline, not a tree)
