---
author: StevenPG
pubDatetime: 2026-09-15T16:00:00.000Z
title: "Java 27 Changed Your Defaults: What Happens When You Just Bump the Base Image"
slug: java-27-new-defaults-benchmark
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - performance
  - spring boot
  - docker
description: JDK 27 turns on compact object headers, makes G1 the default collector even on one-CPU containers, offers post-quantum hybrid TLS first, and redacts secrets from JFR recordings. The same Spring Boot jar measured on JDK 25, 26 and 27 to see what changes when you only change the base image tag.
---

## Table of Contents

[[toc]]

# Only the tag changed

JDK 27 went GA on September 15. Most of us will adopt it by changing one line:

```diff
-FROM eclipse-temurin:26-jre
+FROM eclipse-temurin:27-jre
```

No new flags and no code changes. Then the service is running under different defaults, because four of
the nine JEPs in this release change behavior you never opted into:

| JEP                                                                               | What changed                                                               | Undo it with                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [534: Compact Object Headers by Default](https://openjdk.org/jeps/534)            | Object headers shrink from 12 bytes to 8                                   | `-XX:-UseCompactObjectHeaders`                                   |
| [523: Make G1 the Default GC in All Environments](https://openjdk.org/jeps/523)   | A JVM that sees 1 CPU or < 1792 MB no longer picks Serial                  | `-XX:+UseSerialGC`                                               |
| [527: Post-Quantum Hybrid Key Exchange for TLS 1.3](https://openjdk.org/jeps/527) | `X25519MLKEM768` is offered first in every TLS handshake                   | `-Djdk.tls.namedGroups=...`                                      |
| [536: JFR In-Process Data Redaction](https://openjdk.org/jeps/536)                | Flight recordings redact secret-looking env vars, properties and arguments | `-XX:FlightRecorderOptions:redact-key=none,redact-argument=none` |

The other five are previews and incubators you have to opt into: lazy constants, primitive
patterns, structured concurrency, the Vector API, and PEM encodings.

This post is about the four that happen to you. I built a small harness that runs the same
Spring Boot jar on JDK 25, 26 and 27. It changes nothing but the `java` binary, inside containers
sized the way we actually size pods. Everything is in
[DemosAndArticleContent/blog/java-27-defaults-benchmark](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-27-defaults-benchmark).

The benchmark numbers come from my M3 Pro MacBook, running the containers in Docker Desktop (linux/arm64,
with 2 CPUs given to the Docker VM) and the load generator on macOS outside the VM. The probe and
object-layout tables are deterministic, so they hold on any host.

# What the JVM picks, before and after

The quickest way to see three of the changes is to ask the JVM. `probes/DefaultsProbe.java` is a
single-file program with no dependencies that prints what ergonomics decided. Here it is in a
`--cpus 1 --memory 1g` container, which is a completely ordinary pod size:

```bash
docker run --rm --cpus 1 --memory 1g -v $PWD/.jdks:/jdks:ro -v $PWD/probes:/p \
  debian:trixie-slim /jdks/jdk26/bin/java /p/DefaultsProbe.java
```

|                           | JDK 26                                  | JDK 27               |
| ------------------------- | --------------------------------------- | -------------------- |
| `availableProcessors`     | 1                                       | 1                    |
| Collector                 | **Serial** (`Copy`, `MarkSweepCompact`) | **G1**               |
| Max heap                  | 255 MiB                                 | 256 MiB              |
| `UseCompactObjectHeaders` | false                                   | **true**             |
| First TLS named group     | `x25519`                                | **`X25519MLKEM768`** |
| TLS named groups offered  | 10                                      | **9**                |

With no container limits on a 4-core host, JDK 26 already picks G1. That's why the collector
change is easy to miss if you test on a laptop and deploy to small pods. The difference only shows
up where JEP 523's old threshold applied.

The last row wasn't in any release summary I read. JDK 27 adds `X25519MLKEM768` at the front **and
drops `ffdhe6144` and `ffdhe8192`** from the default list. If anything you talk to only accepts
those large finite-field Diffie-Hellman groups, check it before you roll out.

# Compact headers: it's not "4 bytes per object"

When I wrote about [compact object headers on Java 25](/posts/should-i-use-java-25-compact-object-headers),
I said the header goes from 12 to 8 bytes, "saving 4 bytes per object instance." The header part
is right. The per-object saving isn't, and it's worth correcting because it changes which
applications benefit.

HotSpot aligns every object to 8 bytes. So an object never shrinks by 4 bytes. It shrinks by 0 or
by 8, depending on whether the 4 bytes you saved were holding it just past an 8-byte boundary.

`probes/HeaderFootprint.java` allocates 2 million instances of each shape, forces a full GC, and
divides the heap delta by the count. These are retained bytes per instance on JDK 27, with the header
change turned off and on:

| Shape                                                  | 12-byte header | 8-byte header |  Saved |
| ------------------------------------------------------ | -------------: | ------------: | -----: |
| `new Object()`                                         |             16 |             8 |  **8** |
| `Integer` (outside the cache)                          |             16 |            16 |      0 |
| `Long`                                                 |             24 |            16 |  **8** |
| `record Point(int x, int y)`                           |             24 |            16 |  **8** |
| `Node { Node next; int value; }`                       |             24 |            16 |  **8** |
| `record Sample(long, int, float, float, float, short)` |             40 |            40 |      0 |
| `byte[16]`                                             |             32 |            32 |      0 |
| `String`, 8 Latin-1 chars (object + `byte[]`)          |             48 |            48 |      0 |
| `ArrayList` holding 4 `Integer`s                       |            120 |           120 |      0 |
| `HashMap` entry, `Long` key -> `Point` value           |             89 |            65 | **24** |

JDK 25's default (no flag) measures the same as the 12-byte column, to within 0.2 bytes.

Some rules of thumb fall out of this:

- **The rule is arithmetic.** The old size is 12 + fields rounded up to a multiple of 8, and the new
  size is 8 + fields rounded up. You save 8 bytes when the fields come to 0, 5, 6 or 7 bytes past a
  multiple of 8, and nothing when they come to 1–4 past.
- **Small objects with 8 bytes of fields win big.** `Long`, a two-`int` record and a linked-list node
  (a compressed reference plus an `int`) each drop a full third of their size.
- **Plenty of common shapes gain nothing.** `Integer` has 4 bytes of fields: 12 + 4 = 16 either way.
  The `Sample` record carries 26 bytes of fields (2 past 24), so it pads to 40 with either header.
- **Strings and small arrays mostly break even.** The array header is 16 bytes, and now 12, but the
  length field and alignment eat the difference for common sizes.
- **Hash maps are where it adds up.** A `HashMap.Node` (16 bytes of fields), its boxed `Long` key and a
  small value object each save 8 bytes, which is 24 bytes per entry, or 27%. Caches, session stores, and
  anything that's mostly maps of small objects benefit most. (JEP 534 reports 22% less heap on SPECjbb2015.)

The practical upshot: you can't estimate your saving from your object count. You have to
measure your live set. So that's what the benchmark app does.

# G1 on one CPU

JEP 523 is the change I'd pay more attention to. Since JDK 9, a JVM that saw a single CPU or less
than 1792 MB of memory picked Serial. Serial has no concurrent threads, so there's nothing to fight
your application for that one core. The JEP's argument is that G1 has closed the gap: its throughput
is "close to that of Serial," its latency has always been better, and its native memory overhead is
now "comparable." Notably, the JEP gives no numbers for this.

A lot of us run Spring Boot services in `--cpus 1` pods. On JDK 25 and 26 those services have
been on Serial the whole time, whether or not anyone chose it. On JDK 27 they're on G1. That's the
case the benchmark's `small` profile targets.

# The benchmark

## The application

An in-memory, ADS-B style telemetry cache in Spring Boot 4.1 (webmvc + actuator). It seeds 20,000
aircraft with their last 100 position reports each: 2,000,000 retained `Position` records, from a fixed
random seed, before readiness flips. Every run on every JDK holds identical data.

```java
public record Position(long epochMillis, double lat, double lon,
                       int altitudeFt, short groundSpeedKt, short heading) {}
```

That's 32 bytes of fields: 48 bytes with the old header, 40 with the new one. I picked it on purpose
as a shape that _does_ benefit. The probe table above covers shapes that don't.

The load generator mixes three requests 70/20/10:

- `GET /api/aircraft/{id}/track?limit=50`: small allocation plus JSON serialization
- `POST /api/aircraft/{id}/positions` with 20 positions: allocation, plus eviction of old-generation objects
- `GET /api/stats/altitude-bands`: a scan over every retained position, which is pure pointer chasing

The jar is compiled for release 25 and the same file runs on all three JDKs. Temurin 27 wasn't on
Docker Hub as an image yet when I built this, so the harness downloads Temurin 25, 26 and 27 tarballs and mounts them
into one `debian:trixie-slim` container. The OS layer is identical for every row.

## Profiles and rows

No `-Xmx` anywhere: the point is the defaults, so max heap is the JVM's usual 25% of the
container limit.

| Profile  | Limits                 | What it isolates                                                   |
| -------- | ---------------------- | ------------------------------------------------------------------ |
| `small`  | `--cpus 1 --memory 1g` | Below JEP 523's old threshold: 25 and 26 pick Serial, 27 picks G1  |
| `medium` | `--cpus 2 --memory 2g` | Above it: every JDK picks G1, so only the header change is in play |

| Row            | Flags                          |
| -------------- | ------------------------------ |
| `jdk25`        | none                           |
| `jdk25+coh`    | `-XX:+UseCompactObjectHeaders` |
| `jdk26`        | none                           |
| `jdk27`        | none                           |
| `jdk27-coh`    | `-XX:-UseCompactObjectHeaders` |
| `jdk27+serial` | `-XX:+UseSerialGC`             |

The last two rows each undo exactly one of JDK 27's changes. That's what separates "G1 did this"
from "headers did this."

## Measured

For each row: the collector and header layout the JVM actually reported, time from `docker run` to
readiness (including the 2M-record seed), the live set (heap used after a full GC), container memory
at idle and after load, and then throughput, p50, p99 and GC pause count/time over a 30-second mixed load
at 16 client threads, after a warm-up. Three runs per row, medians reported.

# Results

## `small`: 1 CPU, 1 GiB

| Row            | Collector | Live set MiB | Container MiB (loaded) | req/s | p50 ms | p99 ms | GC pauses / ms |
| -------------- | --------- | -----------: | ---------------------: | ----: | -----: | -----: | -------------: |
| `jdk25`        | Serial    |        118.4 |                    383 | 1,550 |    1.9 |   94.5 |       22 / 129 |
| `jdk25+coh`    | Serial    |        101.2 |                    356 | 1,294 |    2.1 |  103.6 |       20 / 125 |
| `jdk26`        | Serial    |        118.6 |                    388 | 1,571 |    1.8 |   94.6 |        19 / 49 |
| `jdk27`        | G1        |        101.4 |                    346 | 1,280 |    2.0 |  107.7 |       29 / 161 |
| `jdk27-coh`    | G1        |        118.5 |                    363 | 1,131 |    2.0 |  123.5 |       30 / 166 |
| `jdk27+serial` | Serial    |        101.3 |                    370 | 1,610 |    1.9 |   91.9 |        19 / 79 |

## `medium`: 2 CPUs, 2 GiB

| Row            | Collector | Live set MiB | Container MiB (loaded) | req/s | p50 ms | p99 ms | GC pauses / ms |
| -------------- | --------- | -----------: | ---------------------: | ----: | -----: | -----: | -------------: |
| `jdk25`        | G1        |        118.3 |                    447 | 2,203 |    1.4 |   69.1 |        20 / 98 |
| `jdk25+coh`    | G1        |        101.0 |                    376 | 1,769 |    2.2 |   90.7 |        25 / 96 |
| `jdk26`        | G1        |        118.4 |                    450 | 2,217 |    1.6 |   72.6 |       20 / 100 |
| `jdk27`        | G1        |        101.4 |                    393 | 2,152 |    2.0 |   73.2 |       19 / 100 |
| `jdk27-coh`    | G1        |        118.6 |                    438 | 2,435 |    1.5 |   62.7 |        20 / 97 |
| `jdk27+serial` | Serial    |        101.3 |                    417 | 2,939 |    1.3 |   51.2 |       36 / 124 |

Medians of three runs. In the `medium` profile the container had the whole 2-CPU Docker VM to itself.

## What the numbers say

**Compact headers: the memory win showed up in every row that had them.** Every row with compact headers held the
same 2M positions in 101 MiB instead of 118.5 MiB, **14.5% less live set**, on JDK 25 with the flag and on JDK 27 by
default alike. The layout math accounts for most of it: 2M positions × 8 bytes is about 15 of the 17 MiB saved. The rest
is Spring's own objects getting smaller too. Container memory under load fell with it: 388 → 346 MiB on one CPU (-11%) and
450 → 393 MiB on two (-13%) going from `jdk26` to `jdk27`. For memory-limited pods, that's the headline of this release.

**On one CPU, JDK 27's switch to G1 costs throughput.** `jdk26` (Serial) served 1,571 req/s at a p99 of 94.6 ms.
`jdk27` (G1) served 1,280 at 107.7 ms: **18.5% fewer requests and a 14% worse p99**. It also ran 29 collections
totalling 161 ms against Serial's 19 and 49 ms. Pinning Serial back (`jdk27+serial`) recovers all of it and a little
more: 1,610 req/s at 91.9 ms, the best single-CPU row, and also the most consistent (1,606–1,611 req/s across
three runs). The likely reason is that with one core, G1's concurrent refinement and marking threads compete with the
application for the only CPU there is. Either way, JEP 523's "close to Serial" wasn't close for this workload.

**On two CPUs, Serial won by even more.** Every default row is G1 here, and `jdk26` and `jdk27` were within 3% of
each other. But `jdk27+serial` served **2,939 req/s against 2,152 for the G1 default (+37%) with a p99 of 51 ms
against 73 ms**, again with tight run-to-run spread. And Serial spent _more_ time in pauses (36 collections, 124 ms,
against G1's 19 and 100 ms) and still won, so G1's cost here isn't in its pauses. It's in the work G1 does while the
application runs: heavier write barriers on reference stores, plus concurrent refinement and marking. With a 512 MiB heap
and a ~100 MiB live set, that overhead buys nothing. G1 earns its keep with bigger heaps and pause-time targets, and this
isn't that.

**Compact headers aren't a free throughput win.** On one CPU with G1, compact headers helped: `jdk27` beat `jdk27-coh`
by 13% and had a better p99. On two CPUs they hurt on both JDKs: `jdk27` served 12% fewer requests than `jdk27-coh`, and
`jdk25+coh` 20% fewer than `jdk25`. On Serial the picture was mixed: `jdk27+serial` was the best single-CPU row, but
`jdk25+coh` was also the noisiest row in the whole run (941–1,478 req/s across its three runs). I don't have a
mechanism I trust for the two-CPU drop. Decoding the class pointer from the mark word costs a little on every type
check, and this workload serializes a lot of small objects through Jackson, but that's a hypothesis, not a measurement.
The layout change is deterministic. Its throughput effect depends on the collector, the cores and the workload.

# Post-quantum TLS: probably nothing to do

JEP 527 puts the hybrid `X25519MLKEM768` group (classical X25519 combined with the ML-KEM-768
post-quantum KEM) first in the client's and server's TLS 1.3 named groups. Clients offer it, and if
the other side supports it, the handshake uses it. If not, it falls back to `x25519` as before. I covered
_why_ hybrid key exchange matters (harvest-now-decrypt-later) in
[the post-quantum cryptography guide](/posts/ultimate-guide-post-quantum-cryptography-tls).

The costs are small but real. The hybrid key share adds about 1.2 KB to the ClientHello (a 1,184-byte
ML-KEM-768 public key next to the 32-byte X25519 one) and about 1.1 KB to the ServerHello, which usually pushes
the ClientHello past a single packet. Middleboxes that assume a single-packet
ClientHello are the historical failure mode here. If you run through an old TLS-inspecting proxy,
test an outbound call before rolling out. To pin the old behavior per JVM:

```bash
-Djdk.tls.namedGroups=x25519,secp256r1,secp384r1,secp521r1,x448,ffdhe2048,ffdhe3072,ffdhe4096,ffdhe6144,ffdhe8192
```

That line also restores the two FFDHE groups JDK 27 dropped.

# JFR stops writing your secrets into recordings

This one is pure upside, and it's also a reason to look at recordings you've already made. A flight recording
captures the JVM's environment variables, system properties and command-line arguments. Before JDK 27 it captured
them verbatim. `probes/jfr-redaction.sh` starts a JVM with a secret in each place and prints what ended up in the
`.jfr` file:

```
== openjdk version "26.0.2.1"
  key = "DB_PASSWORD"	  value = "hunter2"
  key = "API_TOKEN"	  value = "abc123"
  key = "app.secret"	  value = "s3cr3t"
  jvmArguments = "-XX:StartFlightRecording:... -Dapp.secret=s3cr3t ..."
== openjdk version "27"
  key = "DB_PASSWORD"	  value = "[REDACTED]"
  key = "API_TOKEN"	  value = "[REDACTED]"
  key = "app.secret"	  value = "[REDACTED]"
  jvmArguments = "-XX:StartFlightRecording:... [REDACTED] ..."
```

Names that don't look sensitive, like `AWS_REGION`, pass through. The default patterns cover the usual suspects
(`*password*`, `*secret*`, `*token*`, `*credential*` and friends). Two sub-options of `-XX:FlightRecorderOptions`
control it: `redact-key` covers environment variables and system properties, and `redact-argument` covers JVM and
program arguments. A leading `+` adds your own patterns to the defaults. Turning redaction fully off takes _both_
set to `none`. I checked: `redact-argument=none` on its own still redacts the environment variables.

The part to act on: every `.jfr` file your JDK 25 or 26 services produced, and attached to a support ticket or
left in a diagnostics bucket, has those values in plain text. If your secrets arrive as environment variables,
which in Kubernetes they usually do, it's worth a look.

# What I'd do

**Pin your collector explicitly, and for small pods, measure Serial.** This is the real lesson of JEP 523. If your
base image or Helm chart sets `JAVA_TOOL_OPTIONS`, add `-XX:+UseSerialGC` or `-XX:+UseG1GC` so that a JDK upgrade
can't change the collector under you. For services with a heap of a few hundred MiB, Serial beat G1 here by 26% on
one CPU and 37% on two, with a better p99 both times. Run this benchmark's profiles against your own service before
you assume G1 is the right answer at that size.

**Take compact headers for the memory, and check the throughput.** A 14.5% smaller live set and 11–13% less container
memory is real money in a fleet of memory-limited pods, and the feature has been production-ready since JDK 25 (Amazon
runs it across hundreds of services). But throughput moved anywhere from +13% to -20% depending on the collector and
core count. If a latency-sensitive service gets slower on JDK 27, try `-XX:-UseCompactObjectHeaders` on its own before
blaming anything else.

**Check your TLS peers**, especially anything that needed `ffdhe6144` or `ffdhe8192`.

**Treat old JFR recordings as sensitive**, and enjoy not having to on JDK 27.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/java-27-defaults-benchmark
./scripts/fetch-jdks.sh                      # Temurin 25/26/27 for Docker's architecture
(cd bench-app && ./gradlew bootJar)
python3 scripts/benchmark.py measure         # both profiles, all rows
```

The probes need nothing but a JDK:

```bash
java probes/DefaultsProbe.java
java -Xmx2g probes/HeaderFootprint.java
java -Xmx2g -XX:-UseCompactObjectHeaders probes/HeaderFootprint.java
./probes/jfr-redaction.sh .jdks/jdk26 .jdks/jdk27
```
