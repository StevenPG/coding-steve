---
author: StevenPG
pubDatetime: 2026-10-27T23:00:00.000Z
title: "Java 28 AOT Code Compilation (JEP 544): Is the JIT Warmup Tax Finally Dead?"
slug: java-28-aot-code-compilation-jep-544
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - performance
  - graalvm
  - spring boot
description: "JEP 544 in Java 28 stores JIT-compiled native code in the AOT cache. I measured it on Spring Boot, a CLI and a CPU-bound batch job against JDK 25-27 caches and GraalVM native image: startup, warmup curves, bad training runs and every GC."
---

## Table of Contents

[[toc]]

# The warmup tax

Every JVM pays two bills before your code runs at full speed. The first is
**startup**: load, verify and link thousands of classes, run static
initializers, build the framework's object graph. The second is **warmup**: the
code starts out interpreted, the JVM watches which methods are hot, and C1 and
then C2 compile them in the background, on the same CPUs your application is
trying to use.

Project Leyden has been chipping away at the first bill for three releases:

| JDK    | JEP                                                                     | What the AOT cache stores                           |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------- |
| 24     | [483: AOT Class Loading & Linking](https://openjdk.org/jeps/483)        | classes, already loaded and linked                  |
| 25     | [514: AOT Command-Line Ergonomics](https://openjdk.org/jeps/514)        | (one-step `-XX:AOTCacheOutput` workflow)            |
| 25     | [515: AOT Method Profiling](https://openjdk.org/jeps/515)               | method profiles, so C2 can start early              |
| 26     | [516: AOT Object Caching with Any GC](https://openjdk.org/jeps/516)     | heap objects, now for every collector including ZGC |
| **28** | **[544: Ahead-of-Time Code Compilation](https://openjdk.org/jeps/544)** | **compiled native code**                            |

JEP 544 goes after the second bill. The training run now saves the **machine
code** the JIT produced, and the production run starts executing it
immediately instead of interpreting while the compilers catch up.

That's the piece GraalVM native image always had and the JVM didn't. So the
question for this post is simple: with JEP 544, is the JIT warmup tax finally
gone, and how much of native image's advantage is left?

I built three sample apps, ran about four and a half hours of benchmarks on a
4-core x64 cloud VM with JDK 28 early-access build 21, and measured everything below. No
number in this post is estimated. The whole harness is in
[DemosAndArticleContent/blog/java-28-aot-code-compilation](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-28-aot-code-compilation).

**The short version**, all measured on 2 pinned CPUs unless noted:

- **Spring Boot startup: 7.7 s → 2.8 s (−64%).** That's 28% faster than the
  JDK 28 AOT cache without code, and CPU time spent starting falls from 14 s to 4.5 s.
- **On 1 CPU it's −67% to −73%**, with every collector: Serial, G1, ZGC and Shenandoah.
- **The first 30 seconds under load serve 36% more requests**, and the warmup
  stall that the cache alone produces is gone.
- **Peak throughput is unchanged.** AOT code doesn't cost you anything at steady state.
- **A picocli CLI: 425 ms → 198 ms.** javac's first iteration: −62%.
- **It doesn't end warmup.** The application still needs over a minute to reach
  full speed, and a workload that's hot within a second barely notices.
- **Native image still starts 8× faster**, but it peaked at 38% of the JVM's
  throughput, and the JVM had overtaken it after about 20 seconds.
- **The catch:** AOT code is silently dropped if production's CPU features or
  GC don't exactly match the training run.

# What JEP 544 actually adds

JEP 544 is integrated in JDK 28, which is scheduled for GA in March 2027. It
doesn't add a new workflow. You use the same two steps as JDK 25 and 26:

```bash
# 1. Training run: run a representative workload, the cache is written at exit
java -XX:AOTCacheOutput=app.aot -jar app.jar

# 2. Production run
java -XX:AOTCache=app.aot -jar app.jar
```

On JDK 28 step 1 now also compiles the methods the training run found hot and
stores the code in the cache. There is no flag to turn it on. A cache built by
JDK 28 contains code unless you train with
`-XX:+UnlockDiagnosticVMOptions -XX:-AOTCodeCaching`.

A few properties from the JEP that matter in practice:

- **AOT code and JIT code mix freely.** There's no AOT-only mode. If production
  hits code the training run never saw, or an assumption baked into the AOT
  code stops holding, HotSpot deoptimizes and the JIT compiles fresh code like
  it always has. Your application can't tell the difference.
- **No application changes and no tuning flags.** Same jar, same code.
- **All collectors.** Serial, Parallel, G1, Shenandoah and ZGC are supported,
  but the production GC must be the one you trained with.
- **No cross-compilation.** The code is for the CPU architecture _and the CPU
  features_ of the training machine. x64 and AArch64 only for now.

## Seeing it work

`-XX:+PrintCompilation` marks every method whose code came from the cache with
an `A`, and `AP` for code that was preloaded at startup:

```text
37  169      A  4       java.lang.Byte::toUnsignedInt (6 bytes)
38  170      AP 4       java.lang.Object::<init> (1 bytes)
38  171      AP 4       jdk.internal.util.ArraysSupport::unsignedHashCode (36 bytes)
38  176      AP 4       java.util.HashMap::hash (20 bytes)
```

The `4` is the compilation tier: that's C2-optimized code at 37 milliseconds
into the run, before the application had a chance to warm anything up.
`-Xlog:aot` reports the code region being mapped:

```text
[0.045s][info][aot] Mapped static  region #4 at base 0x00007fc761eec000 top 0x00007fc764000000 (Code)
[0.046s][info][aot] Mapped 34571400 bytes at address 0x00007fc761eec010 from AOT Code Cache
[0.046s][info][aot] Loaded 12379 AOT code entries from AOT Code Cache
```

One trap I fell into: that last line is **not** proof the code is used. It
prints even when AOT code is disabled, because the region is still mapped and
indexed. Count the `A` lines instead. My harness refuses to benchmark any
configuration until it has seen them.

# The test bench

Three apps, picked to stress different parts of the problem:

| App             | What it is                                                                                                                                                                                                        | What I measured                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **spring-rest** | Spring Boot 4.1: MVC, JPA/Hibernate 7 on in-memory H2, bean validation, actuator. DB-shaped endpoints plus a CPU-heavy `POST /api/tracks/analyze` that parses a 300-point flight track and runs the numbers on it | time from `java` to `ApplicationReadyEvent`, and throughput plus p99 latency for every second of the first 120 s under load |
| **warmup-cpu**  | Plain Java, zero dependencies. `javac` mode compiles 50 generated source files in-process, a reproduction of the JEP's own benchmark. `adsb` mode decodes 200k ADS-B position reports into flight tracks          | time of each iteration of identical work                                                                                    |
| **flightlog**   | picocli CLI that summarizes a 20k-row flight log and exits                                                                                                                                                        | total runtime of one invocation                                                                                             |

Each app runs in up to seven configurations:

| Config                     | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| JDK 28, no cache           | the plain JIT baseline                                                       |
| JDK 25 / 26 / 27 AOT cache | the cache as each release shipped it                                         |
| JDK 28 cache, no AOT code  | JDK 28 cache with code loading turned off at runtime (`-XX:-AOTCodeCaching`) |
| **JDK 28 + AOT code**      | the same cache file, with JEP 544 code allowed                               |
| GraalVM native image       | Oracle GraalVM for JDK 25, no PGO                                            |

The two JDK 28 cache configurations use **the same `.aot` file**. The only
difference is whether the JVM may install the code inside it, so the gap
between them is exactly what JEP 544 adds.

Methodology, briefly:

- **Hardware:** a 4-core Intel Xeon (2.1 GHz, AVX-512) cloud VM with 15 GB
  of RAM. The app under test is pinned to 2 cores with `taskset`, and the load
  generator gets the other 2. Two cores is also what the JEP's own startup
  numbers used, and it's a realistic Kubernetes CPU limit. The JVM sizes itself
  from the CPU affinity, so it sees 2 CPUs too.
- **JDKs:** Temurin 25.0.5, 26.0.2 and 27.0.1, and OpenJDK 28-ea+21 from
  jdk.java.net (Temurin's 28+21 EA build for the Shenandoah rows, since Oracle's
  build leaves Shenandoah out). All apps are compiled to Java 25 bytecode, so every
  JDK runs the exact same jar.
- **Startup:** [hyperfine](https://github.com/sharkdp/hyperfine), 3 warmup
  runs plus 20 measured runs. Spring Boot calls `Runtime.halt(0)` from an
  `ApplicationReadyEvent` listener when `-Dbench.exitOnReady=true`, so the
  number is plain process wall time with no HTTP polling jitter.
- **Load:** a small Go load generator, closed loop with 8 connections. It
  starts firing the moment `java` is launched and buckets every response by
  _seconds since launch_, so one curve shows startup, warmup and steady state.
  It's Go on purpose: a Java client would be warming up its own JIT during the
  window I'm trying to measure. Three repetitions, interleaved.
- **Training:** one `-XX:AOTCacheOutput` run per app, JDK and GC. For Spring
  that's startup plus 30 s of the same request mix used in the test.
- **Verification:** before measuring, every cached config is run once with
  `-Xlog:aot -XX:+PrintCompilation`. The harness aborts if the cache didn't map
  or if the AOT code count is wrong in either direction. Every `warmup-cpu`
  run prints a checksum, and every run in every configuration printed the same one.
- **GC matrix:** to keep it to a few hours, 10 startup runs per cell and two
  60-second load runs instead of three 120-second ones.
- **One honest caveat:** the cloud container restarted partway through, and
  came back on a different VM with the same CPU model and feature set. Every
  comparison in this post is between configurations measured in the same run on
  the same VM, but absolute numbers differ by up to about 10% between the two VMs.
  That's why the G1 JIT-only startup reads 7.7 s in one table and 6.8 s in another.

The load is deliberately heavy for 2 cores (about 1,100 req/s at peak), so the
JIT and the application genuinely compete for CPU. That's the situation
JEP 544 is designed for.

# Startup results

## Spring Boot: 7.7 s to 2.8 s

![Spring Boot startup by configuration](/assets/java-28-aot-code/startup-spring.svg)

| Config                          |       Median | vs JIT only |  CPU time | Peak RSS |
| ------------------------------- | -----------: | ----------: | --------: | -------: |
| JDK 28, no cache (JIT only)     |     7,743 ms |           — |    14.0 s |   477 MB |
| JDK 25 AOT cache                |     4,389 ms |        −43% |     7.8 s |   380 MB |
| JDK 26 AOT cache                |     3,676 ms |        −53% |     6.4 s |   378 MB |
| JDK 27 AOT cache                |     3,859 ms |        −50% |     6.7 s |   359 MB |
| JDK 28 cache, no AOT code       |     3,847 ms |        −50% |     6.7 s |   364 MB |
| **JDK 28 + AOT code (JEP 544)** | **2,780 ms** |    **−64%** | **4.5 s** |   402 MB |
| GraalVM native image            |       339 ms |        −96% |     0.3 s |   196 MB |

JEP 544 takes another **28% off** a cache that was already good (3.85 s to
2.78 s), and the total reduction lands at 64%. The JEP reports 65–80% for its
framework benchmarks, so this is the low end of that range. My app does real
work at startup (Hibernate bootstrap and seeding 5,000 rows), and that work
doesn't disappear just because the code for it is precompiled.

The most telling column is **CPU time**. A cold Spring Boot start burns 14 CPU
seconds to deliver 7.7 wall-clock seconds. On 2 cores, a large share of that is
the JIT compiling in the background and competing with the application's own
startup. With AOT code that falls to 4.5 CPU seconds. If you pack many JVMs onto
a node, or start a lot of them at once during a rollout, that's CPU you get back.

The JDK 26 to 28 cache rows are within one standard deviation of each other
(σ ≈ 170 ms), so I wouldn't read anything into JDK 26 edging out 27 and 28.
The 25-to-26 step is real: that's JEP 516 caching heap objects.

## A short-lived CLI: 425 ms to 198 ms

![CLI runtime by configuration](/assets/java-28-aot-code/startup-cli.svg)

| Config                    |     Median | vs JIT only |   CPU time |
| ------------------------- | ---------: | ----------: | ---------: |
| JDK 28, no cache          |     425 ms |           — |     0.72 s |
| JDK 25 AOT cache          |     319 ms |        −25% |     0.55 s |
| JDK 26 AOT cache          |     269 ms |        −37% |     0.48 s |
| JDK 27 AOT cache          |     287 ms |        −33% |     0.50 s |
| JDK 28 cache, no AOT code |     277 ms |        −35% |     0.48 s |
| **JDK 28 + AOT code**     | **198 ms** |    **−53%** | **0.30 s** |
| GraalVM native image      |      31 ms |        −93% |     0.03 s |

For a program that exits before the JIT has finished anything useful,
precompiled code is pure gain: 29% faster than the JDK 28 cache alone, and
under 200 ms for a picocli tool that parses and aggregates 20,000 CSV rows. If
you ship internal CLIs as jars, that's the difference between feeling sluggish
and feeling fine.

Native image is still in another class here, at 31 ms. For tools that run
thousands of times in CI loops or shell pipelines, that's still the right choice.

# Warmup results

Startup is the easy half. The real question in the title is warmup: how long
until the application runs at full speed?

## Reproducing the JEP's javac benchmark

The JEP measures warmup by compiling 50 source files with javac 20 times in one
JVM. javac is a big, branchy, allocation-heavy Java program, which makes it
about as hard a warmup case as you'll find. I rebuilt that benchmark in
`warmup-cpu`:

![javac iteration times](/assets/java-28-aot-code/batch-javac.svg)

| Config                    |              Iter 1 |     Iter 2 | Iter 5 | Steady (last 5) |   Total wall time |
| ------------------------- | ------------------: | ---------: | -----: | --------------: | ----------------: |
| JDK 28, no cache          |            3,254 ms |   1,473 ms | 935 ms |          555 ms |            18.3 s |
| JDK 28 cache, no AOT code |     2,568 ms (−21%) |   1,080 ms | 741 ms |          615 ms |            16.7 s |
| **JDK 28 + AOT code**     | **1,236 ms (−62%)** | **815 ms** | 727 ms |          601 ms | **14.6 s (−20%)** |

The first iteration matches the JEP closely. It reports about −30% with the
cache alone and about −75% with AOT code; I measured −21% and −62%.

The second half of the JEP's claim didn't reproduce as cleanly. The JEP says
iteration times are "already near steady state by the fourth iteration" with AOT
code. On my 2-core box, iteration 4 was still about 30% above steady state, and
it took roughly 10 iterations to settle. AOT code removes most of the cold
start, but C2 keeps improving the hottest code for a while after that.

## Spring Boot under load: the first 120 seconds

This is the experiment I cared about most. The load generator fires from the
moment `java` launches and records every second:

![Spring Boot throughput and p99 latency over the first 120 seconds](/assets/java-28-aot-code/curve-main.svg)

| Config                    | First response | 90% of JIT peak | Requests, first 30 s | Requests, first 60 s | Steady req/s | p99 at 10–20 s |
| ------------------------- | -------------: | --------------: | -------------------: | -------------------: | -----------: | -------------: |
| JDK 28, no cache          |          7.2 s |            86 s |                9,704 |               30,510 |        1,109 |          85 ms |
| JDK 25 AOT cache          |          3.3 s |           113 s |                8,069 |               21,919 |          949 |         155 ms |
| JDK 28 cache, no AOT code |          3.0 s |            95 s |               11,335 |               33,915 |        1,073 |         153 ms |
| **JDK 28 + AOT code**     |      **2.2 s** |        **73 s** |           **13,219** |           **35,702** |    **1,120** |         107 ms |
| GraalVM native image      |          0.3 s |           never |               12,882 |               25,702 |          420 |          69 ms |

Run-to-run spread on the request totals is about ±5%, so treat small
differences in those columns as noise. Here's what holds across all three
repetitions:

**AOT code has no cost at peak.** Steady-state throughput with JEP 544
(1,120 req/s) matches pure JIT (1,109 req/s). That was my biggest worry. Code
compiled from a 30-second training run could have been worse than what C2
produces from live profiles. It isn't, or the JIT replaces it before it
matters.

**It removes the warmup dip.** Both cache-only configurations hit a pothole
between roughly 12 and 20 seconds: throughput halves and p99 jumps to about
150 ms. That's a burst of compilations competing with the application. The
JEP 544 line doesn't have it. If you've ever seen a fresh pod join a load
balancer and immediately trip a latency alert, this is the part that matters.

**It serves 36% more requests in the first 30 seconds than the JIT alone**, and
17% more than the JDK 28 cache without code.

**But it doesn't end warmup.** All three JDK 28 configurations reach full speed
at about the same point, between 73 and 95 seconds. In the middle of the ramp,
from 25 to 60 seconds, the three curves are nearly on top of each other. AOT code
gives the JVM a much better first 20 seconds. What happens after that is still
C2 doing its normal job: recompiling with live profiles, inlining more
aggressively and replacing the trained code with something better. A 2-core
box under heavy load makes that ramp long.

**On JDK 25 the cache made warmup worse.** It started faster, then sat at about
300 req/s with high p99 latency from 15 to 48 seconds before recovering. In
60 seconds it served 28% fewer requests than having no cache at all. This happened
consistently in all three runs. I haven't dug into why, and the JDK 26+ caches
don't do it. If you're on JDK 25 with an AOT cache, measure your warmup, not
just your startup.

**Native image starts fast and then levels off.** It answers in 0.3 s and is
ahead for roughly the first 20 seconds. Then it flatlines at 420 req/s, 2.6× below the
JVM's peak, because there's no JIT to optimize anything further. Over
30 seconds it ties JEP 544. Over 60 seconds it's 28% behind, and the gap keeps
growing. Oracle GraalVM's profile-guided optimization would narrow this, but
it's a separate instrumented build-and-train cycle, and I didn't use it here.

## A batch job that's hot in under a second

The ADS-B workload decodes 200k position reports per iteration, and the JIT has
it hot within the first second. My first pass ran on the default heap, and the
iteration times were dominated by GC noise. So I reran it with a fixed 1 GB heap,
10 repetitions, and caches trained with the same heap flags (more on why in the
heap-size section below):

![ADS-B iteration times with a fixed heap](/assets/java-28-aot-code/batch-adsb-fixedheap.svg)

| Config                    |            Iter 1 | Iter 2 | Steady (last 5) | 30 iterations total | Wall time |
| ------------------------- | ----------------: | -----: | --------------: | ------------------: | --------: |
| JDK 28, no cache          |            240 ms | 130 ms |          108 ms |              3.66 s |    4.57 s |
| JDK 25 AOT cache          |            232 ms | 192 ms |          106 ms |              3.65 s |    4.41 s |
| JDK 26 AOT cache          |            226 ms | 189 ms |          105 ms |              3.72 s |    4.49 s |
| JDK 27 AOT cache          |            227 ms | 163 ms |          108 ms |              3.63 s |    4.35 s |
| JDK 28 cache, no AOT code |            215 ms | 148 ms |          107 ms |              3.67 s |    4.36 s |
| **JDK 28 + AOT code**     | **146 ms (−39%)** | 144 ms |          108 ms |              3.61 s |    4.25 s |

AOT code makes the first iteration 39% faster, and then nothing else changes.
All six configurations hit the same steady state, and the 30-iteration totals
are within 3% of each other. The 7% wall-time gain is the faster first
iteration plus faster JVM startup.

That's the boundary of JEP 544: **it can only remove warmup that exists.** For a
workload that's compute-dense and hot within a second, the cold start is all
there is to win. The javac and Spring results look the way they do because
those programs have thousands of hot methods spread across many layers, and the
JIT takes a long time to get through them.

# What if the training run is wrong?

The JEP is clear that the training run should look like production. I wanted
to know what happens when it doesn't.

**Spring Boot trained on the wrong endpoints.** I trained a cache using only the
fleet (DB-shaped) endpoints, then ran the full mix, which includes the
CPU-heavy track analysis that training never touched:

![Training mismatch warmup curve](/assets/java-28-aot-code/curve-mismatch.svg)

| Config                                   | First response | Requests, first 30 s | Requests, first 60 s |
| ---------------------------------------- | -------------: | -------------------: | -------------------: |
| JDK 28, no cache                         |          7.1 s |                9,650 |               30,424 |
| AOT code, trained on the wrong endpoints |          2.4 s |        10,763 (+12%) |               32,334 |
| AOT code, trained on the real mix        |          2.3 s |        12,949 (+34%) |               34,929 |

Startup barely cares: framework startup is the same code regardless of which
endpoint you train on. But two-thirds of the early-throughput benefit
disappears, because the code that matters under load was never compiled.

**Batch jobs trained on the other workload.** Here it gets worse than useless:

| Workload | No cache, iter 1 | Cache trained on the _other_ workload | Cache trained on the right one |
| -------- | ---------------: | ------------------------------------: | -----------------------------: |
| javac    |         3,333 ms |                   3,886 ms (**+17%**) |                1,312 ms (−61%) |
| adsb     |           288 ms |                     391 ms (**+36%**) |                  201 ms (−30%) |

A cache trained on the wrong workload made the first iteration **slower than
no cache at all**, and total runtime came out the same or slightly worse. A cache
is not free to load, and code and profiles from a different program shape
don't help the JIT here.

The practical rule: **your training run is a test fixture, and it needs the same
care as one.** Drive it with your real traffic shape, such as a recorded
request mix or your integration test suite, not just startup followed by
`System.exit`.

# Collectors and CPU counts

My hypothesis going in: JEP 544 should matter most when CPU is scarce,
because that's when background JIT compilation competes hardest with the
application. So I ran Spring Boot on every collector, on 1 and on 2 CPUs.
Each collector got its own training run.

![Startup reduction by collector and CPU count](/assets/java-28-aot-code/gc-matrix-startup.svg)

| CPUs | GC         | JIT only | Cache, no code |   **+ AOT code** | AOT code vs cache | Requests in first 60 s: JIT → AOT code |
| ---: | ---------- | -------: | -------------: | ---------------: | ----------------: | -------------------------------------: |
|    1 | Serial     |   13.1 s |          5.2 s | **3.5 s (−73%)** |              −32% |                 10,558 → 16,248 (+54%) |
|    1 | G1         |   13.9 s |          5.8 s | **4.1 s (−70%)** |              −28% |                 11,232 → 15,428 (+37%) |
|    1 | ZGC        |   15.0 s |          7.2 s | **4.9 s (−67%)** |              −32% |                  7,066 → 12,614 (+79%) |
|    1 | Shenandoah |   16.3 s |          7.0 s | **4.7 s (−71%)** |              −34% |                  9,719 → 14,954 (+54%) |
|    2 | Serial     |    7.1 s |          3.3 s | **2.5 s (−65%)** |              −26% |                 38,480 → 45,671 (+19%) |
|    2 | G1         |    6.8 s |          3.7 s | **2.6 s (−62%)** |              −30% |                 43,314 → 53,148 (+23%) |
|    2 | ZGC        |    7.9 s |          4.1 s | **3.2 s (−59%)** |              −20% |                 24,870 → 31,962 (+29%) |
|    2 | Shenandoah |    7.5 s |          4.0 s | **2.8 s (−62%)** |              −29% |                 24,163 → 35,031 (+45%) |

The hypothesis holds. **With one CPU, AOT code cuts Spring Boot startup by
67–73% on every collector**, compared with 59–65% on two. The early-throughput
gain doubles too: on 1 CPU with ZGC, the JEP 544 configuration served 79% more
requests in its first minute than the JIT alone. ZGC and Shenandoah tend to gain
the most, plausibly because their concurrent GC threads are a third party competing for the
same CPU as the application and the JIT.

On top of the cache, AOT code is worth another 20–34% of startup in every cell.
It works the same way regardless of collector, as the JEP promises.

If you run JVMs in containers with a 1-CPU limit, or with fractional limits
that throttle hard during startup, this is the part of JEP 544 that affects you
most. A 13-second cold start becomes 3.5–5 seconds without any code changes.

Some notes on this matrix. Oracle's JDK 28 EA build from jdk.java.net doesn't
include Shenandoah, so the Shenandoah rows use Temurin's build of the same EA
source tag (28+21). In that build Shenandoah still defaults to its
non-generational mode; [JEP 535](https://openjdk.org/jeps/535), which makes
generational Shenandoah the default, isn't in build 21 yet. ZGC and Shenandoah
had lower absolute throughput than G1 and Serial on 2 CPUs at the default heap
size, but that's a GC-tuning question this matrix wasn't designed to answer.
JDK 28 also targets [JEP 545](https://openjdk.org/jeps/545), Faster Startup and
Warmup with ZGC, which I didn't test separately.

# What JEP 544 costs

**Training time.** On JDK 28 the training run does more work at exit: it
compiles and stores the code.

| App                                 | JDK 25 training | JDK 28 training | JDK 25 cache | JDK 28 cache |
| ----------------------------------- | --------------: | --------------: | -----------: | -----------: |
| spring-rest (30 s of load included) |            58 s |           115 s |       133 MB |       182 MB |
| warmup-cpu, adsb                    |           4.3 s |           9.3 s |        12 MB |        17 MB |
| warmup-cpu, javac                   |               — |            67 s |            — |        65 MB |
| flightlog CLI                       |           2.0 s |           3.5 s |        15 MB |        20 MB |

For the Spring app, the time spent outside the 30 s workload went from about
25 s to about 80 s on 2 cores. That's a CI cost you pay on every build,
since the cache must match the exact jar.

**Memory.** Peak RSS at Spring startup was 402 MB with AOT code, against 364 MB
for the cache without it, because the code region is mapped in. Under load, at
the end of 120 s, the JEP 544 configuration used 731 MB against 850 MB for pure
JIT, most of that difference being heap growth, so RSS is not a reason to avoid it.

**Portability.** This is the big operational catch, and it gets its own section.

# The operational catch: CPU features

AOT code is native machine code compiled for the training machine's CPU, so
production has to match. The JEP says the JVM warns and falls back when it
doesn't. I tested what that actually looks like on the EA build:

| Production run                                  | AOT code used? | What you see by default |
| ----------------------------------------------- | -------------- | ----------------------- |
| Same CPU and GC as training                     | yes            | nothing                 |
| AVX2-only CPU (simulated with `-XX:UseAVX=2`)   | **no**         | **nothing**             |
| `-XX:-UseFMA`                                   | no             | nothing                 |
| Different GC (trained with G1, run with Serial) | no             | nothing                 |
| Any of the above with `-XX:AOTMode=required`    | —              | **exit code 1**         |

The mismatch only shows up at `-Xlog:aot` info level:

```text
[0.028s][info][aot] AOT Code Cache disabled: cpu features are incompatible
[0.028s][info][aot] cpu features that are required: "avx512f, avx512dq, avx512cd, avx512bw, avx512vl, ..."
```

In every case the rest of the cache (classes, objects and profiles) still loads,
so you lose JEP 544's benefit without any error. That's exactly the kind of
regression nobody notices until someone compares dashboards.

It gets worse. **The match is exact, not "at least as capable."** I trained a
cache with AVX-512 turned off so it would suit older nodes, then ran it on the
AVX-512 machine. The AOT code was rejected again, this time because of features
that were _additional_:

```text
[0.025s][info][aot] AOT Code Cache disabled: cpu features are incompatible
[0.025s][info][aot] cpu features that are additional: "avx512f, avx512dq, avx512cd, avx512bw, ..."
```

The only way to get portable AOT code was to pass the same restriction to
**both** runs: `-XX:UseAVX=2` in training _and_ production installed 875 AOT
methods.

This matters for anyone building container images in CI. Your GitHub Actions
runner, your build farm and your production node pool are probably different
CPU generations, and in mixed clusters even different vendors. If the cache is
baked into the image on a build machine, there's a good chance production never
runs a single AOT-compiled method. Your options:

1. **Train on the production hardware.** Use a training stage in your
   deployment pipeline on a node from the target pool, or an init container
   that trains on first boot and stores the cache on a volume.
2. **Pin a CPU feature level** in both training and production, at the cost of
   newer instructions on newer nodes.
3. **One cache per node type**, selected at startup via node labels.

Whichever you choose, put `-XX:AOTMode=required` in a deployment smoke test
so a mismatch fails loudly in staging instead of silently in production.

## Heap size is part of the match too, but JDK 28 handles most of it

I ran into this one by accident. I trained caches with the default heap
(about 4 GB on this machine), then ran with `-Xmx1g`. JDK 27 refused to start:

```text
[error][aot,codecache,init] AOT Code Cache disabled: it was created with CompressedOops::shift() = 3 vs current 0
[error][aot,codecache,init] Consider adding -XX:+AOTCompatibleOopCompression when creating the AOT cache
Error occurred during initialization of VM
Unable to use AOT Code Cache.
```

The heap size determines how the JVM compresses object pointers, and generated
code bakes that in. The JDK 25–27 caches already hold a small amount of
generated code (adapters and stubs, not your methods), and it's tied to the
heap size. Without `AOTMode=on` that code is quietly dropped. With it, the JVM
exits.

JDK 28 handles this. Its training run sets `-XX:+AOTCompatibleOopCompression`
automatically when it assembles the cache, and the same cache kept its AOT code
from `-Xmx1g` all the way to `-Xmx31g`. At `-Xmx33g` compressed oops switch off
entirely, and the AOT code was silently dropped.

In Kubernetes your `-Xmx` usually comes from the container's memory limit
through `-XX:MaxRAMPercentage`. So the rule is simple: **train with the same
heap and container limits you deploy with**, and if you run heaps above 32 GB,
train above 32 GB too.

# Where GraalVM native image still wins

Native image still owns three things outright:

- **Time to first response:** 0.3 s against 2.2 s for Spring, and 31 ms against
  198 ms for the CLI. Nothing on the JVM side is close.
- **Memory:** 196 MB peak RSS at Spring startup against 402 MB, and 270 MB
  under load against 731 MB.
- **No training run and no CPU-matching problem.** The binary is the artifact.

JEP 544 moves the line in three ways:

- **Sustained throughput.** Without PGO, native image peaked at 38% of the JVM's
  throughput in this test. Native's advantage lasts about 20 seconds; after that
  the JVM is ahead and stays ahead.
- **The JVM's worst early behavior is mostly gone.** The 7-second cold start
  and the latency spikes in the first 20 seconds were the strongest practical
  arguments for native image on services. With JEP 544, a JVM service answers
  in about 2 seconds and doesn't stall during warmup.
- **None of native image's costs.** No closed-world reflection configuration,
  no 10-minute native builds (my Spring build took 9 m 23 s and about 8 GB of
  RAM), and no separate test matrix.

My updated rule of thumb, building on the
[January Leyden vs GraalVM guide](/posts/project-leyden-vs-graalvm-native-image):

- **Scale-to-zero, CLIs run thousands of times, memory-capped sidecars:** native image.
- **Everything that serves traffic for longer than about a minute:** JDK 28 + AOT
  cache, trained on real traffic. Between JEP 544 and the JIT you get most of
  native's startup and all of the JVM's peak.

# Adoption checklist

1. **JDK 28.** AOT code arrives automatically with the cache; there's nothing extra to turn on.
2. **Use the extracted Spring Boot layout.** The AOT cache only covers classes
   from the class path loaded by the JDK's built-in loaders, and Spring Boot's
   nested-jar launcher isn't one of them. Run
   `java -Djarmode=tools -jar app.jar extract` and start the thin jar it produces.
3. **Make the training run realistic.** Drive real endpoints with a real mix
   for 30 s or more. Startup-then-exit trains startup only, and the wrong
   workload is worse than none.
4. **Train with the production GC** and with the same CPU features as
   production (see above).
5. **Rebuild the cache on every build.** It's tied to the exact class path.
6. **Verify it in a smoke test**, using `-XX:AOTMode=required` plus a check that
   `-XX:+PrintCompilation` shows `A` methods. Don't rely on "Loaded N AOT
   code entries."
7. **Budget for it:** about 1 extra minute of CI time and about 50 MB more of
   image size for a mid-sized Spring app.
8. **Measure warmup, not just startup.** First-30-second throughput and p99
   are what your users and your autoscaler actually feel.

# Verdict: is the warmup tax dead?

No. But the expensive part of it is.

The warmup tax used to come as two bills. The first one, the cold start, is
mostly gone: a Spring Boot service now answers in under 3 seconds on 2 CPUs
instead of nearly 8, doesn't stall 15 seconds in, and spends a third of the CPU
getting there. That's the part that hurts in practice: in rolling deploys,
autoscaling, readiness probes, and pods getting traffic before they're ready.
It comes at no cost to peak throughput, and it needs no code changes.

The second bill, the long C2 ramp to peak, is still there. JEP 544 gives the
JVM a much better starting point, but the code it stores was compiled from a
training run, and the JIT still spends the next minute or so improving on it
with live profiles. If your service needs peak throughput in the first ten
seconds, nothing in this post gets you there.

So my answer:

- **On a constrained CPU budget** (1–2 cores, which describes most of our
  Kubernetes pods), JEP 544 is the biggest startup improvement since the AOT
  cache itself. Startup drops by two-thirds to three-quarters.
- **For short-lived JVM processes** like CLIs and build tools, it's a free 30%
  on top of the cache.
- **For long-running services**, it smooths the first minute and leaves steady
  state alone.

And it brings one new operational responsibility: the training run now
produces machine code, so it has to run on hardware that matches production.
Make it part of your deployment pipeline, not just a build step.

# FAQ

### What is JEP 544?

JEP 544, Ahead-of-Time Code Compilation, is a JDK 28 feature from Project
Leyden. During a training run the JVM compiles the hot methods it observes and
stores the native code in the AOT cache. Production runs that use the cache
execute that code immediately instead of interpreting and recompiling it.

### Which Java version has AOT code compilation?

JDK 28. It's integrated and available in JDK 28 early-access builds now, and
GA is scheduled for March 2027. JDK 24 through 27 have AOT caches that store
classes, profiles and objects, but not compiled code.

### Do I need new flags to use JEP 544?

No. The existing `-XX:AOTCacheOutput` (training) and `-XX:AOTCache`
(production) flags pick it up automatically on JDK 28. Code caching is on by
default. It can be turned off with
`-XX:+UnlockDiagnosticVMOptions -XX:-AOTCodeCaching`.

### Does AOT-compiled code make peak performance worse?

Not in my measurements. Spring Boot reached 1,120 req/s with AOT code against
1,109 req/s with pure JIT. The JIT still runs and replaces AOT code where it can
do better.

### Is Java 28 AOT the same as GraalVM native image?

No. Native image compiles the whole application into a standalone binary under
a closed-world assumption, with no JIT at runtime. JEP 544 keeps the normal JVM
and JIT, and simply starts with precompiled code for the methods the training
run found hot. You keep full Java dynamism and peak JIT performance, but you
still need a JVM, and startup and memory remain well above native image.

### Can I build the AOT cache in CI and deploy it anywhere?

Only to machines with exactly the same CPU features, using the same GC. A
mismatch silently disables the AOT code and keeps the rest of the cache. Use
`-XX:AOTMode=required` in a smoke test to catch it.

### How do I know AOT code is actually being used?

Run with `-XX:+PrintCompilation` and look for methods marked `A` or `AP`. The
`-Xlog:aot` line "Loaded N AOT code entries" also appears when code loading is
disabled, so it doesn't prove anything on its own.

### Does JEP 544 work with ZGC?

Yes. All of Serial, Parallel, G1, Shenandoah and ZGC are supported, but the
cache must be trained with the same collector you run in production.
In my tests, ZGC with AOT code started 67% faster than ZGC without a
cache on 1 CPU, and 59% faster on 2 CPUs.

# Wrapping up

JEP 544 is the step that makes Project Leyden more than a startup feature.
For the first time, a JVM can start executing optimized machine code from a
previous run, then hand over to the JIT without any visible seam. On a small
CPU budget, that turns a 13-second Spring Boot cold start into 3.5 seconds, and
it cost nothing at peak in every test I ran.

It's also the first Leyden feature where the cache is tied to hardware, and
that's where I'd expect real deployments to stumble. The happy path is two
flags. The sad path is a cache built on a CI runner with AVX-512 and deployed to
nodes without it, which works fine, logs nothing and loses the whole benefit.
Add `-XX:AOTMode=required` to a smoke test and you'll catch it.

All the code, raw results, and the scripts to rerun every number on your own
hardware are in
[DemosAndArticleContent/blog/java-28-aot-code-compilation](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-28-aot-code-compilation).
I'd especially like to see AArch64 numbers, since everything here is from a
single x64 machine.

## References

- [JEP 544: Ahead-of-Time Code Compilation](https://openjdk.org/jeps/544)
- [JEP 483: Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483)
- [JEP 514: Ahead-of-Time Command-Line Ergonomics](https://openjdk.org/jeps/514)
- [JEP 515: Ahead-of-Time Method Profiling](https://openjdk.org/jeps/515)
- [JEP 516: Ahead-of-Time Object Caching with Any GC](https://openjdk.org/jeps/516)
- [JEP 545: Faster Startup and Warmup with ZGC](https://openjdk.org/jeps/545)
- [JDK 28 early-access builds](https://jdk.java.net/28/)
- [Java 26 AOT Cache with ZGC: Leyden Startup Benchmarks, Revisited](/posts/java-26-aot-cache-zgc-leyden-benchmarks/)
- [Project Leyden vs GraalVM Native Image — A Complete Guide](/posts/project-leyden-vs-graalvm-native-image/)
- [Java 27 Changed Your Defaults](/posts/java-27-new-defaults-benchmark/)
