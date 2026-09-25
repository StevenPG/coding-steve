---
author: StevenPG
pubDatetime: 2026-09-25T12:00:00.000Z
title: "Java 27 Changed Your Defaults: What Happens When You Just Bump the Base Image"
slug: java-27-new-defaults-benchmark
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - performance
  - spring boot
  - docker
description: JDK 27 turns on compact object headers, makes G1 the default collector even on one-CPU containers, and offers post-quantum hybrid TLS first. The same Spring Boot jar measured on JDK 25, 26 and 27 to see what changes when you only change the base image tag.
---

## Table of Contents

[[toc]]

# Only the tag changed

JDK 27 went GA on September 15. Most of us will adopt it by changing one line:

```dockerfile
FROM eclipse-temurin:26-jre
FROM eclipse-temurin:27-jre
```

No new flags and no code changes. Then the service is running under different defaults, because three of
the nine JEPs in this release change behavior you never opted into:

| JEP | What changed | Undo it with |
|---|---|---|
| [534: Compact Object Headers by Default](https://openjdk.org/jeps/534) | Object headers shrink from 12 bytes to 8 | `-XX:-UseCompactObjectHeaders` |
| [523: Make G1 the Default GC in All Environments](https://openjdk.org/jeps/523) | A JVM that sees 1 CPU or < 1792 MB no longer picks Serial | `-XX:+UseSerialGC` |
| [527: Post-Quantum Hybrid Key Exchange for TLS 1.3](https://openjdk.org/jeps/527) | `X25519MLKEM768` is offered first in every TLS handshake | `-Djdk.tls.namedGroups=...` |

The other six are previews and incubators you have to opt into: lazy constants, primitive
patterns, structured concurrency, the Vector API, and PEM encodings. The last one, JFR in-process
redaction, is a feature you turn on when you want it.

This post is about the three that happen to you. I built a small harness that runs the same
Spring Boot jar on JDK 25, 26 and 27. It changes nothing but the `java` binary, inside containers
sized the way we actually size pods. Everything is in
[DemosAndArticleContent/blog/java-27-defaults-benchmark](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-27-defaults-benchmark).

> **[DRAFT NOTE: numbers pending]** The probe and object-layout tables below are real output.
> They're deterministic, so they don't depend on the host. The application benchmark tables are
> placeholders until the final pass runs on my M3 MacBook Pro.

# What the JVM picks, before and after

The quickest way to see all three changes is to ask the JVM. `probes/DefaultsProbe.java` is a
single-file program with no dependencies that prints what ergonomics decided. Here it is in a
`--cpus 1 --memory 1g` container, which is a completely ordinary pod size:

```bash
docker run --rm --cpus 1 --memory 1g -v $PWD/.jdks:/jdks:ro -v $PWD/probes:/p \
  debian:trixie-slim /jdks/jdk26/bin/java /p/DefaultsProbe.java
```

| | JDK 26 | JDK 27 |
|---|---|---|
| `availableProcessors` | 1 | 1 |
| Collector | **Serial** (`Copy`, `MarkSweepCompact`) | **G1** |
| Max heap | 255 MiB | 256 MiB |
| `UseCompactObjectHeaders` | false | **true** |
| First TLS named group | `x25519` | **`X25519MLKEM768`** |
| TLS named groups offered | 10 | **9** |

With no container limits on a 4-core host, JDK 26 already picks G1. That's why the collector
change is easy to miss if you test on a laptop and deploy to small pods. The difference only shows
up where JEP 523's old threshold applied.

The last row wasn't in any release summary I read. JDK 27 adds `X25519MLKEM768` at the front **and
drops `ffdhe6144` and `ffdhe8192`** from the default list. If something you talk to only offers
large finite-field Diffie-Hellman groups, and some old appliances and HSM front ends do, check it
before you roll out.

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

| Shape | 12-byte header | 8-byte header | Saved |
|---|---:|---:|---:|
| `new Object()` | 16 | 8 | **8** |
| `Integer` (outside the cache) | 16 | 16 | 0 |
| `Long` | 24 | 16 | **8** |
| `record Point(int x, int y)` | 24 | 16 | **8** |
| `Node { Node next; int value; }` | 24 | 16 | **8** |
| `record Sample(long, int, float, float, float, short)` | 40 | 40 | 0 |
| `byte[16]` | 32 | 32 | 0 |
| `String`, 8 Latin-1 chars (object + `byte[]`) | 48 | 48 | 0 |
| `ArrayList` holding 4 `Integer`s | 120 | 120 | 0 |
| `HashMap` entry, `Long` key -> `Point` value | 89 | 65 | **24** |

JDK 25's default (no flag) measures the same as the 12-byte column, to within 0.2 bytes.

Some rules of thumb fall out of this:

- **Small objects with an even number of 4-byte fields win.** `Long`, a two-`int` record, and a
  linked-list node each drop a full third of their size.
- **Objects whose fields add up to 4 mod 8 bytes gain nothing.** `Integer` is 12 + 4 = 16 either way.
  The `Sample` record carries 26 bytes of fields, so it pads to 40 with either header.
- **Strings and small arrays mostly break even.** The array header is 16 bytes, and now 12, but the
  length field and alignment eat the difference for common sizes.
- **Hash maps are where it adds up.** A `HashMap.Node`, its boxed `Long` key and a small value
  object each save 8 bytes, which is 24 bytes per entry, or 27%. Caches, session stores, anything that
  is mostly maps of small objects, is exactly where JEP 534 quotes its 22% heap reduction on SPECjbb.

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
as a shape that *does* benefit. The probe table above covers shapes that don't.

The load generator mixes three requests 70/20/10:

- `GET /api/aircraft/{id}/track?limit=50`: small allocation plus JSON serialization
- `POST /api/aircraft/{id}/positions` with 20 positions: allocation, plus eviction of old-generation objects
- `GET /api/stats/altitude-bands`: a scan over every retained position, which is pure pointer chasing

The jar is compiled for release 25 and the same file runs on all three JDKs. Temurin 27 wasn't on
Docker Hub as an image yet, so the harness downloads Temurin 25, 26 and 27 tarballs and mounts them
into one `debian:trixie-slim` container. The OS layer is identical for every row.

## Profiles and rows

No `-Xmx` anywhere: the point is the defaults, so max heap is the JVM's usual 25% of the
container limit.

| Profile | Limits | What it isolates |
|---|---|---|
| `small` | `--cpus 1 --memory 1g` | Below JEP 523's old threshold: 25 and 26 pick Serial, 27 picks G1 |
| `medium` | `--cpus 2 --memory 2g` | Above it: every JDK picks G1, so only the header change is in play |

| Row | Flags |
|---|---|
| `jdk25` | none |
| `jdk25+coh` | `-XX:+UseCompactObjectHeaders` |
| `jdk26` | none |
| `jdk27` | none |
| `jdk27-coh` | `-XX:-UseCompactObjectHeaders` |
| `jdk27+serial` | `-XX:+UseSerialGC` |

The last two rows each undo exactly one of JDK 27's changes. That's what separates "G1 did this"
from "headers did this."

## Measured

For each row: the collector and header layout the JVM actually reported, time from `docker run` to
readiness (including the 2M-record seed), the live set (heap used after a full GC), container memory
at idle and after load, and then throughput, p50, p99 and GC pause count/time over a 30-second mixed load
at 16 client threads, after a warm-up. Three runs per row, medians reported.

# Results

## `small`: 1 CPU, 1 GiB

| Row | Collector | Live set MiB | Container MiB (loaded) | req/s | p50 ms | p99 ms | GC pauses / ms |
|---|---|---:|---:|---:|---:|---:|---:|
| `jdk25` | Serial | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk25+coh` | Serial | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk26` | Serial | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27-coh` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27+serial` | Serial | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |

## `medium`: 2 CPUs, 2 GiB

| Row | Collector | Live set MiB | Container MiB (loaded) | req/s | p50 ms | p99 ms | GC pauses / ms |
|---|---|---:|---:|---:|---:|---:|---:|
| `jdk25` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk25+coh` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk26` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27-coh` | G1 | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| `jdk27+serial` | Serial | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |

## What to look for

A preliminary run on a shared 4-core cloud container is too noisy to publish, but it had a clear
shape. Watch whether the M3 confirms it:

- **The live set drops by the same amount on every JDK that has compact headers.** It was about 15%
  (119 to 101 MiB), whether the headers came from JDK 27's default or from `-XX:+UseCompactObjectHeaders` on
  JDK 25. The header change is the same change on 25 and 27. JDK 27 just stops asking you to opt in.
- **On one CPU, G1 was *slower* than Serial.** `jdk27` served noticeably fewer requests with a worse
  p99 than `jdk26`, and `jdk27+serial` recovered it. If that holds on real hardware, then JDK 27's
  default is a regression for single-CPU pods, even though the header change on its own is a win.
- **On two CPUs, the defaults agree.** Every default row is G1, so the difference between `jdk26` and `jdk27` is
  the header change. The surprise was `jdk27+serial`, which beat every G1 row on throughput and p99 at two CPUs too.
  With a 512 MiB heap and a ~100 MiB live set, Serial's short stop-the-world young collections may simply be
  cheaper than G1's concurrent bookkeeping. If the M3 agrees, "pick the collector for small heaps deliberately"
  applies well beyond one-CPU pods.

# Post-quantum TLS: probably nothing to do

JEP 527 puts the hybrid `X25519MLKEM768` group (classical X25519 combined with the ML-KEM-768
post-quantum KEM) first in the client's and server's TLS 1.3 named groups. Clients offer it, and if
the other side supports it, the handshake uses it. If not, it falls back to `x25519` as before. I covered
*why* hybrid key exchange matters (harvest-now-decrypt-later) in
[the post-quantum cryptography guide](/posts/ultimate-guide-post-quantum-cryptography-tls).

The costs are small but real. The hybrid key share adds about 1.2 KB to the ClientHello (a 1,184-byte
ML-KEM-768 public key next to the 32-byte X25519 one) and about 1.1 KB to the ServerHello, which pushes
the ClientHello past a single packet. Middleboxes that assume a single-packet
ClientHello are the historical failure mode here. If you run through an old TLS-inspecting proxy,
test an outbound call before rolling out. To pin the old behavior per JVM:

```bash
-Djdk.tls.namedGroups=x25519,secp256r1,secp384r1,secp521r1,x448,ffdhe2048,ffdhe3072,ffdhe4096,ffdhe6144,ffdhe8192
```

That line also restores the two FFDHE groups JDK 27 dropped.

# What I'd do

**Take compact headers.** It's the same feature that has been production-ready since JDK 25. Amazon
runs it across hundreds of services. The only question was whether you had turned it on. Measure your
live set before and after, and expect anything from nothing to 20%+ depending on your object shapes.

**Pin your collector explicitly.** This is the real lesson of JEP 523, and it holds whatever the benchmark
shows. If your base image or Helm chart sets `JAVA_TOOL_OPTIONS`, add `-XX:+UseG1GC` or
`-XX:+UseSerialGC` so that a JDK upgrade can't change the collector under you. For `--cpus 1` pods,
run this benchmark's `small` profile against your own service and pick the one that wins.

**Check your TLS peers**, especially anything that needed `ffdhe6144` or `ffdhe8192`.

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
```
