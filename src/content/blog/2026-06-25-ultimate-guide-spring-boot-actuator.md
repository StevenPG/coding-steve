---
author: StevenPG
pubDatetime: 2026-06-25T12:00:00.000Z
title: "The Ultimate Guide to Spring Boot Actuator"
slug: ultimate-guide-spring-boot-actuator
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - actuator
  - observability
  - metrics
  - micrometer
description: A comprehensive, hands-on tour of Spring Boot Actuator — every built-in endpoint, custom endpoints, health indicators and groups, Micrometer metrics, tracing, securing the management surface, and everything that changed in Spring Boot 4.
---

# The Ultimate Guide to Spring Boot Actuator

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Boot Actuator is one of those features almost everyone enables — `spring-boot-starter-actuator` shows up in basically every production `build.gradle` — and almost no one uses to a fraction of its potential. Most teams turn it on, expose `/actuator/health` for their load balancer, wire up `/actuator/prometheus`, and call it a day.

That's a shame, because Actuator is the single most underrated operational tool in the Spring ecosystem. It can tell you which auto-configuration fired and why, change a log level at runtime without a redeploy, dump the live thread state of a hung process, list every scheduled task with its next execution time, expose a Software Bill of Materials, and let you build your own custom management endpoints with read/write/delete semantics over both HTTP and JMX. All of that is sitting in a dependency you already have.

This guide is a full, end-to-end tour. Every example comes from a real, runnable demo — actually **two** demos: one on **Spring Boot 3.5** and one on **Spring Boot 4.0**, built to be byte-for-byte identical in behaviour so the only differences you see are the ones Spring Boot 4 genuinely introduced. The code lives at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/ultimate-actuator).

The body of this post is written against **Spring Boot 4** because that's where new projects should be starting in mid-2026. Where Spring Boot 3 differs, I call it out inline, and there's a consolidated [Spring Boot 3 → 4](#spring-boot-3--4-what-actually-changed) section near the end if you're mid-migration. If you've already read the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/), the actuator-specific changes here will slot right in.

If you just want a specific endpoint, use the table of contents. Otherwise read straight through — the mental model in the next section makes everything else click.

## What Actuator Actually Is

Before the endpoint-by-endpoint tour, it's worth being precise about the mental model, because a lot of Actuator confusion comes from not having one.

Actuator is a framework for **management endpoints**. An endpoint is a named unit of functionality — `health`, `metrics`, `loggers`, `beans` — identified by an `id`. Each endpoint can be exposed over one or more **technologies**:

- **Web** (HTTP) — the one everyone uses. Endpoints live under a base path, `/actuator` by default.
- **JMX** — the same endpoints, surfaced as MBeans. Off by default in modern Boot.

Two separate concerns govern whether you can actually call an endpoint, and conflating them is the #1 source of "why is my endpoint 404-ing":

1. **Exposure** — is the endpoint published over the chosen technology at all? Controlled by `management.endpoints.web.exposure.include`. By default only `health` is exposed over the web.
2. **Access** (Spring Boot 4) / **Enabled** (Spring Boot 3) — is the endpoint switched on, and may it perform write operations? In Boot 4 this is an `access` level: `none`, `read-only`, or `unrestricted`.

An endpoint must be both _enabled/accessible_ **and** _exposed_ before a request reaches it. They're independent knobs. Keep that distinction in your head and most of the surprises disappear.

On top of that sits a third concern that has nothing to do with Actuator's own config: **security**. Exposing an endpoint makes it _routable_; it does not make it _safe_. We'll wire up Spring Security properly in [its own section](#securing-the-management-surface).

The demo runs a small but realistic app: a `WidgetService` backed by Postgres (via JPA + Flyway), a Caffeine cache, a greeting controller, some scheduled tasks, and Micrometer wired to Prometheus and OpenTelemetry. Everything in this guide is exercised against that running app.

## Project Setup

### The One Starter

Everything starts with a single dependency:

```kotlin
// build.gradle.kts
implementation("org.springframework.boot:spring-boot-starter-actuator")
```

That alone gives you the endpoint infrastructure, the `health` and `info` endpoints, Micrometer's core, and auto-configuration that detects what else is on your classpath. Most of Actuator's power, though, comes from **what else is present**: Actuator notices Flyway and lights up the `flyway` endpoint and a Flyway health contributor; it notices your `CacheManager` and lights up `caches`; it notices a Prometheus registry and lights up `/actuator/prometheus`. The demo's other dependencies exist precisely so those endpoints have something real to report:

```kotlin
dependencies {
    // Core web app — produces real request metrics and traces
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")

    // The star of the show
    implementation("org.springframework.boot:spring-boot-starter-actuator")

    // Securing the management surface
    implementation("org.springframework.boot:spring-boot-starter-security")

    // Persistence -> db & flyway health indicators, HikariCP + JPA metrics
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-database-postgresql")
    runtimeOnly("org.postgresql:postgresql")

    // Caching -> caches endpoint + cache.* metrics
    implementation("org.springframework.boot:spring-boot-starter-cache")
    implementation("com.github.ben-manes.caffeine:caffeine")

    // Metrics export -> /actuator/prometheus
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")

    // Distributed tracing -> Micrometer Tracing bridge to OpenTelemetry + OTLP export
    implementation("io.micrometer:micrometer-tracing-bridge-otel")
    implementation("io.opentelemetry:opentelemetry-exporter-otlp")

    // Observation AOP -> enables @Observed / @Timed / @Counted aspects.
    // Spring Boot 3 used: spring-boot-starter-aop
    // Spring Boot 4 REMOVED that starter — pull spring-aspects directly:
    implementation("org.springframework:spring-aspects")
}
```

> **Spring Boot 3 difference:** in Boot 3 you'd write `implementation("org.springframework.boot:spring-boot-starter-aop")` for the Micrometer aspects. Boot 4 removed that starter; use `org.springframework:spring-aspects` (which brings in `spring-aop` + `aspectjweaver`) instead. This is the kind of small, copy-pasteable difference you'll hit all over a real migration.

### Exposing Endpoints

By default, only `health` is exposed over HTTP. The demo opens everything up so we can tour it — **do not do this blindly in production** (more on that in the [security](#securing-the-management-surface) and [production checklist](#production-checklist) sections):

```yaml
management:
  endpoints:
    web:
      exposure:
        include: "*" # expose EVERY endpoint over HTTP (demo only!)
      base-path: /actuator # default; shown for clarity
      path-mapping:
        health: healthz # rename /actuator/health -> /actuator/healthz
    jmx:
      exposure:
        include: "*" # also expose everything over JMX
```

A couple of things worth noticing immediately:

- `exposure.include` takes a comma-separated list of endpoint ids, or `"*"` for all. There's a matching `exposure.exclude`. In production you typically write something like `include: health,info,prometheus,metrics`.
- `path-mapping` lets you rename an endpoint's URL. The demo remaps `health` to `/actuator/healthz` to prove the feature exists — handy when an existing platform convention expects a particular path.

### The Spring Boot 4 Access Model

This is the single most important runtime change in Boot 4, so it's worth establishing up front. Spring Boot 3 had a per-endpoint boolean, `management.endpoint.<id>.enabled`. That flag was deprecated in 3.4 and **removed in 4.0**, replaced by a three-level `access` model plus a global default:

```yaml
management:
  endpoints:
    access:
      default: read-only # global default: none | read-only | unrestricted
  endpoint:
    shutdown:
      access: unrestricted # was: management.endpoint.shutdown.enabled: true
    loggers:
      access: unrestricted # write operations (changing levels) need "unrestricted"
```

The three levels mean:

| Access level   | Read operations (`@ReadOperation`) | Write/Delete operations (`@WriteOperation`/`@DeleteOperation`) |
| -------------- | ---------------------------------- | -------------------------------------------------------------- |
| `none`         | ❌                                 | ❌                                                             |
| `read-only`    | ✅                                 | ❌                                                             |
| `unrestricted` | ✅                                 | ✅                                                             |

The global `default: read-only` is a sensible, secure-by-default posture: every endpoint is readable, but nothing can _mutate_ state unless you explicitly grant it `unrestricted`. That's why `shutdown` and `loggers` (both of which expose write operations) override the default. **This bites people**, and we'll see it bite in a real way when we build a [custom endpoint](#building-custom-endpoints) — its write and delete operations silently return `405` until you opt it into `unrestricted`.

> **Spring Boot 3 equivalent:** the same config in Boot 3 is `management.endpoint.shutdown.enabled: true` and there is no `access.default` — write operations are available as soon as the endpoint is enabled. The Boot 4 model is stricter and, frankly, better.

With setup out of the way, let's walk the endpoints.

## The Health Endpoint

`health` is the endpoint you'll touch most, and it's far deeper than the `{"status":"UP"}` everyone knows.

### Health Indicators

A **health indicator** is a bean that contributes one component to the aggregated health response. Spring Boot ships a pile of them — `db`, `diskSpace`, `ping`, Flyway, Redis, and so on — and auto-registers any it can. You add your own by implementing `HealthIndicator`. The bean name, minus the `HealthIndicator` suffix, becomes the component key.

```java
// Spring Boot 4: health types moved to org.springframework.boot.health.contributor
// Spring Boot 3: they were in   org.springframework.boot.actuate.health
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;

@Component
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final Instant startedAt = Instant.now();

    @Override
    public Health health() {
        // In a real app you'd ping the provider here. We simulate a healthy response.
        long latencyMs = 42;
        if (latencyMs > 1000) {
            return Health.down()
                    .withDetail("provider", "AcmePay")
                    .withDetail("latencyMs", latencyMs)
                    .withDetail("reason", "latency above threshold")
                    .build();
        }
        return Health.up()
                .withDetail("provider", "AcmePay")
                .withDetail("latencyMs", latencyMs)
                .withDetail("uptime", Duration.between(startedAt, Instant.now()).toString())
                .build();
    }
}
```

That bean shows up under the `paymentGateway` key:

```json
"paymentGateway": {
  "details": {
    "provider": "AcmePay",
    "latencyMs": 42,
    "uptime": "PT27.16S"
  },
  "status": "UP"
}
```

### `AbstractHealthIndicator` and Custom Statuses

For anything that can throw, prefer `AbstractHealthIndicator`. It wraps your check in a try/catch and turns any thrown exception into a `DOWN` with the error attached — you never have to write that boilerplate. It's also the natural place to introduce a **custom status**. You are not limited to `UP`/`DOWN`:

```java
import org.springframework.boot.health.contributor.AbstractHealthIndicator;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.Status;

@Component
public class InventoryHealthIndicator extends AbstractHealthIndicator {

    public static final Status DEGRADED = new Status("DEGRADED", "Running with reduced capacity");

    private final AtomicInteger availableStock = new AtomicInteger(120);

    @Override
    protected void doHealthCheck(Health.Builder builder) {
        int stock = availableStock.get();
        builder.withDetail("availableStock", stock)
                .withDetail("warehouse", "EU-WEST-1");
        if (stock <= 0) {
            builder.down().withDetail("reason", "out of stock");
        } else if (stock < 25) {
            builder.status(DEGRADED).withDetail("reason", "stock running low");
        } else {
            builder.up();
        }
    }
}
```

A custom status raises two questions Spring Boot lets you answer in config: **what HTTP code does it map to**, and **how severe is it relative to the others** (which determines the aggregate status when multiple components disagree)?

```yaml
management:
  endpoint:
    health:
      status:
        http-mapping:
          DEGRADED: 200 # degraded is not an outage — keep returning 200
        # severity order, worst first. The aggregate takes the worst present status.
        order: DOWN,OUT_OF_SERVICE,DEGRADED,UP,UNKNOWN
```

Without the `http-mapping`, an unknown status defaults to `200`, but being explicit documents intent. The `order` matters: the overall `status` of the aggregated response is the worst-ranked status among all components.

### Showing (and Hiding) Details

Health details can leak information, so Spring Boot hides them by default. The demo shows them only to authenticated admins:

```yaml
management:
  endpoint:
    health:
      show-details: when_authorized # never | when-authorized | always
      show-components: when_authorized
```

So an anonymous load-balancer probe sees a bare `{"status":"UP"}`, while an admin sees the full component breakdown with details. That's exactly the posture you want.

### Health Groups and Kubernetes Probes

A **health group** is a named subset of indicators you can query independently at `/actuator/health/<group>`. This is how you implement Kubernetes liveness and readiness probes correctly — they should check _different_ things. Liveness asks "is the process wedged and in need of a restart?"; readiness asks "can it serve traffic right now?". A failing database should make you _not ready_ (stop routing traffic) but should **not** make you _not alive_ (a restart won't fix the database).

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true # adds livenessState / readinessState
      group:
        liveness:
          include: livenessState,ping
        readiness:
          include: readinessState,db,paymentGateway
        business: # a totally custom group
          include: inventory,paymentGateway
          show-details: always
```

Each group is its own endpoint. The readiness group bundles the DB and payment-gateway checks; the custom `business` group bundles our two domain indicators and always shows details:

```bash
curl localhost:8080/actuator/healthz/readiness
```

```json
{
  "components": {
    "db": {
      "details": { "database": "PostgreSQL", "validationQuery": "isValid()" },
      "status": "UP"
    },
    "paymentGateway": {
      "details": { "provider": "AcmePay", "latencyMs": 42 },
      "status": "UP"
    },
    "readinessState": { "status": "UP" }
  },
  "status": "UP"
}
```

> `probes.enabled: true` is automatic when Spring Boot detects it's running on Kubernetes, but turning it on explicitly means you get the same behaviour locally and in tests.

## The Info Endpoint

`info` aggregates read-only facts about the running application from a set of **info contributors**. The built-in ones are toggled individually:

```yaml
management:
  info:
    env: { enabled: true } # exposes any info.* properties you define
    java: { enabled: true } # JVM vendor/version
    os: { enabled: true } # operating system
    process: { enabled: true } # PID, CPU count, memory (Spring Boot 4 enables more here)
    build: { enabled: true } # from META-INF/build-info.properties
    git: { enabled: true, mode: full } # from git.properties
```

The `build` contributor reads `META-INF/build-info.properties`, which the Spring Boot Gradle/Maven plugin generates when you ask it to:

```kotlin
springBoot {
    buildInfo()   // generates build-info.properties -> info.build.* in /actuator/info
}
```

You add your own facts by implementing `InfoContributor`:

```java
@Component
public class BuildDetailsInfoContributor implements InfoContributor {
    @Override
    public void contribute(Info.Builder builder) {
        builder.withDetail("demo", Map.of(
                "name", "Ultimate Spring Boot Actuator demo",
                "team", "Platform Engineering",
                "docs", "https://docs.spring.io/spring-boot/reference/actuator/index.html"));
    }
}
```

Everything merges into one response:

```json
{
  "app": {
    "name": "ultimate-actuator-sb4",
    "description": "An in-depth tour of Spring Boot 4 Actuator",
    "environment": "local"
  },
  "build": {
    "artifact": "spring-boot-4-actuator",
    "version": "0.0.1-SNAPSHOT",
    "group": "com.example",
    "time": "2026-06-26T00:33:30.579Z"
  },
  "java": {
    "version": "25",
    "vendor": { "name": "Eclipse Adoptium" },
    "runtime": { "name": "OpenJDK Runtime Environment", "version": "25+36-LTS" }
  },
  "os": { "name": "Mac OS X", "arch": "aarch64", "version": "26.5.1" },
  "demo": {
    "name": "Ultimate Spring Boot Actuator demo",
    "team": "Platform Engineering"
  }
}
```

`info` is public in the demo (it's safe and useful for "which version is deployed?" dashboards), but the `git` contributor in particular can leak more than you'd like — `mode: full` includes commit messages and branch names. Use `mode: simple` if that bothers you.

## Metrics and Prometheus

Actuator's metrics are **Micrometer** — a vendor-neutral facade over the actual monitoring system (Prometheus, Datadog, CloudWatch, …). You instrument with Micrometer's API; the registry on your classpath decides where the numbers go. The demo uses the Prometheus registry.

### What You Get for Free

Just by having Actuator + a web app + JPA + a cache, you get dozens of meters with zero code: JVM memory and GC, thread states, class loading, `http.server.requests` timers, HikariCP connection-pool gauges, JDBC connection stats, cache hit/miss counters, and executor pool stats. `GET /actuator/metrics` lists them all:

```json
{
  "names": [
    "application.ready.time", "cache.gets", "cache.puts", "disk.free",
    "hikaricp.connections.active", "http.server.requests", "jvm.memory.used",
    "jvm.gc.pause", "executor.active", "widgets.created", "widgets.total", ...
  ]
}
```

Drill into any meter to see its dimensions and current measurements:

```bash
curl localhost:8080/actuator/metrics/http.server.requests
```

```json
{
  "availableTags": [
    { "tag": "method", "values": ["POST", "DELETE", "GET"] },
    { "tag": "uri",    "values": ["/api/widgets/{id}", "/api/greeting", ...] },
    { "tag": "status", "values": ["200", "404", "500"] }
  ]
}
```

### Custom Metrics — Four Ways

There are four idioms for adding your own metrics, and they each have a sweet spot.

**1. A hand-rolled counter** — the imperative style. Build it once, increment it where things happen:

```java
this.widgetsCreatedCounter = Counter.builder("widgets.created")
        .description("Total number of widgets created since startup")
        .baseUnit("widgets")
        .tag("source", "service")
        .register(meterRegistry);
// ...later...
widgetsCreatedCounter.increment();
```

**2. A `MeterBinder`** — the idiomatic way to register a **gauge** that reflects live application state. Spring Boot calls `bindTo` for every registry, so the same gauge is correctly published everywhere:

```java
@Component
public class BusinessMetrics implements MeterBinder {
    private final WidgetService widgetService;
    // constructor...

    @Override
    public void bindTo(MeterRegistry registry) {
        Gauge.builder("widgets.total", widgetService, WidgetService::count)
                .description("Current number of widgets stored in the database")
                .baseUnit("widgets")
                .register(registry);
    }
}
```

A gauge samples a value on demand (here, a `COUNT(*)`), so it always reflects the current state rather than a running total. Use a `MeterBinder` rather than capturing a registry in random beans — it's the supported lifecycle hook.

**3. Declarative annotations** — `@Timed`, `@Counted`, `@Observed`. The least code, backed by AOP aspects:

```java
@Timed(value = "widgets.list", description = "Time spent listing all widgets", histogram = true)
@Observed(name = "widget.list")
public List<Widget> findAll() { ... }

@Counted(value = "widgets.create.attempts", description = "Number of create-widget invocations")
public Widget create(String name, String color) { ... }
```

These only work if the corresponding aspect beans exist. That's the job of the AOP dependency from setup, plus three one-line beans:

```java
@Bean TimedAspect timedAspect(MeterRegistry r) { return new TimedAspect(r); }
@Bean CountedAspect countedAspect(MeterRegistry r) { return new CountedAspect(r); }
@Bean ObservedAspect observedAspect(ObservationRegistry r) { return new ObservedAspect(r); }
```

**4. `@Observed`** deserves its own mention because it produces **both a metric and a distributed-trace span** from a single annotation, via Micrometer's Observation API. One annotation, two signals — this is the modern, preferred way to instrument a meaningful operation. More on the trace half in the [observability](#observability-tracing-prometheus-grafana) section.

### Shaping Metrics: Common Tags and Filters

Two registry-level tools let you control what every meter looks like before it's exported.

A `MeterRegistryCustomizer` adds **common tags** to every single metric — perfect for stamping the application name, region, or instance:

```java
// Spring Boot 4: org.springframework.boot.micrometer.metrics.autoconfigure.MeterRegistryCustomizer
// Spring Boot 3: org.springframework.boot.actuate.autoconfigure.metrics.MeterRegistryCustomizer
@Bean
public MeterRegistryCustomizer<MeterRegistry> commonTags() {
    return registry -> registry.config().commonTags(
            "application", "ultimate-actuator",
            "spring.boot.version", "4");
}
```

A `MeterFilter` post-processes meters — capping tag cardinality, renaming, or (as here) attaching client-side percentiles and a histogram to the HTTP timer so you can compute accurate latency quantiles in Prometheus:

```java
@Bean
public MeterFilter httpRequestsMeterFilter() {
    return new MeterFilter() {
        @Override
        public DistributionStatisticConfig configure(Meter.Id id, DistributionStatisticConfig config) {
            if (id.getName().startsWith("http.server.requests")) {
                return DistributionStatisticConfig.builder()
                        .percentiles(0.5, 0.95, 0.99)
                        .percentilesHistogram(true)
                        .build()
                        .merge(config);
            }
            return config;
        }
    };
}
```

`MeterFilter` is also your defence against **cardinality explosions** — the classic way to blow up a Prometheus server is a tag whose value is a user id or a raw URL. Filters can deny or transform those before they ever reach the registry.

### The Prometheus Endpoint

With `micrometer-registry-prometheus` on the classpath and the endpoint exposed, `/actuator/prometheus` serves the scrape format — every meter, rendered with your common tags baked in:

```text
# HELP cache_gets_total The number of times cache lookup methods have returned a cached (hit) or uncached (miss) value.
# TYPE cache_gets_total counter
cache_gets_total{application="ultimate-actuator",cache="widgets",result="hit",spring_boot_version="4"} 0.0
cache_gets_total{application="ultimate-actuator",cache="widgets",result="miss",spring_boot_version="4"} 3.0
# HELP widgets_created_total Total number of widgets created since startup
# TYPE widgets_created_total counter
widgets_created_total{application="ultimate-actuator",source="service",spring_boot_version="4"} 0.0
```

Point Prometheus at it on a 5–15s interval and you have time-series for everything. The demo ships a Prometheus + Grafana stack to scrape it (see [observability](#observability-tracing-prometheus-grafana)).

## Diagnostic Endpoints

These endpoints answer "what is my application actually doing?" — invaluable when something is misconfigured and you can't reproduce it locally.

### `env` and `configprops` — and Sanitization

`env` dumps every property source (system properties, environment variables, `application.yml`, command-line args) in resolution order. `configprops` shows your `@ConfigurationProperties` beans with their bound values and the origin of each.

Both **sanitize sensitive values** by default — anything that looks like a password, key, token, or secret is masked. The demo defines a deliberately sensitive property to prove it:

```java
@ConfigurationProperties(prefix = "demo")
public record DemoProperties(String greeting, boolean featureX, String apiKey) { }
```

```yaml
demo:
  greeting: "Hello from the Ultimate Actuator demo!"
  feature-x: true
  api-key: "super-secret-value-that-configprops-will-sanitize"
```

By default `apiKey` comes back as `"******"`. You can unmask for trusted callers only:

```yaml
management:
  endpoint:
    env: { show-values: when_authorized }
    configprops: { show-values: when_authorized }
```

Now an authenticated admin sees the real value and anonymous callers still see the mask. The `configprops` response also tells you exactly which file and line each value came from — `"origin": "class path resource [application.yml] - 46:17"` — which is gold when you're chasing "where is this value being set?".

### `beans`, `conditions`, `mappings`

- **`beans`** lists every Spring bean, its type, scope, and dependencies. Useful for "is this bean even in the context, and what got injected into it?"
- **`conditions`** is the auto-configuration report: every conditional configuration class, and _why_ it did or didn't apply. This is the endpoint to hit when you're asking "why isn't Spring Boot auto-configuring X?" — it'll tell you the exact condition that failed.
- **`mappings`** lists every request mapping — controller routes, actuator endpoints, servlet filters. The fastest way to confirm a URL is actually wired to what you think it is.

### `startup`

The `startup` endpoint reports detailed timings for every step of application start-up — fantastic for diagnosing slow boots. It needs a small opt-in: a `BufferingApplicationStartup` set on the `SpringApplication` before it runs, because the timings have to be captured _from the very beginning_:

```java
public static void main(String[] args) {
    SpringApplication application = new SpringApplication(UltimateActuatorApplication.class);
    application.setApplicationStartup(new BufferingApplicationStartup(2048)); // retain up to 2048 events
    application.run(args);
}
```

```json
{
  "springBootVersion": "4.0.6",
  "timeline": {
    "events": [
      {
        "startupStep": {
          "name": "spring.boot.application.environment-prepared"
        },
        "duration": "PT0.077S"
      },
      {
        "startupStep": { "name": "spring.boot.application.context-prepared" },
        "duration": "PT0.0008S"
      }
    ]
  }
}
```

Sort the timeline by `duration` and the slow steps jump right out.

### `threaddump` and `heapdump`

- **`threaddump`** returns a full JVM thread dump as JSON — every thread, its state, and stack. This is your first stop for a hung or pegged process: hit it twice a few seconds apart and compare. (There's a `text/plain` variant via the `Accept` header for feeding into traditional thread-dump analyzers.)
- **`heapdump`** streams a binary heap dump file (`.hprof`) you can open in Eclipse MAT or VisualVM. It's a real heap dump of a live process, so it's large and pauses the JVM briefly — treat it as a break-glass tool, never something you scrape on a schedule.

Both are powerful and both leak everything in memory. They must be **locked down** — never anonymously exposed.

## Operational Endpoints

These endpoints _do_ things — they change runtime behaviour or surface live operational state.

### `loggers` — Change Log Levels Without a Redeploy

This is the endpoint that earns Actuator its keep on a bad day. You can read and **change** any logger's level at runtime, no restart:

```bash
# Read one logger
curl localhost:8080/actuator/loggers/com.example.actuator
# {"configuredLevel":"INFO","effectiveLevel":"INFO"}

# Crank it to DEBUG to investigate a live issue — returns 204, takes effect immediately
curl -X POST localhost:8080/actuator/loggers/com.example.actuator \
     -H 'Content-Type: application/json' -d '{"configuredLevel":"DEBUG"}'
```

Because changing a level is a **write operation**, in Spring Boot 4 the `loggers` endpoint must be granted `access: unrestricted` (recall the global default is `read-only`). Turn the level back to `null`/`INFO` when you're done, and you've debugged a production issue without a single deploy.

### `caches`

With `@EnableCaching` and a `CacheManager`, the `caches` endpoint lists every cache and its manager. The detail that makes cache _metrics_ meaningful is `recordStats()` on the cache itself:

```java
@Bean
public CaffeineCacheManager cacheManager() {
    CaffeineCacheManager cacheManager = new CaffeineCacheManager("widgets");
    cacheManager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(500)
            .expireAfterWrite(5, TimeUnit.MINUTES)
            .recordStats());   // <-- this is what feeds cache.gets/cache.puts metrics
    return cacheManager;
}
```

The `@Cacheable`/`@CacheEvict` annotations in `WidgetService` drive real hit/miss numbers you saw in the Prometheus output above.

### `scheduledtasks`

Any `@Scheduled` method shows up here, grouped by trigger type (`cron`, `fixedRate`, `fixedDelay`), with the target method and — for cron and fixed-rate — the **next execution time** and the **last execution status**:

```json
{
  "cron": [
    {
      "expression": "0 0 3 * * *",
      "runnable": { "target": "...ScheduledMaintenanceTasks.nightlyCleanup" },
      "nextExecution": { "time": "2026-06-26T03:00:00Z" }
    }
  ],
  "fixedRate": [
    {
      "interval": 60000,
      "runnable": { "target": "...ScheduledMaintenanceTasks.heartbeat" },
      "lastExecution": { "status": "SUCCESS", "time": "2026-06-26T00:33:33Z" },
      "nextExecution": { "time": "2026-06-26T00:34:33Z" }
    }
  ]
}
```

Instant answer to "is my nightly job actually scheduled, and when does it run next?".

### `flyway`

When Flyway is on the classpath, the `flyway` endpoint lists every applied migration — version, description, checksum, install time, and execution duration — straight from Flyway's schema-history table. It's the quickest way to confirm which migrations a given instance has actually run against its database. (There's a `liquibase` equivalent if you use Liquibase.)

### `httpexchanges`

Records the last _N_ HTTP request/response exchanges — method, URI, headers, status, timing. Unlike most endpoints, this one **requires you to opt in by registering a repository bean**; without it the endpoint reports nothing, by design, because keeping request history in memory is a deliberate choice:

```java
@Bean
public HttpExchangeRepository httpExchangeRepository() {
    InMemoryHttpExchangeRepository repository = new InMemoryHttpExchangeRepository();
    repository.setCapacity(100);
    return repository;
}
```

```json
{
  "exchanges": [
    {
      "timestamp": "2026-06-26T00:34:01.778Z",
      "request": {
        "method": "GET",
        "uri": "http://localhost:8080/actuator/heapdump",
        "headers": { "User-Agent": ["curl/8.7.1"] }
      },
      "response": { "status": 200 }
    }
  ]
}
```

You control which headers are recorded (`management.httpexchanges.recording.include`). It's a lightweight, dependency-free request log — handy in environments where you don't have a full APM.

### `auditevents`

Spring Boot's audit framework records security-relevant events. Spring Security automatically publishes authentication success/failure and authorization-failure events; you can publish your own. Like `httpexchanges`, it needs a repository bean:

```java
@Bean
public AuditEventRepository auditEventRepository() {
    return new InMemoryAuditEventRepository(200);
}
```

The demo's `WidgetService` emits custom `WIDGET_CREATED` / `WIDGET_DELETED` events:

```java
private void publishAuditEvent(String type, Map<String, Object> data) {
    String principal = /* current user or "anonymous" */;
    eventPublisher.publishEvent(new AuditApplicationEvent(new AuditEvent(principal, type, data)));
}
```

Those land in `/actuator/auditevents` alongside Spring Security's own events:

```json
{
  "events": [
    {
      "type": "AUTHORIZATION_FAILURE",
      "principal": "anonymousUser",
      "data": { "details": { "remoteAddress": "127.0.0.1" } },
      "timestamp": "..."
    },
    {
      "type": "WIDGET_CREATED",
      "principal": "admin",
      "data": { "id": 7, "name": "Flux Capacitor" },
      "timestamp": "..."
    }
  ]
}
```

A separate `@EventListener` on `AuditApplicationEvent` logs each one too — a nice pattern for shipping audit events to a SIEM in addition to keeping them queryable.

### `sbom`

Newer Boot versions expose a **Software Bill of Materials** — increasingly a compliance and supply-chain-security requirement. The CycloneDX Gradle plugin generates the SBOM, Spring Boot's plugin embeds it in the jar at `META-INF/sbom/application.cdx.json`, and the `sbom` endpoint serves it with **zero extra configuration**:

```kotlin
plugins {
    // Spring Boot 3.5 integrates with the CycloneDX 2.x plugin API
    // Spring Boot 4.0 integrates with the CycloneDX 3.x plugin API
    id("org.cyclonedx.bom") version "3.2.4"
}
```

```bash
curl localhost:8080/actuator/sbom              # -> {"ids":["application"]}
curl localhost:8080/actuator/sbom/application  # -> the full CycloneDX document
```

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "metadata": { "component": { "name": "spring-boot-4-actuator", "version": "0.0.1-SNAPSHOT" } },
  "components": [ { "type": "library", "name": "caffeine", "version": "..." }, ... ]
}
```

> When running via `bootRun` you may need to generate the SBOM first (`./gradlew cyclonedxBom`); a packaged `bootJar` always contains it.

### `shutdown`

The `shutdown` endpoint gracefully stops the application on `POST`. It's a **write operation** and is `OFF` by default for obvious reasons. To enable it in Boot 4:

```yaml
management:
  endpoint:
    shutdown:
      access: unrestricted # Spring Boot 3: management.endpoint.shutdown.enabled: true
```

If you enable it, **secure it ruthlessly** — an unauthenticated `shutdown` endpoint is a one-request denial-of-service. In most modern deployments you don't need it at all; the orchestrator's SIGTERM handling does graceful shutdown for you.

## Building Custom Endpoints

Here's where Actuator goes from "useful built-ins" to "extensible platform". You can define your own management endpoints with full read/write/delete semantics, and they ride on all the same infrastructure — exposure, access control, security, JMX.

### A Technology-Agnostic `@Endpoint`

`@Endpoint` defines an endpoint available over **both HTTP and JMX**. Operations are declared with `@ReadOperation` (GET), `@WriteOperation` (POST), and `@DeleteOperation` (DELETE); a `@Selector` binds a path segment to a parameter. The demo implements a feature-flag store:

```java
@Component
@Endpoint(id = "featureflags")
public class FeatureFlagsEndpoint {

    private final Map<String, Boolean> flags = new ConcurrentHashMap<>(Map.of(
            "new-checkout", false, "beta-search", true));

    @ReadOperation                                   // GET /actuator/featureflags
    public Map<String, Boolean> allFlags() {
        return Collections.unmodifiableMap(flags);
    }

    @ReadOperation                                   // GET /actuator/featureflags/{name}
    public Map<String, Object> flag(@Selector String name) {
        return Map.of("name", name, "enabled", flags.getOrDefault(name, false));
    }

    @WriteOperation                                  // POST /actuator/featureflags/{name}  body: {"enabled": true}
    public Map<String, Object> setFlag(@Selector String name, boolean enabled) {
        flags.put(name, enabled);
        return Map.of("name", name, "enabled", enabled);
    }

    @DeleteOperation                                 // DELETE /actuator/featureflags/{name}
    public void removeFlag(@Selector String name) {
        flags.remove(name);
    }
}
```

The read operations work immediately:

```bash
curl localhost:8080/actuator/featureflags             # {"beta-search":true,"new-checkout":false}
curl localhost:8080/actuator/featureflags/beta-search # {"enabled":true,"name":"beta-search"}
```

### The Access-Model Gotcha (Spring Boot 4)

Now try the write operation against the Spring Boot 4 app and watch it fail:

```bash
curl -X POST localhost:8080/actuator/featureflags/new-checkout \
     -H 'Content-Type: application/json' -d '{"enabled":true}'
```

```json
{
  "status": 405,
  "error": "Method Not Allowed",
  "message": "Method 'POST' is not supported."
}
```

A `405`, not a `403`. This is the global `management.endpoints.access.default: read-only` doing exactly what it's configured to do: **read operations are exposed, write/delete operations are not.** Spring Boot doesn't even register the POST/DELETE routes, so you get "method not supported" rather than an auth error. The fix is to grant the endpoint write access explicitly:

```yaml
management:
  endpoint:
    featureflags:
      access: unrestricted # now POST and DELETE are wired up
```

In Spring Boot 3 (no `access.default`) the same write/delete operations work out of the box. This is precisely the kind of surprise that makes the [migration section](#spring-boot-3--4-what-actually-changed) worth reading — your custom mutating endpoints can silently go read-only on the way to Boot 4.

### A Web-Only `@WebEndpoint`

When an endpoint is inherently web-shaped and you don't want it on the JMX surface, use `@WebEndpoint` instead of `@Endpoint`:

```java
@Component
@WebEndpoint(id = "releasenotes")
public class ReleaseNotesWebEndpoint {
    @ReadOperation
    public Map<String, Object> releaseNotes() {
        return Map.of("current", "1.4.0", "highlights", List.of(
                "Added the /actuator/featureflags custom endpoint",
                "Wired Prometheus + OpenTelemetry tracing"));
    }
}
```

There are matching `@JmxEndpoint` and `@ServletEndpoint` variants for the inverse cases.

### Extending an Existing Endpoint with `@EndpointWebExtension`

An **endpoint web extension** layers technology-specific behaviour onto an existing endpoint without modifying it. The demo wraps the feature-flags read in a `WebEndpointResponse` so that querying an unknown flag returns a proper HTTP `404` instead of a misleading `{"enabled": false}`:

```java
@Component
@EndpointWebExtension(endpoint = FeatureFlagsEndpoint.class)
public class FeatureFlagsWebExtension {

    private final FeatureFlagsEndpoint delegate;
    // constructor...

    @ReadOperation
    public WebEndpointResponse<Map<String, Object>> flagWithHttpStatus(@Selector String name) {
        Map<String, Object> result = delegate.flag(name);
        boolean known = delegate.allFlags().containsKey(name);
        int status = known ? WebEndpointResponse.STATUS_OK : WebEndpointResponse.STATUS_NOT_FOUND;
        return new WebEndpointResponse<>(result, status);
    }
}
```

This is the supported way to give an endpoint HTTP-specific semantics (status codes, content negotiation) while keeping the core endpoint technology-agnostic.

## Securing the Management Surface

Exposing endpoints makes them routable; it does **not** make them safe. `beans`, `env`, `configprops`, `heapdump`, `threaddump`, and `loggers` all leak information or accept mutations. The correct posture is: **`health` and `info` public, everything else authenticated.**

The key tool is `EndpointRequest` — a Spring Security request matcher that understands the actuator base path, so you never hard-code `/actuator/**` (and it keeps working if you remap the base path):

```java
// Spring Boot 4 import paths shown; see the migration table for the Boot 3 packages.
import org.springframework.boot.security.autoconfigure.actuate.web.servlet.EndpointRequest;
import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.actuate.info.InfoEndpoint;

@Configuration
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                // health + info are safe to expose unauthenticated
                .requestMatchers(EndpointRequest.to(HealthEndpoint.class, InfoEndpoint.class)).permitAll()
                // every other actuator endpoint requires the admin role
                .requestMatchers(EndpointRequest.toAnyEndpoint()).hasRole("ACTUATOR_ADMIN")
                .requestMatchers("/api/**").permitAll()
                .anyRequest().permitAll())
            .httpBasic(httpBasic -> {});
        return http.build();
    }

    @Bean
    public InMemoryUserDetailsManager userDetailsManager() {
        UserDetails admin = User.withDefaultPasswordEncoder()
                .username("admin").password("admin").roles("ACTUATOR_ADMIN").build();
        return new InMemoryUserDetailsManager(admin);
    }
}
```

`EndpointRequest.toAnyEndpoint()` matches all actuator endpoints; `EndpointRequest.to(...)` matches specific ones. Because the matcher is base-path-aware, this config survives a `base-path` or `path-mapping` change without edits. (In-memory users and basic auth are demo conveniences — use real authentication and a proper `PasswordEncoder` in production.)

A defence-in-depth pattern many teams add: run the management endpoints on a **separate port** (`management.server.port`) bound to an internal network, so the actuator surface isn't reachable from the public internet at all.

## Observability: Tracing, Prometheus, Grafana

Metrics tell you _that_ something is slow; **traces** tell you _where_. Actuator integrates with Micrometer Tracing, which bridges to OpenTelemetry and exports over OTLP.

The wiring is two dependencies and a little config:

```kotlin
implementation("io.micrometer:micrometer-tracing-bridge-otel")
implementation("io.opentelemetry:opentelemetry-exporter-otlp")
```

```yaml
management:
  tracing:
    sampling:
      probability: 1.0 # sample everything in the demo; lower this in prod
  otlp:
    tracing:
      endpoint: http://localhost:4318/v1/traces # Tempo / Jaeger / OTel Collector
  observations:
    annotations:
      enabled: true # turns @Observed into spans + metrics

logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"
```

That last `logging.pattern.level` is the unsung hero: it prefixes every log line with the `traceId` and `spanId`, so a log line and the distributed trace it belongs to are correlated. Click a slow trace in Grafana, copy its trace id, grep your logs — and you're looking at exactly the right lines.

Recall the `@Observed` annotation from the metrics section: each `@Observed` method becomes a span automatically, so a request through `GreetingController` → `WidgetService` produces a parent span with child spans, no manual instrumentation. One annotation, a metric and a trace.

The demo includes a full `docker compose` stack to make this real:

```yaml
services:
  postgres: # backs db/flyway health + JPA metrics            -> :5432
  prometheus: # scrapes /actuator/prometheus                     -> :9090
  tempo: # receives OTLP traces (OTLP http on :4318)        -> :3200
  grafana: # dashboards over Prometheus + Tempo               -> :3000
```

`docker compose up -d`, run the app, generate some traffic with the bundled `generate-traffic.sh`, and you'll see metrics in Prometheus and traces flowing into Tempo, all linkable from Grafana.

## Testing the Actuator Surface

Actuator endpoints are part of your contract — a probe path that 404s or a secured endpoint that's accidentally public is a production incident. They're worth a test. The demo spins up a real Postgres with Testcontainers and asserts a representative slice of the surface with MockMvc:

```java
@SpringBootTest
@Testcontainers
class ActuatorEndpointsIntegrationTest {

    @Container
    static PostgreSQLContainer postgres = new PostgreSQLContainer("postgres:17")
            .withDatabaseName("actuator").withUsername("actuator").withPassword("actuator");

    @DynamicPropertySource
    static void datasourceProps(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    MockMvc mockMvc;

    @BeforeEach
    void setUpMockMvc(WebApplicationContext context) {
        // Spring Boot 4: apply the springSecurity() configurer explicitly so
        // @WithMockUser is honored; otherwise secured endpoints return 401.
        mockMvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();
    }

    @Test
    void healthEndpointIsPublicAndUp() throws Exception {
        mockMvc.perform(get("/actuator/healthz"))
               .andExpect(status().isOk())
               .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void securedEndpointRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/actuator/env")).andExpect(status().isUnauthorized());
    }

    @Test
    @WithMockUser(roles = "ACTUATOR_ADMIN")
    void customFeatureFlagsEndpointResponds() throws Exception {
        mockMvc.perform(get("/actuator/featureflags"))
               .andExpect(status().isOk())
               .andExpect(jsonPath("$['beta-search']").value(true));
    }
}
```

Two Spring Boot 4 specifics worth flagging, because both cost real debugging time:

- **The MockMvc test slice moved.** `@AutoConfigureMockMvc` / `@WebMvcTest` now require `spring-boot-starter-webmvc-test` (Boot 4 split the test slices into their own starters).
- **Security MockMvc auto-config was dropped.** In Boot 4 you must apply `.apply(springSecurity())` yourself; without it, requests reach the filter chain as anonymous and `@WithMockUser` is ignored, so your "authenticated" tests get surprise `401`s.

The test asserts the three things that actually matter: the public probe works, secured endpoints reject anonymous access, and the custom endpoint responds for an admin.

## Spring Boot 3 → 4: What Actually Changed

Porting the identical app from Spring Boot 3.5 to 4.0 surfaced a tidy, copy-pasteable set of actuator-relevant differences. Here they are in one place.

### 1. The endpoint access model replaces `enabled`

The per-endpoint `management.endpoint.<id>.enabled` flag (deprecated in 3.4) is **gone**, replaced by an `access` level and a global default:

```yaml
# Spring Boot 3
management.endpoint.shutdown.enabled: true

# Spring Boot 4
management.endpoints.access.default: read-only # none | read-only | unrestricted
management.endpoint.shutdown.access: unrestricted
```

The practical trap: **custom endpoints with write/delete operations silently become read-only** under the `read-only` default and return `405` until you grant them `unrestricted`. Audit every `@WriteOperation`/`@DeleteOperation` you own when migrating.

### 2. The actuator was split into modules — packages moved

Spring Boot 4 broke the monolithic actuator into finer-grained modules, which relocated several common types. The ones you'll actually hit:

| Type                                                             | Spring Boot 3                                                     | Spring Boot 4                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `HealthIndicator`, `Health`, `Status`, `AbstractHealthIndicator` | `org.springframework.boot.actuate.health`                         | `org.springframework.boot.health.contributor`                         |
| `HealthEndpoint`                                                 | `org.springframework.boot.actuate.health`                         | `org.springframework.boot.health.actuate.endpoint`                    |
| `EndpointRequest` (servlet security)                             | `org.springframework.boot.actuate.autoconfigure.security.servlet` | `org.springframework.boot.security.autoconfigure.actuate.web.servlet` |
| `MeterRegistryCustomizer`                                        | `org.springframework.boot.actuate.autoconfigure.metrics`          | `org.springframework.boot.micrometer.metrics.autoconfigure`           |
| `@AutoConfigureMockMvc`                                          | `org.springframework.boot.test.autoconfigure.web.servlet`         | `org.springframework.boot.webmvc.test.autoconfigure`                  |

`HealthIndicator` still works the same way — it now extends a new `HealthContributor` interface, but existing implementations are source-compatible once the imports are updated. The endpoint annotations (`@Endpoint`, `@ReadOperation`, `@Selector`, …), `InfoContributor`/`Info`, the audit types, and the `httpexchanges` types **kept their packages**.

### 3. Build and dependency changes

- **`spring-boot-starter-aop` was removed** → use `org.springframework:spring-aspects` (brings `spring-aop` + `aspectjweaver`) for the Micrometer aspects.
- **MockMvc test slice** now requires `spring-boot-starter-webmvc-test`.
- **Security MockMvc auto-config dropped** → apply `.apply(springSecurity())` explicitly in tests.
- **Testcontainers 2.x**: renamed artifacts (`testcontainers-junit-jupiter`, `testcontainers-postgresql`) and a non-generic `PostgreSQLContainer` now in `org.testcontainers.postgresql`.
- **CycloneDX SBOM**: Boot 3.5 integrates with the CycloneDX Gradle plugin **2.x** API; Boot 4 integrates with the **3.x** API. Both auto-embed the SBOM at `META-INF/sbom/application.cdx.json` for the `sbom` endpoint.
- **New baselines**: Java 17+, Spring Framework 7, Jackson 3.

The cleanest way to see all of this is to diff the two demo projects file-for-file — each Boot 4-specific change carries an inline comment explaining the difference.

## Production Checklist

Actuator is safe and powerful _if_ you configure it deliberately. The defaults that ship are demo-friendly, not production-ready. Before you deploy:

- [ ] **Expose only what you need.** Replace `include: "*"` with an explicit list — typically `health, info, prometheus, metrics`. Everything else can stay unexposed.
- [ ] **Secure everything except `health`/`info`.** Use `EndpointRequest` so the policy survives path changes. Assume anything exposed is reachable.
- [ ] **Keep `access.default: read-only`** (Boot 4) and grant `unrestricted` only where you truly need a write op.
- [ ] **Lock down `heapdump`, `threaddump`, `env`, `configprops`, `beans`** — these leak secrets and internals.
- [ ] **Don't enable `shutdown`** unless you have a concrete reason and ironclad auth in front of it.
- [ ] **Use `show-details: when_authorized`** for health, and `show-values: when_authorized` for `env`/`configprops`.
- [ ] **Consider a separate management port** on an internal-only interface.
- [ ] **Split liveness vs readiness correctly** — a down dependency means _not ready_, not _not alive_.
- [ ] **Watch metric cardinality.** A `MeterFilter` is your guard against a tag that accidentally carries user ids or raw URLs.
- [ ] **Mind the tracing sample rate.** `1.0` is for demos; sample a fraction in production.

## Quick Reference

### Built-in endpoints

| Endpoint                            | What it gives you                             | Notes                                           |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `health`                            | Aggregated status + components                | Groups, probes, custom statuses, `show-details` |
| `info`                              | Build/git/java/os + custom facts              | `InfoContributor`, `buildInfo()`                |
| `metrics`                           | Micrometer meter names + dimensions           | Drill down per meter                            |
| `prometheus`                        | Prometheus scrape format                      | Needs `micrometer-registry-prometheus`          |
| `env` / `configprops`               | Property sources & `@ConfigurationProperties` | Sanitized; `show-values: when_authorized`       |
| `beans` / `conditions` / `mappings` | Bean graph, auto-config report, routes        | Diagnostics                                     |
| `loggers`                           | View/change log levels at runtime             | Write op → needs `unrestricted` (Boot 4)        |
| `threaddump` / `heapdump`           | Live JVM thread/heap state                    | Lock down hard                                  |
| `startup`                           | Start-up step timings                         | Needs `BufferingApplicationStartup`             |
| `caches`                            | Cache managers & names                        | `recordStats()` enables metrics                 |
| `scheduledtasks`                    | `@Scheduled` tasks + next run                 | Per trigger type                                |
| `flyway` / `liquibase`              | Applied DB migrations                         | Auto when on classpath                          |
| `httpexchanges`                     | Recent request/response history               | Opt-in `HttpExchangeRepository` bean            |
| `auditevents`                       | Security + custom audit events                | Opt-in `AuditEventRepository` bean              |
| `sbom`                              | CycloneDX Software Bill of Materials          | CycloneDX plugin                                |
| `shutdown`                          | Graceful shutdown                             | Off by default; secure it                       |

### Extension points

| To do this                        | Implement / annotate                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Add a health component            | `HealthIndicator` or `AbstractHealthIndicator`                                  |
| Add a custom health status        | `new Status("DEGRADED", ...)` + `status.http-mapping` / `order`                 |
| Add facts to `/info`              | `InfoContributor`                                                               |
| Register a live gauge             | `MeterBinder`                                                                   |
| Declarative metrics               | `@Timed`, `@Counted` + their aspect beans                                       |
| Metric + trace in one             | `@Observed` + `ObservedAspect`                                                  |
| Tag every metric                  | `MeterRegistryCustomizer` (common tags)                                         |
| Shape/cap metrics                 | `MeterFilter`                                                                   |
| A custom endpoint (HTTP + JMX)    | `@Endpoint` + `@ReadOperation`/`@WriteOperation`/`@DeleteOperation`/`@Selector` |
| A web-only endpoint               | `@WebEndpoint`                                                                  |
| Add HTTP behaviour to an endpoint | `@EndpointWebExtension`                                                         |
| Secure the surface                | `EndpointRequest.to(...)` / `.toAnyEndpoint()`                                  |

### Essential config

```yaml
management:
  endpoints:
    access:
      default: read-only # Boot 4 global default
    web:
      exposure:
        include: health,info,prometheus,metrics # be explicit in prod
  endpoint:
    health:
      show-details: when_authorized
      probes:
        enabled: true
    loggers:
      access: unrestricted # to change levels at runtime
    env:
      show-values: when_authorized
```

## Wrapping Up

Spring Boot Actuator is the rare feature that's both ubiquitous and underused. The cost of going beyond `/health` is small — a few config keys and a handful of tiny beans — and the payoff is enormous: runtime log-level changes mid-incident, accurate liveness/readiness probes, first-class metrics and traces, a queryable audit trail, an SBOM for compliance, and the ability to build your own management endpoints that ride on the same secured, exposable infrastructure.

The two demo projects — Spring Boot 3.5 and Spring Boot 4.0, deliberately identical so the diffs are pure signal — are at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/ultimate-actuator). Each one ships `docker compose` infrastructure, a `generate-traffic.sh` to populate the metrics/caches/audit endpoints, and a `test-actuator.sh` that hits every endpoint and prints the response — the fastest way to see the whole surface at once.

If you found this useful, the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/), the [Spring Modulith guide](/posts/ultimate-guide-spring-modulith/), and the [Spring Batch 6 guide](/posts/ultimate-guide-spring-batch-6/) follow this same format for those topics.
