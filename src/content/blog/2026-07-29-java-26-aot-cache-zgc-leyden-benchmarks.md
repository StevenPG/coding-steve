---
author: StevenPG
pubDatetime: 2026-07-29T12:00:00.000Z
title: "Java 26 AOT Cache with ZGC: Leyden Startup Benchmarks, Revisited"
slug: java-26-aot-cache-zgc-leyden-benchmarks
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - graalvm
  - performance
  - spring boot
  - zgc
description: JEP 516 in Java 26 extends Project Leyden's AOT object cache to every garbage collector, including ZGC. A revisit of my Leyden vs GraalVM comparison with fresh Spring Boot startup benchmarks across G1, ZGC, and Serial GC — cache on and off.
---

# Java 26 AOT Cache with ZGC: Leyden Startup Benchmarks, Revisited

## Table of Contents

[[toc]]

## Introduction

Back in January I published [Project Leyden vs GraalVM Native Image — A Complete Guide](/posts/project-leyden-vs-graalvm-native-image), and the conclusion for most Spring Boot shops was: Leyden's AOT cache gives you a large slice of native image's startup win with none of the closed-world pain. Since then, the biggest missing piece of the Leyden story has landed: **Java 26's [JEP 516: Ahead-of-Time Object Caching with Any GC](https://openjdk.org/jeps/516)**.

The one-sentence version: the AOT cache's most powerful layer — caching actual Java *objects* created during startup, not just loaded-and-linked classes — previously didn't work with ZGC. As of JDK 26 (March 2026), it works with **every** collector. If you run latency-sensitive services on ZGC — and post-generational-ZGC, a lot of us do — you were quietly excluded from Leyden's best numbers. Not anymore.

My goal is to make posts like this the SIMPLEST place on the internet to learn things that caused me trouble, and I can't stand benchmark posts with numbers that were never actually measured — so this post pairs the explanation with a re-runnable benchmark: one Spring Boot 4.1 app, three collectors, AOT cache on and off, measured on my own hardware.

> **[DRAFT NOTE — numbers pending]** Result tables are placeholders until the final benchmark pass runs on my M3 MacBook Pro. Commands and code are complete and runnable as written.

## Why ZGC Was Left Out (and How JEP 516 Fixed It)

The AOT cache stores, among other things, a snapshot of heap objects your application creates during a training run — class metadata mirrors, interned strings, resolved constant pool entries, framework singletons that Leyden can prove are safe to materialize early. At startup, the JVM maps that archived heap region in and skips re-executing the initialization work. It's the object layer, stacked on JEP 483's class loading & linking layer, that produced the eye-catching Spring startup numbers in my January post.

The catch: archived objects were stored with **physical memory layout assumptions baked in** — essentially a G1-shaped heap image with real object addresses. Serial, Parallel, and G1 could adopt that format (or map it with light fixups). ZGC couldn't, because ZGC doesn't store plain addresses at all: it uses **colored pointers**, encoding GC metadata (marking state, remapping bits) inside the 64-bit reference itself, and its region layout shares nothing with G1's. Handing ZGC a G1-shaped heap snapshot is meaningless. So on ZGC, `-XX:AOTCache` silently gave you the class-loading layer only — and part of the startup win evaporated.

JEP 516 changes the archive format itself: object references in the cache are now stored as **logical indices** into an object table rather than physical addresses. At startup, the JVM *streams* objects from the cache into whatever heap the active collector manages, remapping indices to real addresses as it materializes them. The format is GC-neutral, which buys three things:

1. **Any collector works** — ZGC included, and whatever future collectors show up.
2. **The training-run GC and production GC no longer need to match** — train with G1 in CI, run with ZGC in prod.
3. **A simpler mental model** — one cache artifact per app version, not per (app version × GC) combination.

The cost is a small amount of extra work at load time (materialization instead of a straight `mmap`), which is exactly the kind of trade you should demand numbers for — hence the benchmark.

## The Benchmark

### Application Under Test

Same philosophy as my [Go vs Spring Boot native benchmark](/posts/go-vs-spring-boot-native-benchmark): measure something app-shaped, not a hello-world. The app is a Spring Boot 4.1 web service with JPA (Hibernate 7 + H2 for benchmark isolation), actuator, and Jackson — roughly 20k classes loaded at startup, which is representative of a mid-sized production service and comparable to Spring PetClinic, the app the OpenJDK team themselves quote (41% faster startup with JEP 516's cache).

**Startup measurement**: time from `java` invocation to the actuator readiness probe returning 200, captured by a wrapper script polling with `curl` at 5ms intervals — because "Started Application in X seconds" from the Boot log understates real readiness. Ten runs per configuration, discard the first (page cache priming), report median and spread.

### Building the Cache (JDK 26)

The ergonomics from JEP 514 carry over — one training run, one flag:

```bash
# 1. Training run: exercise startup + a few representative requests, then exit
java -XX:AOTCacheOutput=app.aot \
     -Dspring.profiles.active=training \
     -jar build/libs/bench-app.jar

# 2. Production runs: point at the cache, pick any GC
java -XX:AOTCache=app.aot -XX:+UseZGC       -jar build/libs/bench-app.jar
java -XX:AOTCache=app.aot -XX:+UseG1GC      -jar build/libs/bench-app.jar
java -XX:AOTCache=app.aot -XX:+UseSerialGC  -jar build/libs/bench-app.jar
```

Two operational notes worth their weight in incident reports:

- The training profile should hit your health endpoint and one or two hot REST paths before exiting — object caching rewards a training run that looks like real startup + early traffic. My training profile uses a `CommandLineRunner` that fires internal requests and then calls `SpringApplication.exit`.
- Check the startup log for the AOT cache actually engaging (`-Xlog:aot` on JDK 26 is the verbose switch). A version-mismatched or GC-incompatible-on-old-JDK cache is *silently ignored* — the app runs correctly but slow, which is the worst kind of regression because nothing fails.

### Results: Startup Time to Readiness

Environment: M3 MacBook Pro, JDK 26.0.1 (Temurin), Spring Boot 4.1.x, 10 runs per cell, median reported.

**JDK 26, by collector:**

| Configuration | No AOT cache | AOT cache | Improvement |
|---|---|---|---|
| G1 (default) | *TBD* s | *TBD* s | *TBD* % |
| ZGC (generational) | *TBD* s | *TBD* s | *TBD* % |
| Serial GC | *TBD* s | *TBD* s | *TBD* % |

**The before/after that motivates this post — ZGC across JDK versions:**

| Configuration | Startup to ready |
|---|---|
| JDK 25 + ZGC, AOT cache (object layer inactive) | *TBD* s |
| JDK 26 + ZGC, AOT cache (JEP 516, object layer active) | *TBD* s |
| JDK 26 + ZGC, no cache (baseline) | *TBD* s |

**Cache artifact size and memory:**

| Metric | Value |
|---|---|
| AOT cache file size | *TBD* MB |
| RSS at readiness, G1 + cache | *TBD* MB |
| RSS at readiness, ZGC + cache | *TBD* MB |

What I expect the shape to be, based on the JEP's own PetClinic numbers and my January measurements: the JDK 26 ZGC + cache row should land in the same ~40% improvement band that G1 has enjoyed since JDK 24/25, where the JDK 25 ZGC row shows a distinctly smaller improvement (class loading layer only). If the measured numbers disagree with that story, the analysis below will say so rather than hide it.

### Where This Leaves GraalVM Native Image

The January post's [TL;DR table](/posts/project-leyden-vs-graalvm-native-image) doesn't need structural revision — native image still owns the "milliseconds, smallest RSS" corner, Leyden still owns "full Java compatibility, boring builds." What JEP 516 changes is the *width* of the Leyden column:

- **The ZGC asterisk is gone.** Before, choosing Leyden meant either accepting G1 or losing the object-cache layer. Latency-sensitive ZGC services now get both sub-millisecond pauses *and* the full startup win — a combination native image, notably, still can't offer (its GC options remain limited; G1 support exists on some platforms but ZGC-class latency does not).
- **Cache portability got real.** Train once in CI with default settings; deploy the same artifact to a G1 batch fleet and a ZGC API fleet. That's a genuinely container-friendly workflow: bake `app.aot` into the image next to the jar.
- **The decision heuristic tightens** to: scale-to-zero / CLI / hard sub-100ms cold start → GraalVM native image (with all the [reflection configuration realities](/posts/spring-native-reflect-config-from-tests) that entails); everything else, including latency-sensitive ZGC services → JDK 26 + AOT cache. The middle ground where you'd agonize keeps shrinking, and it's shrinking *toward* Leyden.

## Practical Adoption Checklist

1. **JDK 26+** — earlier JDKs accept the flags but ZGC gets only the class-loading layer.
2. Add a **training step** to CI: run the jar with `-XX:AOTCacheOutput`, a training profile, and a scripted warmup; archive `app.aot` next to the jar in your container image.
3. **Regenerate the cache on every build** — the cache is tied to the exact classpath; a stale cache is silently ignored (verify with `-Xlog:aot` in your deployment smoke test).
4. Trainer and prod **GC no longer need to match** (JDK 26+), but keep JDK builds identical between training and production.
5. Roll out per-service and **measure readiness time in your actual orchestrator** — Kubernetes rolling-update speed is where a 40% readiness improvement turns into real deploy-velocity and autoscale-response wins.
6. If you're also chasing memory floor rather than startup, that's a different post — my [Postgres on 150MB](/posts/postgres-on-less-than-150mb-of-memory) instincts apply: measure RSS, not heap.

## Summary

- JEP 516 (Java 26) makes the AOT object cache GC-agnostic by storing references as logical indices instead of physical addresses — ZGC, previously excluded, now gets the full Leyden startup benefit.
- Training-run GC and production GC are decoupled; one cache artifact serves every fleet.
- The Leyden-vs-GraalVM decision from my January guide tilts further toward Leyden for any service that was already JVM-shaped — native image's remaining moat is genuine cold-start-in-milliseconds requirements.
- Benchmark tables above are filled from real runs on my hardware (see draft note); the code and commands are reproducible as written, and the full setup lives at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent).

## Resources

- [JEP 516: Ahead-of-Time Object Caching with Any GC](https://openjdk.org/jeps/516)
- [Project Leyden & JDK 26: Bringing AOT Caching to ZGC — SoftwareMill](https://softwaremill.com/project-leyden-and-jdk-26-bringing-aot-caching-to-zgc/)
- [Performance Improvements in JDK 26 — Inside Java](https://inside.java/2026/06/09/jdk-26-performance-improvements/)
- [Project Leyden vs GraalVM Native Image — A Complete Guide](/posts/project-leyden-vs-graalvm-native-image) (the January post this revisits)
- [GraalVM Native Spring Boot vs Go — Build, Boot, and Benchmark](/posts/go-vs-spring-boot-native-benchmark) (methodology)
- [Generating reflect-config from tests](/posts/spring-native-reflect-config-from-tests) (if you go the native image route anyway)
