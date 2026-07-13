---
author: StevenPG
pubDatetime: 2026-07-22T12:00:00.000Z
title: Ultimate Guide to Testcontainers with Spring Boot
slug: ultimate-guide-testcontainers-spring-boot
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - testing
  - testcontainers
description: Everything Testcontainers with Spring Boot — @ServiceConnection, Postgres with real migrations, Kafka flows, WireMock for external APIs, container reuse timings, and running your app locally against containers with bootTestRun.
---

# Ultimate Guide to Testcontainers with Spring Boot

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Testcontainers shows up in half the demo repos I publish — the [UUIDv7 benchmark](/posts/uuidv7-in-spring-boot-and-postgres), the [search latency tests](/posts/postgres-full-text-search-vs-elasticsearch), the [rate limiter's Redis tests](/posts/rate-limiting-spring-boot-bucket4j-redis) — and I've never given it the full guide it deserves. This is that guide.

The premise of Testcontainers is one sentence: **your tests start real infrastructure in Docker containers and throw it away afterwards.** Real Postgres instead of H2, real Kafka instead of mocks, a real HTTP server standing in for the API you don't control. The demo app for this post (shipments: Postgres + Flyway + a Kafka listener + an external carrier API) lives at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/testcontainers-ultimate-guide).

## Why H2 Was Always a Trap

The old compromise was an in-memory database for tests. The problem: you ship on Postgres and test on something that merely resembles it. Everything interesting lives in the difference — `tsvector` columns, `INTERVAL` arithmetic, sequence behavior, transaction isolation quirks, and whether your Flyway migrations _actually run_ on the engine you deploy to. Every one of those is a bug class H2 waves through and a real Postgres catches at test time.

Testcontainers ends the compromise: the test dependency is Docker, and the database is the exact image production runs — `postgres:18`, not "mostly SQL."

## The Modern Setup: @ServiceConnection

Spring Boot 3.1 collapsed what used to be a page of `@DynamicPropertySource` boilerplate into an annotation. Here's the whole wiring for Postgres _and_ Kafka in the demo:

```java
@TestConfiguration(proxyBeanMethods = false)
public class ContainersConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgres() {
        return new PostgreSQLContainer<>("postgres:18")
                .withReuse(true);
    }

    @Bean
    @ServiceConnection
    KafkaContainer kafka() {
        return new KafkaContainer("apache/kafka-native:3.9.0")
                .withReuse(true);
    }
}
```

`@ServiceConnection` looks at the container type and configures the matching Spring properties itself — JDBC URL and credentials for Postgres, bootstrap servers for Kafka. No property names to remember, no ports to plumb. Tests opt in with a single import:

```java
@SpringBootTest
@Import(ContainersConfig.class)
class ShipmentPersistenceTest {

    @Autowired
    ShipmentRepository repository;

    @Test
    void uniqueConstraintFromFlywayMigrationIsEnforced() {
        repository.saveAndFlush(new Shipment("TRACK-DUP", "CREATED"));

        assertThrows(DataIntegrityViolationException.class,
                () -> repository.saveAndFlush(new Shipment("TRACK-DUP", "CREATED")));
    }
}
```

Notice what that test is really checking: that the `UNIQUE` constraint **defined in a Flyway migration** exists and fires. The migration ran against real Postgres 18 during context startup. Schema drift between your migrations and your entities gets caught here, in the suite, not during a deploy.

(Two Kafka notes for anyone with older examples: the modern container is `org.testcontainers.kafka.KafkaContainer` running the official `apache/kafka` images — the old `org.testcontainers.containers.KafkaContainer` wrapped Confluent images and is deprecated. And `apache/kafka-native` boots in about a second, which changes how casually you can afford a real broker in tests.)

## The Test Mocks Can't Give You: Async Kafka Flows

The demo's listener consumes shipment events and updates the database. That's two infrastructure hops and an async boundary — precisely the code that unit tests skip and that breaks in integration:

```java
@SpringBootTest
@Import(ContainersConfig.class)
class ShipmentEventFlowTest {

    @Autowired ShipmentRepository repository;
    @Autowired KafkaTemplate<String, String> kafkaTemplate;

    @Test
    void kafkaEventUpdatesShipmentStatus() {
        repository.save(new Shipment("TRACK-KAFKA", "CREATED"));

        kafkaTemplate.send("shipment-events", "TRACK-KAFKA:DELIVERED");

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(repository.findByTrackingNumber("TRACK-KAFKA"))
                        .isPresent().get()
                        .extracting(Shipment::getStatus)
                        .isEqualTo("DELIVERED"));
    }
}
```

Real broker, real consumer group, real partition assignment, real deserialization — and Awaitility polling instead of `Thread.sleep`, because the flow is genuinely asynchronous and a fixed sleep is either flaky or slow (usually both, alternating). This one test has caught more listener regressions in my projects than any amount of `@Mock KafkaTemplate` ever could, because `@KafkaListener` wiring itself is part of what's under test.

## Mocking the API You Don't Control: WireMock

Third-party HTTP APIs are the other integration seam. WireMock ships an official Testcontainers module, so the mock server is just another container and your app's HTTP client goes through a full real network hop:

```java
@Container
static WireMockContainer wiremock =
        new WireMockContainer("wiremock/wiremock:3.13.0")
                .withMappingFromResource("carrier-track.json");

@DynamicPropertySource
static void carrierUrl(DynamicPropertyRegistry registry) {
    registry.add("carrier.base-url", wiremock::getBaseUrl);
}
```

Stubs are plain JSON files in `src/test/resources` — reviewable, diffable contracts for what you believe the carrier's API returns. This is also the honest place to test timeouts and 500s from a dependency: tell WireMock to delay or fail, and watch what your `RestClient` configuration actually does about it. (WireMock has no `@ServiceConnection` support since it's not a Spring-managed connection type — this is the one place the classic `@DynamicPropertySource` still earns its keep.)

## The Speed Section: Reuse On vs Off

The eternal objection is "containers make my build slow." Two mechanisms deal with it.

**Within one JVM run**, the shared `ContainersConfig` beans mean containers start once per test run, not once per test class — Spring's context caching keeps the app context (and its containers) alive across all the classes that import the same config.

**Between runs**, `.withReuse(true)` plus one opt-in on your machine keeps containers alive after the JVM exits:

```bash
echo "testcontainers.reuse.enable=true" >> ~/.testcontainers.properties
```

The difference on the demo suite (three test classes: Postgres-only, Postgres+Kafka, +WireMock), timed on my machine with `./gradlew test` after a clean daemon:

|               | First run | Subsequent runs                 |
| ------------- | --------- | ------------------------------- |
| Reuse **off** | ~55 s     | ~55 s (pays startup every time) |
| Reuse **on**  | ~55 s     | ~25 s                           |

The entire saving is container startup and app-context init against fresh infrastructure; the tests themselves are the same. For local TDD loops, reuse changes Testcontainers from "run before pushing" to "run on every save." Two caveats: reused containers keep their _data_ between runs — so tests must not depend on a pristine database (unique keys per test, or clean up what you create) — and CI generally shouldn't reuse (ephemeral runners can't anyway); there, parallel test JVMs and pre-pulled images are the levers.

## The Bonus Nobody Uses: bootTestRun

Testcontainers isn't only for tests. Spring Boot 3.1+ can launch your app _for local development_ wired to containers, using the same config class:

```java
public class TestTcDemoApplication {

    public static void main(String[] args) {
        SpringApplication.from(TcDemoApplication::main)
                .with(ContainersConfig.class)
                .run(args);
    }
}
```

```bash
./gradlew bootTestRun
```

That boots the real app with Postgres and Kafka running in containers, connection properties injected — on a machine with nothing installed but Docker and a JDK. New-laptop onboarding becomes one command; there is no README section listing seven services to install first.

## Production Checklist

- Pin real version tags (`postgres:18`), never `latest` — your tests should break when _you_ choose to upgrade, not when a registry does
- One shared `@TestConfiguration` for containers; `@Import` it everywhere — accidental per-class containers are the #1 cause of slow suites
- `@ServiceConnection` for anything Spring has a connection type for; `@DynamicPropertySource` for the rest (WireMock)
- Awaitility for async assertions, never `Thread.sleep`
- Reuse on locally (with tests that tolerate leftover data), off in CI
- `bootTestRun` as your dev-mode default — it keeps the "works locally" environment honest too

## Summary

Testcontainers with modern Spring Boot is barely any code: a config class of `@ServiceConnection` beans, real images matching production, Awaitility at async boundaries, and WireMock containers for the APIs you don't own. In exchange, your suite exercises the exact seams where mocks lie — migrations, constraints, listeners, serialization, HTTP client behavior. Clone [the demo](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/testcontainers-ultimate-guide), run `./gradlew test`, and then try `bootTestRun` — the second one is the habit that sticks.

[testcontainers]: https://testcontainers.com/
[wiremock-tc]: https://wiremock.org/docs/solutions/testcontainers/
[awaitility]: http://www.awaitility.org/
