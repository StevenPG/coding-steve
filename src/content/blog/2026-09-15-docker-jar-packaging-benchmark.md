---
author: StevenPG
pubDatetime: 2026-09-15T12:00:00.000Z
title: "Ten Ways to Dockerize a Spring Boot Jar, Measured"
slug: docker-jar-packaging-benchmark
featured: true
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - docker
  - spring boot
  - jlink
  - performance
  - devops
description: Fat jar, JRE base, layered jar, extracted jar, AppCDS, JDK 25 AOT cache, jlink, Alpine and distroless — the same Spring Boot application packaged ten ways and measured for build time, image size, layer churn, startup, memory and throughput.
---

## Table of Contents

[[toc]]

# The question

`FROM eclipse-temurin:latest`, `COPY app.jar` and `ENTRYPOINT ["java","-jar","/app/app.jar"]` is three lines, works
everywhere, and is what most Spring Boot services in production actually look like.

There is also a pile of advice telling you not to do that: use the JRE image, use the
layered jar, extract the jar, train a CDS archive, train an AOT cache, build a `jlink`
runtime, move to Alpine, move to distroless. Each piece of advice is individually
correct. What almost nobody publishes is what each one is *worth*, on the same
application, measured the same way, with the costs shown next to the benefits.

So I built ten Dockerfiles around one Spring Boot application and measured all of them.

Every number in this post came off a real run of the code in
[DemosAndArticleContent/blog/docker-jar-packaging-benchmark](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/docker-jar-packaging-benchmark).
Nothing here is estimated. The harness that produced the tables is in that directory
(`scripts/benchmark.py`) and re-running it on your own hardware is one command.

A note on the hardware, because it matters: this ran on a modest shared cloud container —
4 vCPU Intel Xeon @ 2.10GHz, 16GB RAM, Ubuntu 24.04, Docker 29.3.1, Temurin 25.0.4 in the
images, containers limited to `--memory 1g --cpus 2`. Your laptop is faster. The absolute
startup numbers will be better on real hardware; the relative differences are the point.

# The application under test

A hello-world controller packages identically no matter what you do to it. Layer
caching, CDS, AOT and `jlink` only start to matter once there is a real classpath
behind the jar, so the benchmark subject is deliberately heavy:

- Spring Boot 4.1 on JDK 25 (LTS) — webmvc, data-jpa, validation, security, actuator
- 24 generated domain packages, 10 classes each: entity, enum, repository, projection,
  DTO, event, mapper, service, controller, seeder
- ~250 application classes, ~90 dependency jars, a **60MB fat jar**
- **~18,700 classes loaded** by the time the context is ready

The domain packages come out of a generator (`scripts/generate-domains.py`) and are
committed, so the source is real and the shape is regenerable. Every package looks like
this, an aerospace-flavoured CRUD slice:

```java
@RestController
@RequestMapping("/api/aircraft")
public class AircraftController {

    private final AircraftService service;

    public AircraftController(AircraftService service) {
        this.service = service;
    }

    @GetMapping
    public PageResponse<AircraftDto> list(
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size) {
        return service.list(page, size);
    }

    @GetMapping("/stats")
    public Map<String, Object> stats() {
        return service.stats();
    }
    // ...
}
```

The important property is that **the build stage is byte-for-byte identical in all ten
Dockerfiles**. Every variant ships the same `bench-app.jar`. Anything that differs in the
results differs because of packaging, not because the application was built differently.

# The ten variants

## 01 — Fat jar on the JDK image

The baseline. It built, ship it.

```dockerfile
FROM eclipse-temurin:25-jdk-noble
WORKDIR /app
COPY --from=build /workspace/app.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
```

## 02 — Fat jar on the JRE image

A one-word diff: `jdk` becomes `jre`. You lose `jcmd`, `jmap`, `jstack` and `jlink`
inside the container, which matters more than people admit when you are debugging a
production pod, but you pay nothing for the win.

## 03 — Spring Boot layered jar

A fat jar is one 60MB file. Change one line of your own code and all 60MB of it is a new
layer. Spring Boot knows which parts of the jar change at different rates and writes a
`layers.idx` into the jar describing them.

```dockerfile
FROM eclipse-temurin:25-jdk-noble AS layers
WORKDIR /layers
COPY --from=build /workspace/app.jar app.jar
RUN java -Djarmode=tools -jar app.jar extract --layers --launcher --destination extracted

FROM eclipse-temurin:25-jre-noble
WORKDIR /app
# Order matters: slowest-changing layer first.
COPY --from=layers /layers/extracted/dependencies/ ./
COPY --from=layers /layers/extracted/spring-boot-loader/ ./
COPY --from=layers /layers/extracted/snapshot-dependencies/ ./
COPY --from=layers /layers/extracted/application/ ./
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "org.springframework.boot.loader.launch.JarLauncher"]
```

Note the jarmode: **`-Djarmode=layertools` is gone in Boot 4**. The replacement is
`-Djarmode=tools extract --layers`, and you need `--launcher` if you want the exploded
layout that `JarLauncher` runs.

## 04 — Fully extracted jar

The other extraction mode drops the nested-jar layout entirely and gives you a thin jar
plus a `lib/` directory, with the dependencies listed in the manifest `Class-Path`:

```dockerfile
RUN java -Djarmode=tools -jar app.jar extract --destination /app-extracted
...
COPY --from=explode /app-extracted/lib lib
COPY --from=explode /app-extracted/app.jar app.jar
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
```

No `LaunchedClassLoader`, no nested-jar protocol — just a plain classpath. This is also
the prerequisite for the next two variants: CDS and the AOT cache both key off the
classpath, and a fat jar's nested entries are not something they can archive well.

## 05 — Extracted + AppCDS

Class Data Sharing memory-maps a pre-parsed form of the classes instead of reading and
verifying them from jars on every boot. You train the archive at **build** time by
starting the app once and exiting:

```dockerfile
FROM eclipse-temurin:25-jre-noble AS train
WORKDIR /app
COPY --from=explode /app-extracted/lib lib
COPY --from=explode /app-extracted/app.jar app.jar
RUN java -XX:ArchiveClassesAtExit=/app/app.jsa \
        -Dspring.context.exit=onRefresh \
        -Dbench.seed.rows=0 \
        -jar /app/app.jar

FROM eclipse-temurin:25-jre-noble
WORKDIR /app
COPY --from=train /app /app
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-XX:SharedArchiveFile=/app/app.jsa", "-jar", "/app/app.jar"]
```

`-Dspring.context.exit=onRefresh` is the trick that makes this work in a build stage: the
context refreshes, every bean is instantiated, every class you care about is loaded, and
then the JVM exits normally so the archive gets written.

## 06 — Extracted + JDK 25 AOT cache

Project Leyden's AOT cache is CDS's successor: it stores linked and pre-resolved classes,
not just parsed class data. AOT class loading and linking landed in JDK 24 (JEP 483); JDK
25 added AOT method profiling (JEP 515) and, usefully here, command-line ergonomics (JEP
514) that collapse the old two-step record-then-create dance into one flag:

```dockerfile
RUN java -XX:AOTCacheOutput=/app/app.aot \
        -Dspring.context.exit=onRefresh \
        -Dbench.seed.rows=0 \
        -jar /app/app.jar
...
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-XX:AOTCache=/app/app.aot", "-jar", "/app/app.jar"]
```

## 07 — jlink custom runtime + fat jar

`jdeps` works out which JDK modules the classpath actually touches; `jlink` assembles a
runtime image containing only those.

```dockerfile
FROM eclipse-temurin:25-jdk-noble AS jlink
WORKDIR /jlink
COPY --from=build /workspace/app.jar app.jar
RUN jar xf app.jar \
 && jdeps --ignore-missing-deps -q \
      --recursive \
      --multi-release 25 \
      --print-module-deps \
      --class-path 'BOOT-INF/lib/*' \
      app.jar > /jlink/deps.txt
RUN jlink \
      --add-modules "$(cat /jlink/deps.txt),jdk.crypto.ec,jdk.management,jdk.localedata" \
      --include-locales=en \
      --strip-debug \
      --no-man-pages \
      --no-header-files \
      --compress=zip-6 \
      --output /javaruntime

FROM debian:trixie-slim
ENV JAVA_HOME=/opt/java
ENV PATH="${JAVA_HOME}/bin:${PATH}"
COPY --from=jlink /javaruntime ${JAVA_HOME}
WORKDIR /app
COPY --from=build /workspace/app.jar app.jar
ENTRYPOINT ["/opt/java/bin/java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
```

Three details that bite people, and which I wrote up in more depth in the
[JLink reference guide](/posts/jlink-java-runtime-optimization/):

- `--ignore-missing-deps` is **mandatory**. Spring's optional integrations reference
  classes that are not on your classpath, and `jdeps` fails without it.
- `jdeps` cannot see reflection. `jdk.crypto.ec` (TLS curves), `jdk.management`
  (actuator metrics) and `jdk.localedata` have to be added by hand. Symptoms of getting
  this wrong show up at runtime, not build time.
- `--compress=2` is deprecated; on JDK 21+ it is `--compress=zip-6`.

## 08 — jlink + extracted + AOT cache

Everything stacked. One extra constraint: **an AOT cache is tied to the exact `java`
binary that produced it**, so the training run has to use the jlink runtime rather than
the build JDK, or the cache is rejected at startup and you silently get no benefit.

```dockerfile
FROM debian:trixie-slim AS train
ENV JAVA_HOME=/opt/java
COPY --from=jlink /javaruntime ${JAVA_HOME}
WORKDIR /app
COPY --from=jlink /app-extracted/lib lib
COPY --from=jlink /app-extracted/app.jar app.jar
RUN /opt/java/bin/java -XX:AOTCacheOutput=/app/app.aot \
        -Dspring.context.exit=onRefresh \
        -Dbench.seed.rows=0 \
        -jar /app/app.jar
```

## 09 — jlink on Alpine (musl)

Same jlink pipeline, run inside `eclipse-temurin:25-jdk-alpine` so the runtime links
against musl, then copied onto a bare `alpine:3.22`.

## 10 — jlink on distroless

Same jlink runtime, copied onto `gcr.io/distroless/base-debian13`. No shell, no package
manager, no busybox. Great security posture, miserable debugging experience — you cannot
`exec` into it and poke around because there is nothing to exec.

# Results

## Build and image size

| Variant | What it is | Pull size (compressed) | On disk | Layers | Cold build | Rebuild after code change | Re-pulled after a code change |
|---|---|---|---|---|---|---|---|
| `01-fatjar-jdk` | Fat jar on the full JDK image | 196 MB | 668 MB | 7 | 19.9s | 14.5s | 63 MB |
| `02-fatjar-jre` | Fat jar on the JRE image | 161 MB | 549 MB | 7 | 19.8s | 14.7s | 63 MB |
| `03-layered` | Spring Boot layered jar, JRE image | 161 MB | 551 MB | 10 | 21.6s | 13.7s | 1.5 MB |
| `04-extracted` | Extracted jar (thin jar + lib/), JRE image | 161 MB | 549 MB | 8 | 20.8s | 14.4s | 0.4 MB |
| `05-extracted-cds` | Extracted + AppCDS archive | 188 MB | 679 MB | 7 | 40.1s | 34.9s | 166 MB |
| `06-extracted-aot` | Extracted + JDK 25 AOT cache | 191 MB | 712 MB | 7 | 50.7s | 45.4s | 195 MB |
| `07-jlink-fatjar` | jlink runtime + fat jar, debian-slim | 128 MB | 347 MB | 4 | 34.5s | 29.6s | 63 MB |
| `08-jlink-extracted-aot` | jlink + extracted + AOT cache | 159 MB | 509 MB | 4 | 64.8s | 58.2s | 195 MB |
| `09-jlink-alpine` | jlink (musl) + extracted, Alpine | 101 MB | 239 MB | 5 | 42.1s | 28.4s | 0.4 MB |
| `10-jlink-distroless` | jlink + extracted, distroless | 108 MB | 267 MB | 21 | 34.1s | 25.7s | 0.4 MB |

## Startup, memory and throughput

| Variant | Startup (median) | Startup (best) | Classes loaded | RSS idle | RSS under load | Throughput | p50 | p99 |
|---|---|---|---|---|---|---|---|---|
| `01-fatjar-jdk` | 9152.8 ms | 8887.6 ms | 19246 | 298.4 MB | 370.6 MB | 775.3 rps | 12.9 ms | 87.97 ms |
| `02-fatjar-jre` | 8819.9 ms | 8723.9 ms | 19223 | 300.7 MB | 378.9 MB | 758.6 rps | 13.5 ms | 87.23 ms |
| `03-layered` | 7967.2 ms | 7705.1 ms | 19157 | 305.3 MB | 378.6 MB | 801.5 rps | 12.57 ms | 90.46 ms |
| `04-extracted` | 7809.3 ms | 7659.6 ms | 19117 | 296.6 MB | 388.0 MB | 758.5 rps | 13.65 ms | 88.76 ms |
| `05-extracted-cds` | 5578.1 ms | 5446.5 ms | 18923 | 276.6 MB | 363.5 MB | 736.8 rps | 13.49 ms | 88.76 ms |
| `06-extracted-aot` | 4461.8 ms | 4389.7 ms | 19664 | 270.7 MB | 358.1 MB | 962.5 rps | 12.22 ms | 75.73 ms |
| `07-jlink-fatjar` | 9235.1 ms | 9018.1 ms | 19202 | 282.5 MB | 369.7 MB | 807.3 rps | 12.79 ms | 84.5 ms |
| `08-jlink-extracted-aot` | 4376.2 ms | 4220.7 ms | 19636 | 272.2 MB | 367.4 MB | 1009.0 rps | 11.79 ms | 75.27 ms |
| `09-jlink-alpine` | 9028.0 ms | 8740.2 ms | 19099 | 286.5 MB | 348.0 MB | 693.1 rps | 13.97 ms | 90.19 ms |
| `10-jlink-distroless` | 7926.3 ms | 7692.5 ms | 19090 | 296.6 MB | 362.0 MB | 785.1 rps | 13.04 ms | 88.01 ms |

Startup is the median of five `docker run` → first HTTP 200 measurements. Throughput is a
20 second, 16 thread run starting three seconds after readiness.

# What the numbers say

## The JRE base image is free money

`jdk` → `jre` is 35MB off the pull and 119MB off the disk for a one-word diff, with no
measurable runtime cost. The only thing you give up is the JDK tooling inside the
container — `jcmd`, `jmap`, `jstack`, `jfr`. That is a real loss when you are debugging a
misbehaving pod, and it is the one argument for staying on the JDK image. Decide it
deliberately rather than by accident.

## Layering is about the rebuild, not the image

Layered (03) and fat-jar-on-JRE (02) are the same 161MB pull. The difference only shows up
on the *second* deploy:

- fat jar: **63MB** of new layers per code change
- layered jar: **1.5MB**
- extracted jar: **0.4MB**

That is a 150x reduction in what every node in your cluster pulls when you ship a one-line
fix. On a 40-node deployment that is 2.5GB of pull traffic versus 16MB. Nothing else in
this post has that kind of ratio, and it costs you four extra `COPY` lines.

The extracted layout (04) beats the layered one here because Spring Boot's "application"
layer contains the exploded classes *and* the loader index, while the extracted layout puts
a 1.4MB thin jar next to an untouched `lib/` directory.

## Unpacking the jar is worth a second of startup on its own

Fat jar on JRE: 8.8s. Same jar extracted: 7.8s. Same application, same classpath contents,
**~1 second faster** purely because the JVM is reading classes from a plain directory
instead of walking Spring Boot's nested-jar layout through `LaunchedClassLoader`.

This is the cheapest startup win available and it requires no training run, no extra image
size, and no new failure mode. If you change one thing after reading this post, change this
one.

## CDS and AOT are the real startup levers

| | startup | vs baseline |
|---|---|---|
| fat jar, JRE | 8.8s | — |
| extracted | 7.8s | −11% |
| extracted + AppCDS | 5.6s | −37% |
| extracted + AOT cache | 4.5s | −49% |
| jlink + extracted + AOT | 4.4s | −50% |

**Half the startup time, gone.** And the AOT cache beats CDS by another second despite
loading *more* classes (19,664 vs 18,923), which is the whole point of Leyden: the cache
holds linked, resolved classes, so loading more of them costs less.

They also come out ahead on memory — 271MB idle for the AOT variant against 301MB for the
fat jar — because the archive is memory-mapped rather than parsed onto the heap.

The bill arrives in two places. First, image size: the AOT cache is a **132MB file** and the
CDS archive is 103MB, which is why variant 06 is the largest image in the table at 712MB on
disk. Second, layer churn: **every code change invalidates the whole cache**, so a one-line
fix re-pulls 195MB instead of 0.4MB. CDS/AOT and small deltas are directly opposed, and you
have to pick which one your deployment cares about.

## jlink shrinks the image and does nothing for startup

Variant 07 (jlink + fat jar) is 128MB compressed against 161MB for the JRE base — a 20%
cut — and 347MB on disk against 549MB, a 37% cut. But startup is **9.2s**, statistically
identical to the 8.8s baseline. A smaller runtime image does not mean a faster JVM: you
removed modules the application was never loading.

Stacked with the Alpine/musl build (09), you get the smallest image here by a wide margin:
**101MB compressed, 239MB on disk** — 2.3x smaller than the plain JRE image and 2.8x
smaller than the JDK image. Startup there is 9.0s, the musl allocator being a touch slower
than glibc, which is the long-standing Alpine trade.

Distroless (10) lands between the two at 108MB with glibc startup behaviour (7.9s, because
it also uses the extracted layout), and gives you an image with no shell to exec into —
excellent for attack surface, painful the first time you need to look at something inside a
running container.

## Throughput barely moves, except where the AOT cache is still paying off

Everything sits in the 700–800 rps band except the two AOT variants, at 962 and 1009 rps
with visibly better p99 (75ms vs 88ms). I re-ran that comparison three times to be sure:
within-variant spread was ±3%, the gap was a consistent ~25%.

That is not a permanent throughput advantage. The load window starts three seconds after
readiness, so it lands squarely in warm-up: the baseline is still loading and linking
classes while serving traffic, and the AOT variants are not. For a service that scales up
and down constantly, that is a meaningful window. For one that runs for weeks, it washes
out.

## Build time is the quiet cost

The training runs are not free:

- no training: 20s cold, 14s rebuild
- CDS: 40s cold, 35s rebuild
- AOT: 51s cold, 45s rebuild
- jlink + AOT: **65s cold, 58s rebuild**

Every CDS/AOT rebuild pays for a full application startup inside the build. On a repo where
CI runs on every push, tripling image build time to save four seconds of startup is a trade
worth doing the arithmetic on, and the answer depends entirely on how often you deploy
versus how often your pods restart.

# How this was measured

The harness (`scripts/benchmark.py`) is deliberately boring: it shells out to the `docker`
CLI, one variant at a time, nothing running in parallel.

- **Cold build** is `docker build --no-cache`.
- **Rebuild after a code change** rewrites a single string constant in a single class —
  not a comment. A comment-only edit is invisible: javac strips comments and Boot
  normalises timestamps inside `bootJar`, so the rebuilt image comes out bit-identical and
  you measure nothing. That is itself a useful thing to know.
- **Re-pulled after a code change** is the sum of the compressed sizes of layers whose
  digest changed between the two builds. It is the number that actually costs you money
  and rollout time across a fleet of nodes.
- **Startup** is wall-clock from `docker run` to the first HTTP 200 from
  `/actuator/health`, polled every 5ms, five runs per variant, median reported.
- **Memory** is `docker stats` at idle (3 seconds after ready) and again at the end of the
  load run.
- **Load** is 16 threads for 20 seconds against a mix of list, by-id, aggregate and
  actuator endpoints.

Containers run with `--memory 1g --cpus 2` so no variant gets to use more of the box than
another.

One deliberate deviation from a naive "just run docker build" setup: dependency resolution
is pulled out of the measurement. The builds run against a pre-seeded builder image with
`--offline`:

```bash
cd bench-app && ./gradlew bootJar && cd ..
./scripts/seed-builder-image.sh
python3 scripts/benchmark.py build --offline
```

Downloading 90 jars is network-bound and would have added more variance than the effects
being measured. It also happens to be exactly the mechanism you want for air-gapped
builds, which is why the Dockerfiles expose it as two build args (`BUILD_IMAGE` and
`GRADLE_ARGS`) that default to the stock public image and a normal online build.

# Verifying the caches actually engaged

This is the part that silently goes wrong. A CDS archive or AOT cache whose classpath
does not match at runtime is ignored — no error, no warning at default log levels, just
your old startup time back. Check it:

```bash
docker run --rm --entrypoint java jarbench:06-extracted-aot \
  -Xlog:aot -XX:AOTCache=/app/app.aot -Dspring.context.exit=onRefresh -jar /app/app.jar
```

You want to see:

```
[0.004s][info][aot] trying to map /app/app.aot
[0.004s][info][aot] Opened AOT cache /app/app.aot.
```

The same check for CDS is `-Xlog:cds` and `-Xshare:on` — with `-Xshare:on` the JVM refuses
to start rather than silently falling back, which makes it a good assertion to put in a
smoke test.

# Recommendations

**If you do exactly one thing:** extract the jar. Variant 04 is four extra lines, one
second faster to start, and drops per-deploy layer churn from 63MB to 0.4MB. There is no
downside.

**Default choice for most services:** variant 04, on the JRE base. Boring, small deltas,
no training step, no new failure modes, nothing to verify in CI.

**Scale-to-zero, serverless, or anything where cold start is user-visible:** variant 06 or
08 — extract and train an AOT cache. Half the startup time and better warm-up throughput.
Accept the ~190MB of layer churn per deploy and the extra 30-45 seconds of build time, and
add an `-Xlog:aot` assertion to your smoke tests so a classpath change cannot silently
disable the cache.

**Bandwidth-constrained or high-node-count fleets:** variant 09 or 10. 101–108MB
compressed, 0.4MB per code change. You are trading startup time and debuggability for
image size, so only do it if image size is a problem you actually have.

**Don't reach for jlink to make things faster.** It makes things *smaller*. If startup is
what you care about, the AOT cache is the lever, and it works just as well on a stock JRE
base image.

**Don't bother with CDS if you are on JDK 24 or later.** The AOT cache is faster, costs
about the same image size, and takes the same training run. CDS remains the right answer on
older LTS lines.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/docker-jar-packaging-benchmark
python3 scripts/benchmark.py all
```

The numbers above are from one machine. The absolute values will be different on yours;
the relative shape — layering is free, extraction is free, caches cost image size, jlink
costs build complexity — should hold.
