---
author: StevenPG
pubDatetime: 2026-11-19T12:00:00.000Z
title: "Spring Boot 4.1 → 4.2: What's New and What Breaks"
slug: spring-boot-4-2-whats-new-what-breaks
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - kotlin
  - migration
description: A practical Spring Boot 4.2 upgrade guide — RestTemplate deprecation and the move to RestClient/RestTestClient, HTTP QUERY, problem details for every exception, AMQP 1.0, stricter MIME parsing, relative redirects, and the breaking changes that will actually bite you coming from 4.1.
---

<!-- VERIFY AT GA: pubDatetime and filename assume GA on 2026-11-19 (the 4.2.0 / Framework 7.1.0 milestone due date on GitHub). Every claim below was checked against 4.2.0-RC2 (2026-11-05); re-read the final Spring Boot 4.2 Release Notes wiki page before flipping draft to false. -->

# Spring Boot 4.1 → 4.2: What's New and What Breaks

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This is the third post in the series: the [Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration) covered 3.x → 4.0, [Spring Boot 4.0 → 4.1](/posts/spring-boot-4-1-whats-new-what-breaks) covered the June release, and this one covers the hop from 4.1 to 4.2, released November 2026 alongside Spring Framework 7.1. <!-- VERIFY AT GA: exact release date -->

4.1 was "mostly boring." 4.2 is a little less boring. The headline isn't a shiny feature, it's a deprecation: **`RestTemplate` is formally deprecated for removal in Spring Framework 7.1**, and Boot deprecates all of its `RestTemplate` and `TestRestTemplate` support with it. Nothing gets removed yet, but every codebase I've ever worked on uses `RestTemplate` somewhere, so you're going to see warnings. Around that there are a handful of genuinely useful additions (HTTP `QUERY`, problem details for every exception, AMQP 1.0) and a longer-than-usual list of small behavior changes that will show up as failing tests.

I built the same tiny app on 4.1.2 and 4.2.0-RC2 and checked the behavior changes I could reproduce side by side. Those are called out as **verified on RC2** below. The sample app, the 4.1/4.2 baseline, and the scripts I used are all on GitHub: [DemosAndArticleContent/blog/spring-boot-4-2-whats-new-what-breaks](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-4-2-whats-new-what-breaks). Everything else comes straight from the milestone release notes and the Spring Framework 7.1 release notes.

If you're still on 4.0, do the [4.1 upgrade](/posts/spring-boot-4-1-whats-new-what-breaks) first. This post assumes you're on 4.1.

## The Version Bump

<!-- VERIFY AT GA: 4.2.0 artifacts are on Maven Central; bump to 4.2.1 here if publishing after the first patch -->

```kotlin
// build.gradle.kts
plugins {
    id("org.springframework.boot") version "4.2.0"
    id("io.spring.dependency-management") version "1.1.7"
}
```

```xml
<!-- pom.xml -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.2.0</version>
</parent>
```

Key managed dependency changes, comparing the `spring-boot-dependencies` BOM of 4.1.2 against 4.2.0-RC2:

<!-- VERIFY AT GA: final managed versions in the GA release notes / BOM -->

| Dependency       | 4.1.2    | 4.2 (RC2)  |
| ---------------- | -------- | ---------- |
| Spring Framework | 7.0.10   | **7.1.0**  |
| Spring Security  | 7.1.2    | 7.2.0      |
| Spring Data      | 2026.0.2 | 2026.1.0   |
| Spring Batch     | 6.0.6    | 6.1.0      |
| Kotlin           | 2.3.21   | **2.4.21** |
| Micrometer       | 1.17.2   | 1.18.0     |
| Kafka client     | 4.2.2    | 4.4.0      |
| OpenTelemetry    | 1.62.0   | 1.67.0     |
| Hibernate ORM    | 7.4.13   | 7.4.14     |
| Jackson          | 3.1.7    | 3.1.8      |

Spring Framework 7.1 also raises its own minimums to Jackson 3.1, Hibernate ORM 7.4 (7.1 and 7.2 still work at runtime for now), and HtmlUnit 5.4 for the MockMvc integration. Boot 4.1 already managed Jackson 3.1 and Hibernate 7.4, so this only matters if you override those versions yourself. The Kotlin jump is the one to plan for: bump kapt/KSP and compiler plugins (`all-open`, `no-arg`, serialization) to 2.4 in the same change.

## What's New

### HTTP QUERY Support

[RFC 10008](https://www.rfc-editor.org/info/rfc10008/) defines a new HTTP method, `QUERY`. It's the method that should have existed all along: idempotent and safe like `GET`, but with a request body like `POST`. If you've ever built a `POST /search` endpoint because your filter didn't fit in a query string (and then argued about whether it should be cacheable), this is for you.

Spring Framework 7.1 ships minimal support. There's no `@QueryMapping` shortcut annotation yet, so you use `@RequestMapping` with the new `RequestMethod.QUERY`:

```java
@RestController
public class ProductSearchController {

    public record Search(String term, int limit) {}

    @RequestMapping(method = RequestMethod.QUERY, path = "/products/search",
            consumes = MediaType.APPLICATION_JSON_VALUE)
    public String search(@RequestBody Search search) {
        return "searching for '" + search.term() + "' (limit " + search.limit() + ")";
    }
}
```

**Verified on RC2:**

```bash
$ curl -X QUERY -H 'Content-Type: application/json' \
    -d '{"term":"boots","limit":5}' localhost:8080/products/search
searching for 'boots' (limit 5)
```

And it works in tests through `RestTestClient` with `HttpMethod.QUERY` (example in the [RestTemplate section](#resttemplate-and-testresttemplate-are-deprecated) below).

A word of caution before you rename all your `POST /search` endpoints: `QUERY` is brand new, and proxies, API gateways, WAFs, CDNs, and client libraries have to support it too. Test the whole path through your infrastructure, not just the app. If you run [Spring Cloud Gateway](/posts/ultimate-guide-spring-cloud-gateway) or anything else in front of your services, check that first.

### Problem Details for Every Unhandled Exception

Spring MVC has supported [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) problem details for a while, but only for exceptions handled by a `@ControllerAdvice` that extends `ResponseEntityExceptionHandler`. Anything else fell through to Boot's error handling. 7.1 adds an opt-in that renders **any** unhandled exception as `application/problem+json`:

```java
@Configuration(proxyBeanMethods = false)
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void configureProblemDetails(ProblemDetailsConfigurer configurer) {
        configurer.renderUnhandledExceptions(true);
    }
}
```

**Verified on RC2.** With a controller that does `throw new IllegalStateException("database password is hunter2")`:

```text
HTTP/1.1 500
Content-Type: application/problem+json

{"status":500,"title":"Internal Server Error"}
```

Without the configurer, the same app on 4.2 returns Boot's familiar `{"timestamp":...,"status":500,"error":"Internal Server Error","path":"/boom"}` body, so nothing changes unless you opt in.

What I like about it:

- **The exception message is never exposed** for generic exceptions. You get a plain 500, not your stack trace or your password.
- `ResponseStatusException`, `@ResponseStatus` exceptions, and `ErrorResponse` exceptions keep their status and detail.
- Framework exceptions get the same status and detail `ResponseEntityExceptionHandler` would have given them.
- Type, title, and detail can be customized through your `MessageSource`.
- Browsers that prefer HTML can get an error page instead, through an `ErrorResponseViewResolver`.

If you have a `@ControllerAdvice extends ResponseEntityExceptionHandler` whose only job was "turn everything into problem details," you can probably delete it.

### AMQP 1.0 Support

Spring Boot 4.2 adds AMQP 1.0 support in two flavors:

1. **Generic AMQP 1.0** using Qpid ProtonJ2, for any compliant broker.
2. **RabbitMQ AMQP 1.0** via the RabbitMQ AMQP client, with RabbitMQ-specific features.

This comes with a starter reshuffle that **you must act on** even if you don't care about AMQP 1.0. See [AMQP starter renamed](#amqp-starter-renamed) below.

If you do adopt the RabbitMQ AMQP 1.0 client, RC2 changed some defaults from the earlier milestones <!-- VERIFY AT GA -->:

- `spring.amqp.rabbitmq.username` / `password` **no longer default to `guest`**. Without credentials the client authenticates anonymously.
- The port defaults to `5671` when `spring.amqp.rabbitmq.ssl.bundle` is set.
- `spring.amqp.rabbitmq.template.exchange` and `routing-key` no longer default to an empty string, because the AMQP 1.0 template doesn't support the default exchange.
- The health indicator key is `amqprabbit`, not `rabbit`, so it can coexist with the 0.9 indicator. Update your health group includes if you use the new client.

### Observability: OpenTelemetry Conventions, Shared OTLP Config, MDC Keys

Three welcome changes if you ship telemetry over OTLP:

```yaml
management:
  observations:
    # Opt in to OpenTelemetry's (stable) semantic conventions. Default: micrometer
    conventions: open-telemetry
  opentelemetry:
    otlp:
      # Configure once; tracing, logging and metrics exporters fall back to these.
      # For HTTP transport the signal path (/v1/traces, /v1/logs, /v1/metrics) is appended.
      endpoint: http://otel-collector:4318
      headers:
        authorization: "Bearer ${OTLP_TOKEN}"
      compression: gzip
  tracing:
    mdc:
      trace-id-key: trace_id # default: traceId
      span-id-key: span_id # default: spanId
```

- **Semantic conventions:** setting `management.observations.conventions=open-telemetry` switches metric and span naming to OpenTelemetry's stable conventions. This changes metric names, so your dashboards and alerts will break. Treat it as a migration and run both side by side in a lower environment first. Also note that name-customizing properties like `management.observations.http.server.requests.name` stop working in this mode. (RC2 fixed a bug where setting this property applied _neither_ convention set, so if you tried it on a milestone and got strange results, try again. <!-- VERIFY AT GA -->)
- **Common OTLP fallback:** signal-specific properties still win, and headers are merged, with signal-specific headers taking precedence on conflicts. This removes a lot of copy-paste from `application.yml`.
- **Configurable MDC keys:** if your log pipeline expects `trace_id` instead of `traceId`, you can now set that directly. The default log correlation pattern follows the new keys automatically.

If you're building dashboards on top of this, my [Prometheus and Grafana guide](/posts/spring-boot-prometheus-grafana) and the [Actuator guide](/posts/ultimate-guide-spring-boot-actuator) are the companion reading.

### Faster Startup from Executable Jars

RC1 reworked how the nested-jar class loader looks things up. Classes and resources are now found directly inside the nested jars, instead of opening a URL connection for every nested jar on every lookup. Reading deflated entries, resolving cached resources, sorting auto-configuration classes, and DevTools restarts all got faster too.

I measured it with the same minimal web + actuator app built against both versions, run with `java -jar`, 12 alternating runs each, on an Apple M3 Pro with Temurin 25 (`scripts/compare-startup.sh` in the [sample repo](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-4-2-whats-new-what-breaks)):

|                       | 4.1.2 (median) | 4.2.0-RC2 (median) |
| --------------------- | -------------- | ------------------ |
| `Started ... in`      | 1.011 s        | 0.950 s            |
| `process running for` | 1.206 s        | 1.116 s            |

<!-- VERIFY AT GA: re-run on 4.2.0 GA with the same app before publishing these numbers -->

That's about 6–7% for a tiny app. It's nice, but don't upgrade for it. Bigger apps with more jars on the classpath should gain more, since the improvement scales with lookups. If startup really matters to you, the much bigger wins are still [AOT caching and Leyden](/posts/java-26-aot-cache-zgc-leyden-benchmarks).

### Properties Migrator Can Fail the Build

`spring-boot-properties-migrator` has always printed a helpful warning about renamed keys and then kept going. Warnings get ignored. In 4.2 you can make it fail startup instead:

```yaml
spring:
  properties:
    migrator:
      fail: on-warning # never (default) | on-error | on-warning
```

**Verified on RC2.** With `server.tomcat.use-relative-redirects=false` (a key that moved in 4.2) and `fail: on-warning`, startup aborts with:

```text
The use of configuration keys that have been renamed was found in the environment:

Property source 'commandLineArgs':
	Key: server.tomcat.use-relative-redirects
		Replacement: server.tomcat.servlet.use-relative-redirects

java.lang.IllegalStateException: Found configuration keys that need to be migrated
```

Here's how I'd use it: add the migrator as a `runtime` dependency in a CI integration-test profile with `fail: on-warning`. Every upgrade then tells you exactly which keys to rename, and nothing ships with a stale key. Remove it from production builds once you're done, as the docs recommend.

### Image-Based Buildpacks Build Cache

`bootBuildImage` / `spring-boot:build-image` can now publish and restore the Buildpacks **build cache** as an image in a container registry, not only as a local Docker volume or bind mount. On ephemeral CI runners, where the local volume is gone every run, this is the difference between a warm and a cold Buildpacks build. (`buildWorkspace` and `launchCache` are still local-only.) See the [Gradle](https://docs.spring.io/spring-boot/4.2/gradle-plugin/packaging-oci-image.html) and [Maven](https://docs.spring.io/spring-boot/4.2/maven-plugin/build-image.html) plugin docs for the configuration. <!-- VERIFY AT GA: doc URLs resolve once 4.2 docs are published -->

### Smaller Additions Worth Knowing

- **Multipart for HTTP clients:** a new `MultipartHttpMessageConverter` can both write _and read_ multipart, so `RestClient` can parse multipart responses and `RestTestClient` can test multipart endpoints. `AllEncompassingFormHttpMessageConverter` is deprecated and no longer registered by default.
- **JsonUnit in `spring-test`:** JSONassert is unmaintained. Add `net.javacrumbs.json-unit:json-unit-core` to the test classpath and the `json(...)` assertions in MockMvc, `WebTestClient`, `RestTestClient`, and `MockRestServiceServer` use it automatically. Failure messages will look different.
- **`@DefaultValue` supports property placeholders** in `@ConfigurationProperties` constructor binding.
- **LDAP over SSL bundles:** `spring.ldap.ssl.bundle` for LDAPS, and the embedded LDAP server can be configured with `spring.ldap.embedded.ssl.bundle` for both ends.
- **Kafka:** a dedicated `KafkaAdmin` for templates and listener containers (`spring.kafka.template.admin.*`, `spring.kafka.listener.admin.*`), and `spring.kafka.listener.await-async-results-on-stop`.
- **Caffeine async mode:** `spring.cache.caffeine.cache-mode=async`.
- **`TomcatServerCustomizer`** for customizing Tomcat's `Server`.
- **`jarmode=tools sbom`** prints or exports the SBOM packaged in an uber jar.
- **JPA 4.0 / Hibernate 8.0 groundwork** in Framework 7.1 (`@PersistenceAgent` injection and friends). It's optional and forward-looking, so you don't need to do anything today.

## What Breaks

Now the important half. These are sorted by roughly how likely they are to hit a typical Spring MVC service.

### RestTemplate and TestRestTemplate Are Deprecated

Spring Framework 7.1 deprecates `RestTemplate` **for removal**, as announced in [the state of HTTP clients in Spring](https://spring.io/blog/2025/09/30/the-state-of-http-clients-in-spring). Removal is planned for Framework 8.0, which isn't scheduled yet, so this is a warning, not a fire. Boot follows suit and deprecates:

- `RestTemplateAutoConfiguration`, `RestTemplateObservationAutoConfiguration`
- `RestTemplateBuilder`, `RestTemplateBuilderConfigurer`, `RestTemplateCustomizer`, `RestTemplateRequestCustomizer`, `ObservationRestTemplateCustomizer`
- `MockServerRestTemplateCustomizer` and friends in `spring-boot-restclient-test`
- **`TestRestTemplate`**

**Verified on RC2.** A class that injects `RestTemplateBuilder` compiles, but with:

```text
[WARNING] LegacyClient.java:[9,19] org.springframework.web.client.RestTemplate in
          org.springframework.web.client has been deprecated and marked for removal
[WARNING] LegacyClient.java:[11,25] org.springframework.boot.restclient.RestTemplateBuilder in
          org.springframework.boot.restclient has been deprecated and marked for removal
```

If you build with `-Werror` (or Gradle's `allWarningsAsErrors`), **that's a broken build**. Either migrate or add a targeted `@SuppressWarnings("removal")` while you do.

**Production code: `RestTemplateBuilder` → `RestClient.Builder`.**

```java
// Before
@Component
public class InventoryClient {
    private final RestTemplate restTemplate;

    public InventoryClient(RestTemplateBuilder builder) {
        this.restTemplate = builder.rootUri("https://inventory.internal").build();
    }

    public Stock stock(String sku) {
        return restTemplate.getForObject("/stock/{sku}", Stock.class, sku);
    }
}

// After
@Component
public class InventoryClient {
    private final RestClient restClient;

    public InventoryClient(RestClient.Builder builder) {
        this.restClient = builder.baseUrl("https://inventory.internal").build();
    }

    public Stock stock(String sku) {
        return restClient.get().uri("/stock/{sku}", sku).retrieve().body(Stock.class);
    }
}
```

`RestTemplateCustomizer` beans become `RestClientCustomizer` beans. `@RestClientTest` with `MockRestServiceServer` keeps working as long as the class under test uses the auto-configured `RestClient.Builder`. If your `RestTemplate` was carrying OAuth2 interceptors, my [Ultimate Guide to Spring Web Clients with OAuth2](/posts/ultimate-guide-spring-web-clients-oauth2) has the `RestClient` equivalents.

**Tests: `TestRestTemplate` → `RestTestClient`.** Add `@AutoConfigureRestTestClient` and inject a `RestTestClient`. It talks to the live server in a `RANDOM_PORT` test and uses a mock transport otherwise, and it has built-in assertions:

```java
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
class ProductApiTests {

    @Autowired
    RestTestClient client;

    @Test
    void hello() {
        client.get().uri("/hello")
                .exchange()
                .expectStatus().isOk()
                .expectBody(String.class).isEqualTo("hello");
    }

    @Test
    void querySearch() {
        client.method(HttpMethod.QUERY).uri("/products/search")
                .contentType(MediaType.APPLICATION_JSON)
                .body(new Search("boots", 5))
                .exchange()
                .expectStatus().isOk();
    }

    @Test
    void unhandledExceptionIsProblemDetail() {
        client.get().uri("/boom")
                .exchange()
                .expectStatus().is5xxServerError()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody()
                .jsonPath("$.detail").doesNotExist();
    }
}
```

**Verified on RC2:** all three tests pass. `RestTestClient` and its auto-configuration (`spring-boot-resttestclient`) come in through `spring-boot-starter-webmvc-test`. Remember the [4.1 cookie-handling change](/posts/spring-boot-4-1-whats-new-what-breaks#cookie-handling-in-testresttemplate-and-http-clients) to `TestRestTemplate`? Moving to `RestTestClient` is a good time to make session handling explicit in those tests.

My advice: migrate tests first. They're lower-risk and they make up most of the `TestRestTemplate` usage. Then do production clients one at a time. There's no rush to finish in this release, but don't let the warnings become wallpaper.

### AMQP Starter Renamed

With AMQP 1.0 arriving, `spring-boot-starter-amqp` is no longer the name to use. You have to pick one:

```kotlin
dependencies {
    // Stay on AMQP 0.9.1 (what you have today with RabbitMQ):
    implementation("org.springframework.boot:spring-boot-starter-rabbitmq")

    // OR move to RabbitMQ's AMQP 1.0 client:
    // implementation("org.springframework.boot:spring-boot-starter-amqp-rabbitmq")
}
```

For an existing RabbitMQ app, the safe upgrade is `spring-boot-starter-rabbitmq`: same protocol, same `RabbitTemplate`, same `@RabbitListener`. Moving to AMQP 1.0 is a separate project with different defaults (see above). Don't combine it with the version bump. <!-- VERIFY AT GA: whether spring-boot-starter-amqp is deprecated, relocated, or removed in GA -->

### Tomcat Properties Moved, and Redirects Are Now Relative

Three servlet-specific Tomcat properties moved under `server.tomcat.servlet`:

| 4.1                                          | 4.2                                                  |
| -------------------------------------------- | ---------------------------------------------------- |
| `server.tomcat.additional-tld-skip-patterns` | `server.tomcat.servlet.additional-tld-skip-patterns` |
| `server.tomcat.redirect-context-root`        | `server.tomcat.servlet.redirect-context-root`        |
| `server.tomcat.use-relative-redirects`       | `server.tomcat.servlet.use-relative-redirects`       |

The old keys still work but are deprecated. The [properties migrator](#properties-migrator-can-fail-the-build) will flag them.

The real change is that **`use-relative-redirects` now defaults to `true`**, matching Tomcat's own default. **Verified side by side** with `return "redirect:/hello"`:

```text
4.1.2      → Location: http://localhost:18081/hello
4.2.0-RC2  → Location: /hello
```

Browsers handle relative `Location` headers fine. What breaks:

- **Tests** that assert on the full `Location` value (`assertThat(location).isEqualTo("http://localhost:" + port + "/hello")`).
- **Non-browser clients** or older HTTP libraries that expect an absolute URI.
- **OAuth2/SSO flows and anything else that compares redirect URIs as strings.**

On the plus side, relative redirects stop leaking your internal hostname or the wrong scheme when you're behind a proxy that isn't forwarding headers correctly. To restore the old behavior:

```yaml
server:
  tomcat:
    servlet:
      use-relative-redirects: false
```

### Forwarded Headers Must Be Explicit

Framework 7.1 deprecates the no-arg constructors of `ForwardedHeaderFilter` and `ForwardedHeaderTransformer`. You now have to state whether you trust the standard `Forwarded` header or the `X-Forwarded-*` family, because accepting both was a spoofing risk. Boot reflects that:

- With `server.forward-headers-strategy=framework`, Boot uses **`X-Forwarded-*` by default**. Switch with `spring.mvc.forwarded-headers.header-format` (or `spring.webflux.…`) set to `standard` or `x-forwarded`.
- The `framework` strategy now only applies to Spring MVC and WebFlux apps, not to Servlet apps in general.
- Native server support got the same knob: `server.jetty.forwarded-headers.header-format`, `server.netty.forwarded-headers.header-format`, and so on.

```yaml
server:
  forward-headers-strategy: framework
spring:
  mvc:
    forwarded-headers:
      header-format: standard # if your proxy sends RFC 7239 "Forwarded"
      use-forwarded-prefix: true # only if your proxy sets X-Forwarded-Prefix
```

If your proxy sends RFC 7239 `Forwarded` and you rely on the `framework` strategy, you **must** set `header-format: standard`, or Boot will ignore it.

**WebFlux and `X-Forwarded-Prefix` (RC2):** with `native` on Reactor Netty, or `framework` with WebFlux, `X-Forwarded-Prefix` no longer sets the context path by default. If your ingress strips a path prefix and sets that header, opt back in with `server.netty.forwarded-headers.use-forwarded-prefix=true` (`native`) or `spring.webflux.forwarded-headers.use-forwarded-prefix=true` (`framework`). The symptom is generated links and redirects that are missing their `/api` (or whatever) prefix. <!-- VERIFY AT GA -->

### Stricter MIME Type Parsing

Framework 7.1's `MimeType`/`MediaType` parser follows the RFCs more closely and now **rejects** values it used to quietly accept:

- Duplicate parameters, including ones that differ only by case: `text/plain;charset=UTF-8;CHARSET=ISO-8859-1`
- Parameters without a value: `text/plain;foo`

On the server, an invalid `Accept` header now produces a **406**. **Verified side by side:**

```text
curl -H 'Accept: text/plain;charset=UTF-8;CHARSET=ISO-8859-1' /hello
  4.1.2      → 200
  4.2.0-RC2  → 406

curl -H 'Accept: text/plain;foo' /hello
  4.1.2      → 200
  4.2.0-RC2  → 406
```

On the client side, reading a response with an invalid `Content-Type` throws `InvalidMediaTypeException`.

This is the change most likely to page you after the deploy rather than during the upgrade. It won't fail any of your tests, because your tests send well-formed headers. A sloppy upstream service, a legacy client, or an old mobile app build sending malformed headers will. Before rolling out, grep your access logs for odd `Accept` and `Content-Type` values. If you can't fix the sender, a servlet `Filter` (or WebFlux `WebFilter`) that strips duplicate and empty parameters before Spring reads the header is the documented escape hatch.

### Server Errors Now Show Up in Observations

Exceptions that `ResponseEntityExceptionHandler`, `ResponseStatusExceptionResolver`, or `DefaultHandlerExceptionResolver` translate into a **5xx** are now recorded as the error on the HTTP server observation. In practice:

- The `error` tag on `http.server.requests` is the exception's simple name instead of `none`.
- Server spans are marked failed and carry the exception.

These requests were already tagged `outcome=SERVER_ERROR`, so your error counts don't change. But if you have an alert like "count where `error != none`," it'll get noisier. 4xx responses aren't recorded, so client-error dashboards are unchanged.

### Micrometer Changes

- **`LongTaskTimer` is no longer created by default** for active observations, and `management.metrics.observations.ignored-meters` was removed. If you graph `*.active` long-task timers, opt back in with `management.metrics.observations.include-active-long-task-timer=true`.
- The JVM meter conventions (`JvmMemoryMeterConventions`, `JvmThreadMeterConventions`, `JvmClassLoadingMeterConventions`, `JvmCpuMeterConventions`) are deprecated in favor of one class per meter. Boot still honors the old ones, but **fails fast if you define both a deprecated convention and one of its replacements**.
- **`spring-boot-micrometer-metrics-test`** no longer adds test `MeterRegistry` beans to Micrometer's global registry. That's a good thing, since it stops registries from pinning cached test contexts, but any test that read from `Metrics.globalRegistry` will now see nothing. Use `@AutoConfigureMetrics(useGlobalRegistry = true)` or `management.metrics.use-global-registry=true` to opt back in.

### Test Context Configuration Detection

The TestContext framework now reliably detects _default_ context configuration, such as static nested `@Configuration` classes, across superclasses and enclosing classes. Before, a `@Nested` class or a subclass of a test annotated only with `@SpringBootTest` ignored a static nested `@Configuration` in the parent. Now it gets picked up.

The symptom is tests that suddenly find unexpected beans, or `NoUniqueBeanDefinitionException`. Since Framework 7.0.6 a warning has been logged whenever such configuration was detected but ignored, **so grep your 4.1 test logs for it before you upgrade**. To fix it, move the nested config to a top-level class, drop the `@Configuration` annotation, or declare `@ContextConfiguration` only where you mean it. If you share base test classes across a [Testcontainers](/posts/ultimate-guide-testcontainers-spring-boot) suite, this is the one to watch.

### Smaller Framework 7.1 Changes That Can Bite

- **`ProblemDetail.instance` is no longer set automatically.** It used to be the request path, but RFC 9457 says it should identify the specific occurrence. If clients or contract tests read `instance`, set it yourself or use an `ErrorResponse.Interceptor`. (Verified: RC2's problem-detail responses have no `instance` field.)
- **JAXB is no longer auto-detected for server message converters.** Having `jakarta.xml.bind-api` on the classpath used to quietly register an XML converter that could be CPU-hungry. If your API actually serves XML, register it explicitly:

  ```java
  @Configuration(proxyBeanMethods = false)
  class JaxbConverterConfiguration implements WebMvcConfigurer {
      @Override
      public void configureMessageConverters(HttpMessageConverters.ServerBuilder builder) {
          builder.withXmlConverter(new Jaxb2RootElementHttpMessageConverter());
      }
  }
  ```

- **WebFlux multipart now has default limits:** `maxParts=50` and `maxDiskUsagePerPart=1MB`. Bulk-upload endpoints need a customized `DefaultPartHttpMessageReader`.
- **`WebClient` honors JVM proxy system properties** with Reactor Netty by default. In 4.1 this was true for the Boot-built Reactor clients ([covered in the 4.1 post](/posts/spring-boot-4-1-whats-new-what-breaks#reactor-http-clients-now-respect-system-proxy-properties)). Now Framework's default `ReactorClientHttpConnector` does it too. Opt out with `noProxy()` in the `HttpClient` mapper.
- **Timeouts:** `0` consistently means "no timeout" across HTTP clients. Negative timeouts are rejected, as are sub-millisecond `Duration`s that would truncate to zero.
- **`classpath:` or `classpath:/` as a static resource location now fails startup.** It exposed your entire classpath, class files and `application.yml` included. Use `classpath:/static/`.
- **`HandlerMappingIntrospector` was removed.** If something injected it as a `CorsConfigurationSource` (some older Spring Security configs did), that bean is gone. CORS is handled by the `DispatcherServlet`. See my [Spring Security 7 migration guide](/posts/ultimate-guide-spring-security-7-migration) for current CORS configuration.
- **`RestClient.Builder#configureMessageConverters` now starts from the default converters.** If you configured a deliberately minimal set, call `disableDefaults()`. The Boot auto-configured builder isn't affected.
- **`DataBinder.disallowedFields` is deprecated.** Use `allowedFields`, constructor binding, or a dedicated input model.
- **Derby support is now deprecated in Framework too**, following Boot's deprecation in 4.1. If you still have Derby test fixtures, this is the push to move them to H2 or HSQLDB.

### Other Boot Behavior Changes

- **Redis master/replica now honors `spring.data.redis.database`** (RC2). It used to be silently ignored, and everything went to database 0. If you set a database and master/replica nodes, your app will now read and write _a different database_ after the upgrade. That's either a fix or a data incident, so check before you deploy. <!-- VERIFY AT GA -->
- **Unsupported SSL bundle options fail startup** (RC2). Bundles with `options.ciphers` or `options.enabled-protocols` used by gRPC clients/servers, LDAP, or OTLP tracing/logging exporters used to have those options silently ignored. Now startup fails. Use a separate bundle without options for those components. If you followed my [gRPC guide](/posts/ultimate-guide-spring-grpc) and share one bundle across everything, check this. <!-- VERIFY AT GA -->
- **Embedded LDAP with `ssl.enabled=true` now requires `ssl.bundle`.** It used to start a plaintext listener without telling you. While the embedded server is in use, `spring.ldap.urls`, `username`, `password`, and `ssl.*` are ignored in favor of `spring.ldap.embedded.*`.
- **Default Buildpacks builder is now `paketobuildpacks/ubuntu-resolute-builder`** (Ubuntu 26.04, up from 24.04), and the run image is no longer pinned to a version. For reproducible images, pin both `builder` and `runImage`. To keep the old builder, set `builder` to `paketobuildpacks/builder-noble-java-tiny`. The default run image still has no shell. <!-- VERIFY AT GA -->
- **Configuration property `Set`s and `Map`s now keep their declared order** consistently. You'd only notice if you depended on the old, inconsistent order.
- **Janino dependency management was removed**, following Logback dropping Janino support. If you use Janino for anything, manage its version yourself. Logback `<if>` conditions in `logback-spring.xml` relied on Janino, so check your logging config.
- **Everything deprecated in 4.1 is removed.** Same rule as last time: if 4.1 warnings were firing and you ignored them, they're compile errors now.

## The Upgrade Checklist

1. **On 4.1 first:** fix all deprecation warnings, and grep test logs for the "default context configuration ... ignored" warning.
2. Bump the Boot plugin/parent to 4.2.x. Align anything you pin yourself (Kotlin compiler plugins → 2.4, Hibernate, Jackson).
3. Replace `spring-boot-starter-amqp` with `spring-boot-starter-rabbitmq` (or deliberately choose AMQP 1.0).
4. Add `spring-boot-properties-migrator` with `spring.properties.migrator.fail=on-warning` in CI, and rename every key it flags (Tomcat `servlet.*` keys, observations properties).
5. Run the test suite. Expect to triage: absolute-vs-relative `Location` assertions, `ProblemDetail.instance`, `Metrics.globalRegistry` reads, newly detected nested test configs, and `RestTemplate` removal warnings if you build with `-Werror`.
6. Review deployment-level config: `forward-headers-strategy` + header format, `X-Forwarded-Prefix` on WebFlux, Redis master/replica database, SSL bundle options for gRPC/LDAP/OTLP, Buildpacks builder pinning.
7. Before production, scan access logs for malformed `Accept`/`Content-Type` headers and check alerts that key off the `error` tag.
8. _Then_ adopt the good stuff: migrate `TestRestTemplate` → `RestTestClient`, start moving `RestTemplate` → `RestClient`, turn on `renderUnhandledExceptions`, and consolidate OTLP config.

Steps 1–4 take an hour. Steps 5–7 are where the afternoon goes. Step 8 is ongoing work, and the `RestTemplate` part should be on your roadmap before Framework 8 shows up.

## Should You Wait?

<!-- VERIFY AT GA: update this section with the actual GA date and current patch version at publish time -->

As with 4.1, I'd let the first patch release (4.2.1) land before upgrading production services that use a lot of integrations. Start the upgrade on a branch now, though. Most of the work here is test triage and config renames, and none of it depends on which patch you end up on. The `RestTemplate` deprecation isn't urgent, but every month you wait is another month of new code written against a deprecated API. 4.1.x keeps getting OSS patch releases for a while yet (check the [support timeline](https://spring.io/projects/spring-boot#support)), so you're not under pressure. You're just accumulating work.

## Resources

- [Spring Boot 4.2 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.2-Release-Notes) <!-- VERIFY AT GA: wiki page filled in (currently links to milestone notes) -->
- Milestone notes: [M1](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.2.0-M1-Release-Notes), [M2](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.2.0-M2-Release-Notes), [RC1](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.2.0-RC1-Release-Notes), [RC2](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.2.0-RC2-Release-Notes)
- [Sample code for this post](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-4-2-whats-new-what-breaks)
- [Spring Framework 7.1 Release Notes](https://github.com/spring-projects/spring-framework/wiki/Spring-Framework-7.1-Release-Notes)
- [The state of HTTP clients in Spring](https://spring.io/blog/2025/09/30/the-state-of-http-clients-in-spring)
- [RFC 10008: The HTTP QUERY Method](https://www.rfc-editor.org/info/rfc10008/)
- [Spring Boot 4.0 → 4.1: What's New and What Breaks](/posts/spring-boot-4-1-whats-new-what-breaks)
- [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration)
- [The Ultimate Guide to Spring Web Clients with OAuth2](/posts/ultimate-guide-spring-web-clients-oauth2)
- [The Ultimate Guide to Spring Security 7 Migration](/posts/ultimate-guide-spring-security-7-migration)
- [The Ultimate Guide to Spring Boot Actuator](/posts/ultimate-guide-spring-boot-actuator)
