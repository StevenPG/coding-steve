---
author: StevenPG
pubDatetime: 2026-07-25T00:00:00.000Z
title: "The Ultimate Guide to Spring Cloud Gateway on Spring Boot 4"
slug: ultimate-guide-spring-cloud-gateway
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - spring cloud gateway
  - microservices
  - api gateway
description: A deep-dive guide to Spring Cloud Gateway on Spring Boot 4 — the new two-flavor split (reactive WebFlux vs servlet WebMVC), routing and predicates, custom filters, load balancing, retries, circuit breakers, rate limiting, edge security with JWT and identity propagation, and observability — built twice, side by side.
---

# The Ultimate Guide to Spring Cloud Gateway on Spring Boot 4

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Cloud Gateway is one of those projects that everyone reaches for the moment they have more than one service, and yet most of the tutorials you'll find are either three years out of date, cover exactly one feature, or assume you already know the difference between a `GlobalFilter` and a `GatewayFilterFactory`.

Spring Boot 4 changed the picture in a way that trips people up immediately: **Spring Cloud Gateway now ships in two flavors**, and they are separate starters with separate config namespaces. The reactive gateway you may already know (Netty, non-blocking, YAML routes) is still here, but there is now a fully-featured **servlet** gateway (Tomcat, blocking, functional routes) that is arguably the better default for most teams. Old blog posts that tell you to add `spring-cloud-starter-gateway` and put routes under `spring.cloud.gateway.routes` are describing an API that no longer exists under that name.

This guide is the up-to-date, Spring-Boot-4-native version. We'll cover what an API gateway actually is and when you need one, then work through **every major gateway feature** — routing and predicates, path rewriting, the three levels of filters, load balancing, retries, circuit breakers with fallbacks, rate limiting, edge security with JWT validation and identity propagation, and observability. And we'll do it **twice**: once on the reactive (WebFlux) gateway and once on the servlet (WebMVC) gateway, side by side, so you can see exactly what changes between them (usually: very little).

Everything here is built and tested against a real, runnable companion project:

| Piece                | Version                  |
| -------------------- | ------------------------ |
| Spring Boot          | **4.0.7**                |
| Spring Cloud         | **2025.1.2** ("Oakwood") |
| Spring Cloud Gateway | **5.0.2**                |
| Java                 | **21**                   |
| Gradle               | **8.14**                 |
| Redis                | 7 (via Docker)           |

The full demo repository is linked at the end and referenced throughout. If you already run a gateway and just want the Spring Boot 4 delta, skip to [The Big Change: Two Flavors on Spring Boot 4](#the-big-change-two-flavors-on-spring-boot-4).

## What an API Gateway Actually Is

An API gateway is a **reverse proxy that speaks your application's language**. It sits at the edge of your system, takes every inbound request, and decides what to do with it before (and after) it reaches a backend service. That "decides what to do" is the whole job, and it usually breaks down into a handful of cross-cutting concerns you do _not_ want to reimplement in every service:

- **Routing** — send `/orders/**` to the orders service and `/inventory/**` to the inventory service, without the client knowing either exists.
- **Security at the edge** — validate the auth token _once_, so ten downstream services don't each have to.
- **Resilience** — retry a flaky call, trip a circuit breaker when a backend is down, serve a fallback instead of a stack trace.
- **Traffic control** — rate limit abusive callers, spread load across instances.
- **Observability** — one place where every request is logged, timed, traced, and correlated.

The key mental shift: a backend behind a gateway is just a normal app. It has no idea a gateway exists. That's the point — the gateway absorbs the cross-cutting complexity so your services can stay boring.

**When do you actually need one?** If you have a single service and a single client, you don't — you're adding a hop for nothing. You want a gateway when you have _multiple_ services behind one public surface, or when you want to enforce a policy (auth, rate limits, tracing) uniformly at the edge instead of trusting every team to get it right. The classic topology is: **one gateway, many backends, one public URL.**

Spring Cloud Gateway is the Spring-native way to build that gateway in Java. Unlike a generic proxy (nginx, Envoy), it's _code you own_ in the same language and ecosystem as your services — you can write a custom filter as a Spring bean, pull in other beans, validate JWTs with Spring Security, and test it with the same tools you already use.

## The Big Change: Two Flavors on Spring Boot 4

Here's the thing that will bite you first, so let's get it out of the way. On Spring Boot 4 / Spring Cloud 2025.1 ("Oakwood"), Spring Cloud Gateway comes in **two independent flavors**, and you pick exactly one per gateway application:

```kotlin
// reactive: Netty, non-blocking, YAML/RouteLocator routes
implementation("org.springframework.cloud:spring-cloud-starter-gateway-server-webflux")

// servlet: Tomcat, blocking, functional RouterFunction routes
implementation("org.springframework.cloud:spring-cloud-starter-gateway-server-webmvc")
```

Note the `-server-webflux` / `-server-webmvc` suffixes. If you're coming from an older Spring Cloud release, the artifact names and the config namespace **both changed**:

|                      | Old (Spring Cloud Gateway 3.x/4.x) | New (Spring Cloud Gateway 5.x, Spring Boot 4) |
| -------------------- | ---------------------------------- | --------------------------------------------- |
| Reactive starter     | `spring-cloud-starter-gateway`     | `spring-cloud-starter-gateway-server-webflux` |
| Servlet starter      | `spring-cloud-starter-gateway-mvc` | `spring-cloud-starter-gateway-server-webmvc`  |
| Reactive config root | `spring.cloud.gateway.routes`      | `spring.cloud.gateway.server.webflux.routes`  |
| Servlet config root  | `spring.cloud.gateway.mvc.routes`  | `spring.cloud.gateway.server.webmvc.routes`   |

If you copy a `spring.cloud.gateway.routes:` block from a 2023-era tutorial into a Spring Boot 4 app, it will silently do nothing, because the property no longer binds. This one change accounts for most of the "my routes aren't working" confusion when people first upgrade.

So which flavor do you choose?

|                  | **WebFlux** (reactive)                                                         | **WebMVC** (servlet)                                                     |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Runtime          | Netty, event loop                                                              | Tomcat, thread-per-request                                               |
| Model            | Non-blocking / reactive                                                        | Blocking                                                                 |
| Route definition | YAML `routes:` and/or `RouteLocator` DSL                                       | Functional `RouterFunction` beans and/or YAML                            |
| Rate limiter     | Built-in `RequestRateLimiter` (Redis Lua token bucket)                         | `Bucket4jFilterFunctions.rateLimit` (Bucket4j; Redis via bucket4j-redis) |
| Circuit breaker  | `spring-cloud-starter-circuitbreaker-`**`reactor`**`-resilience4j`             | `spring-cloud-starter-circuitbreaker-resilience4j`                       |
| Best when        | Very high connection counts, streaming/SSE proxying, an already-reactive stack | A blocking/servlet mental model, functional routes, easy debugging       |

**My honest recommendation:** if you don't have a strong reason to go reactive, use the **servlet** gateway. The blocking model is a simpler mental model, the functional route DSL gives you compile-time checking and IDE navigation, and stepping through a servlet request in a debugger is dramatically less painful than untangling a reactor chain. Reach for WebFlux when you genuinely expect very high concurrency, you're proxying streaming responses (SSE, long-lived connections), or your whole stack is already reactive and you don't want to bridge.

Because the whole point of this guide is to show you both, the companion project builds **both gateways in front of the same two backend services**, so every feature below appears in reactive _and_ servlet form.

## The Core Mental Model: predicate → filters → uri

Before any code, internalize this. Every route in Spring Cloud Gateway — no matter the flavor or the config style — is three things:

```
predicate(s)   →   filter(s)   →   uri
   (if)            (transform)     (where)
```

- **Predicates** decide _whether_ a request matches this route: path, HTTP method, headers, host, query params, time of day, weight. All predicates on a route must match (they're AND-ed).
- **Filters** transform the request on the way in and/or the response on the way out: add a header, rewrite the path, retry, rate-limit, circuit-break.
- **The uri** is _where_ the matched, transformed request gets sent: a concrete `http://host:port`, or `lb://service-name` to load-balance across instances.

That's the entire model. Everything else — YAML vs Java, reactive vs servlet — is just different syntax for expressing `predicate → filters → uri`. Once you see a route this way, the whole framework clicks.

## The Demo System

The companion project is one runnable system: two gateways in front of two backends, plus Redis for rate limiting.

```
                                          ┌──────────────────────────────┐
                                          │  backend-orders     :8081     │
                    ┌── http ────────────►│  (orders, echo, flaky, slow)  │
                    │                     └──────────────────────────────┘
  curl              │
   │   ┌────────────┴───────────┐         ┌──────────────────────────────┐
   ├──►│ gateway-webflux  :8080 │── lb ──►│  backend-inventory  :8082     │
   │   │ (reactive / Netty)     │    │    │  backend-inventory  :8083     │
   │   └────────────────────────┘    │    │  (two instances, round-robin) │
   │                                 │    └──────────────────────────────┘
   │   ┌────────────────────────┐    │
   └──►│ gateway-webmvc   :8090 │── lb ┘         ┌───────────────┐
       │ (servlet / Tomcat)     │───────────────►│  Redis  :6379 │  (rate limiting)
       └────────────────────────┘                └───────────────┘
```

The two backends are deliberately dumb — plain Spring MVC controllers that know nothing about a gateway. What makes them useful is that each endpoint is designed to _make one gateway feature visible_:

- `backend-orders` (`:8081`) has `/orders` (plain routing), `/orders/echo` (reflects the headers it received, so you can _see_ what the gateway's filters did), `/orders/flaky` (fails 2 of every 3 calls, for retries), and `/orders/slow` (sleeps 3s, for circuit breakers).
- `backend-inventory` runs as **two instances** (`:8082` and `:8083`), each reporting which one it is via `/inventory/whoami`, so load balancing is observable.

The single most useful endpoint for learning is `/orders/echo`, which just reflects back the headers it received:

```java
@GetMapping("/orders/echo")
public Map<String, Object> echo(@RequestHeader Map<String, String> headers) {
    return Map.of(
            "instance", instance,
            "message", "these are the headers I received from the gateway",
            "receivedHeaders", headers
    );
}
```

Whatever the gateway added, removed, or asserted shows up here. We'll come back to it repeatedly.

### Project setup

The root `build.gradle.kts` holds everything the modules share: the Spring Boot plugin, the Spring Cloud BOM, and the Java toolchain.

```kotlin
plugins {
    java
    id("org.springframework.boot") version "4.0.7" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

val springCloudVersion = "2025.1.2"   // the "Oakwood" release train

subprojects {
    apply(plugin = "java")
    apply(plugin = "org.springframework.boot")
    apply(plugin = "io.spring.dependency-management")

    the<JavaPluginExtension>().apply {
        toolchain { languageVersion = JavaLanguageVersion.of(21) }
    }

    dependencies {
        // Spring Cloud BOM on top of Boot's own BOM, so Gateway/Resilience4j/LB
        // deps can be declared unversioned in each module.
        add("implementation",
            platform("org.springframework.cloud:spring-cloud-dependencies:$springCloudVersion"))
    }
}
```

The important detail: you pin the **Spring Cloud release train** (`2025.1.2`, code-named Oakwood), and that BOM decides which version of Spring Cloud Gateway, Resilience4j, and Spring Cloud LoadBalancer you get — all tested together against Spring Boot 4.0. Never hand-pick a Gateway version; let the release train do it.

## 1. Routing, Predicates & Path Rewriting

A route matches with predicates and rewrites with filters. Here's the inventory route on both flavors — same route, two syntaxes.

**Reactive (YAML)** — in `application.yml`, everything lives under the new `spring.cloud.gateway.server.webflux` root:

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: inventory
              uri: lb://backend-inventory
              predicates:
                - Path=/inventory/**
                - Method=GET
              filters:
                - AddResponseHeader=X-Load-Balanced, "true"
```

**Servlet (functional)** — the idiomatic servlet style is a `RouterFunction<ServerResponse>` bean built from static helpers:

```java
@Bean
@Order(2)
public RouterFunction<ServerResponse> inventoryRoute() {
    return route("inventory")
            .route(path("/inventory/**").and(method(HttpMethod.GET)), http())
            .filter(lb("backend-inventory"))              // resolve lb:// -> a concrete instance
            .after(addResponseHeader("X-Load-Balanced", "true"))
            .build();
}
```

Read them side by side and the equivalence is obvious: `Path=/inventory/**` becomes `path("/inventory/**")`, `Method=GET` becomes `.and(method(HttpMethod.GET))`, `uri: lb://...` becomes `.filter(lb(...))`, and `AddResponseHeader` becomes `.after(addResponseHeader(...))`. The functional version imports these as static methods:

```java
import static org.springframework.cloud.gateway.server.mvc.handler.GatewayRouterFunctions.route;
import static org.springframework.cloud.gateway.server.mvc.handler.HandlerFunctions.http;
import static org.springframework.cloud.gateway.server.mvc.predicate.GatewayRequestPredicates.path;
import static org.springframework.cloud.gateway.server.mvc.predicate.GatewayRequestPredicates.method;
import static org.springframework.cloud.gateway.server.mvc.filter.AfterFilterFunctions.addResponseHeader;
import static org.springframework.cloud.gateway.server.mvc.filter.LoadBalancerFilterFunctions.lb;
```

### Predicates

The built-in predicates are the vocabulary of "which requests does this route match." The common ones:

| Predicate                      | Matches when…                                   |
| ------------------------------ | ----------------------------------------------- |
| `Path=/orders/**`              | the path matches the Ant/`PathPattern`          |
| `Method=GET,POST`              | the HTTP method is in the list                  |
| `Header=X-Request-Id, \d+`     | a header exists (optionally matching a regex)   |
| `Host=**.example.com`          | the `Host` header matches                       |
| `Query=debug`                  | a query param is present                        |
| `After` / `Before` / `Between` | the request falls in a time window              |
| `Weight=group1, 8`             | probabilistically, for canary/traffic-splitting |

All predicates on a route are AND-ed — every one must match. To OR, define two routes.

### Path rewriting

The most common filter you'll actually need. The backend expects `/orders/123`, but you want to expose it publicly under a different prefix. `RewritePath` uses a regex with a named capture group:

```yaml
- id: orders-yaml
  uri: http://localhost:8081
  predicates:
    - Path=/yaml/orders/**
  filters:
    - RewritePath=/yaml/orders/(?<segment>.*), /orders/${segment}
    - AddResponseHeader=X-Routed-By, yaml-config
```

`/yaml/orders/o-1001` hits the gateway and `/orders/o-1001` reaches the backend. The functional/programmatic equivalent is `.rewritePath("/java/orders/(?<segment>.*)", "/orders/${segment}")`. The demo deliberately exposes orders under three prefixes — `/orders/**`, `/java/orders/**` (rewritten, defined programmatically), and `/yaml/orders/**` (rewritten, defined in YAML) — so you can see rewriting from every angle.

## 2. Filters: Three Levels

Filters are where a gateway earns its keep, and Spring Cloud Gateway gives you three distinct levels of them. Understanding which is which is most of "using the gateway well."

### Level 1: built-in filters

Configured per route, no code. You've already seen `AddResponseHeader` and `RewritePath`. The full set covers most needs: `AddRequestHeader`, `RemoveRequestHeader`, `AddRequestParameter`, `SetPath`, `PrefixPath`, `DedupeResponseHeader`, `SetStatus`, `Retry`, `CircuitBreaker`, `RequestRateLimiter`, and more. In the reactive gateway you can also set **default filters** that apply to every route:

```yaml
spring:
  cloud:
    gateway:
      server:
        webflux:
          default-filters:
            - AddResponseHeader=X-Gateway-Flavor, webflux
            - DedupeResponseHeader=Vary Access-Control-Allow-Origin, RETAIN_UNIQUE
```

### Level 2: a custom GlobalFilter (runs on every route)

When you want cross-cutting behavior on _all_ traffic with no per-route config, you write a `GlobalFilter` (reactive) or a servlet `Filter` (servlet). The demo uses one for access logging and timing.

**Reactive** — implement `GlobalFilter` and `Ordered`:

```java
@Component
public class GlobalLoggingFilter implements GlobalFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(GlobalLoggingFilter.class);

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        long startNanos = System.nanoTime();
        var request = exchange.getRequest();
        log.debug("--> {} {}", request.getMethod(), request.getURI().getRawPath());
        exchange.getResponse().getHeaders().set("X-Gateway-Handled", "webflux");

        return chain.filter(exchange).then(Mono.fromRunnable(() -> {
            long millis = (System.nanoTime() - startNanos) / 1_000_000;
            log.info("<-- {} {} {} ({} ms)",
                    request.getMethod(), request.getURI().getRawPath(),
                    exchange.getResponse().getStatusCode(), millis);
        }));
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;   // first in, last out — wraps the whole chain
    }
}
```

**Servlet** — in the servlet world, "a filter that runs on every request" is literally a `jakarta.servlet.Filter`. Extend `OncePerRequestFilter`:

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class GlobalLoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(GlobalLoggingFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long startNanos = System.nanoTime();
        response.setHeader("X-Gateway-Handled", "webmvc");
        log.debug("--> {} {}", request.getMethod(), request.getRequestURI());
        try {
            chain.doFilter(request, response);
        } finally {
            long millis = (System.nanoTime() - startNanos) / 1_000_000;
            log.info("<-- {} {} {} ({} ms)",
                    request.getMethod(), request.getRequestURI(), response.getStatus(), millis);
        }
    }
}
```

Both log `--> GET /path` on the way in and `<-- GET /path 200 (12 ms)` on the way out, and both stamp `X-Gateway-Handled`. Returning `HIGHEST_PRECEDENCE` makes the filter wrap the _entire_ chain, so the measured time includes every other filter plus the round trip to the backend — first in, last out.

### Level 3: a custom, configurable GatewayFilterFactory

The most powerful (and most Spring Cloud Gateway-specific) level: a **per-route filter that takes arguments**, usable from YAML _by name_. The demo's is `AddCorrelationId`, which guarantees every proxied request carries a correlation id.

The reactive way is a `GatewayFilterFactory`. There's one piece of magic worth calling out: Spring derives the filter's YAML name from the class name by stripping the `GatewayFilterFactory` suffix — so `AddCorrelationIdGatewayFilterFactory` is referenced as `AddCorrelationId`.

```java
@Component
public class AddCorrelationIdGatewayFilterFactory
        extends AbstractGatewayFilterFactory<AddCorrelationIdGatewayFilterFactory.Config> {

    public AddCorrelationIdGatewayFilterFactory() {
        super(Config.class);
    }

    // Lets you write `AddCorrelationId=X-My-Header` (positional arg -> headerName).
    @Override
    public List<String> shortcutFieldOrder() {
        return List.of("headerName");
    }

    @Override
    public GatewayFilter apply(Config config) {
        String header = config.getHeaderName();
        return (exchange, chain) -> {
            String existing = exchange.getRequest().getHeaders().getFirst(header);
            String correlationId = (existing != null && !existing.isBlank())
                    ? existing : UUID.randomUUID().toString();

            // Mutate the REQUEST so the backend receives the header...
            ServerWebExchange mutated = exchange.mutate()
                    .request(r -> r.headers(h -> h.set(header, correlationId)))
                    .build();
            // ...and set it on the RESPONSE so the caller gets it back.
            mutated.getResponse().getHeaders().set(header, correlationId);

            return chain.filter(mutated);
        };
    }

    public static class Config {
        private String headerName = "X-Correlation-Id";
        // getters/setters ...
    }
}
```

Now you can use it in YAML as just `AddCorrelationId`, or wire it into a programmatic route (more on that below). If the client already sent an `X-Correlation-Id`, it's preserved; otherwise a UUID is minted. Either way the backend receives it _and_ it's echoed on the response.

On the servlet side there's no filter-factory abstraction — you express the same behavior as a `before`/`after` filter pair on the route, using request attributes to pass state from the before-filter to the after-filter:

```java
private static Function<ServerRequest, ServerRequest> ensureCorrelationId() {
    return request -> {
        String existing = request.headers().firstHeader(CORRELATION_HEADER);
        String correlationId = StringUtils.hasText(existing) ? existing : UUID.randomUUID().toString();
        request.attributes().put(CORRELATION_ATTR, correlationId);
        return ServerRequest.from(request).header(CORRELATION_HEADER, correlationId).build();
    };
}

private static BiFunction<ServerRequest, ServerResponse, ServerResponse> writeCorrelationId() {
    return (request, response) -> {
        Object correlationId = request.attributes().get(CORRELATION_ATTR);
        if (correlationId != null) {
            response.headers().add(CORRELATION_HEADER, correlationId.toString());
        }
        return response;
    };
}
```

**See it** — the echo endpoint reflects exactly what the backend received:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/orders/echo | jq .receivedHeaders
# {
#   "X-Gateway": "webflux",
#   "X-Request-Start": "gateway",
#   "X-Correlation-Id": "d5bf9846-...",   <- our custom filter
#   "X-Auth-Subject": "alice",            <- see §5 (identity propagation)
#   ...
# }
```

## 3. Load Balancing

You almost never want to hardcode a backend's host and port — you want to spread traffic across instances. Spring Cloud Gateway does this with the `lb://` scheme, backed by Spring Cloud LoadBalancer. You don't need Eureka or Consul to try it: a static instance list feeds the `SimpleDiscoveryClient`.

```yaml
spring:
  cloud:
    discovery:
      client:
        simple:
          instances:
            backend-inventory:
              - uri: http://localhost:8082
              - uri: http://localhost:8083
```

Now a route with `uri: lb://backend-inventory` (reactive) or `.filter(lb("backend-inventory"))` (servlet) round-robins across both instances. The `whoami` endpoint proves it:

```bash
for i in 1 2 3 4; do curl -s localhost:8080/inventory/whoami; echo; done
# {"instance":"inventory:8082"}
# {"instance":"inventory:8083"}
# {"instance":"inventory:8082"}
# {"instance":"inventory:8083"}
```

In production you'd swap the static list for real service discovery (Kubernetes, Eureka, Consul) so instances register and deregister automatically — but the route definition doesn't change. That's the nice part: `lb://backend-inventory` means "whatever `backend-inventory` resolves to right now."

## 4. Resilience: Retry, Circuit Breaker, Rate Limiting

This is where a gateway stops being a fancy proxy and starts being infrastructure. Three patterns, all live in the demo.

### Retry

`/orders/flaky` fails 2 of every 3 calls with a `503`. A Retry filter transparently re-issues the request so the caller almost always sees `200`.

**Reactive** — the Retry filter is richly configurable:

```yaml
- id: orders-flaky
  uri: http://localhost:8081
  order: 0
  predicates:
    - Path=/orders/flaky
    - Method=GET
  filters:
    - name: Retry
      args:
        retries: 3
        series: SERVER_ERROR # retry on 5xx
        methods: GET # only idempotent methods
        backoff:
          firstBackoff: 50ms
          maxBackoff: 500ms
          factor: 2
```

**Servlet** — same idea, one line:

```java
return route("orders-flaky")
        .route(path("/orders/flaky").and(method(HttpMethod.GET)), http())
        .before(uri(ordersUri))
        .filter(retry(3))
        .build();
```

Two things to internalize about retries at the gateway: **only retry idempotent methods** (retrying a `POST` can double-charge someone), and **retry on the right conditions** (5xx and connection failures, not 4xx — a `404` won't get better by asking again). This is also why the flaky route has `order: 0` — higher precedence than the general `/orders/**` route, so this exact path gets the retry behavior and nothing else does.

### Circuit breaker + fallback

Retries help with _transient_ failures. A circuit breaker helps with _sustained_ ones: when a backend is genuinely down or slow, you want to stop hammering it and fail fast with a graceful response. The demo wraps the orders route in a Resilience4j circuit breaker with a **time limiter**, and points its `fallbackUri` at an internal handler.

```yaml
filters:
  - name: CircuitBreaker
    args:
      name: ordersCb
      fallbackUri: forward:/fallback/orders
```

```yaml
resilience4j:
  circuitbreaker:
    instances:
      ordersCb:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 10
        minimum-number-of-calls: 5
        failure-rate-threshold: 50 # open once >=50% of calls fail
        wait-duration-in-open-state: 10s
        permitted-number-of-calls-in-half-open-state: 3
  timelimiter:
    instances:
      ordersCb:
        timeout-duration: 1s # trips on /orders/slow (3s sleep)
```

`/orders/slow` sleeps 3 seconds, the time limiter is 1 second, so the gateway gives up and does an internal `forward:` to the fallback controller instead of hanging the caller:

```java
@RestController
public class FallbackController {
    @RequestMapping("/fallback/orders")
    public ResponseEntity<Map<String, Object>> ordersFallback() {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of(
                        "service", "orders",
                        "message", "Orders is unavailable right now — served by the gateway fallback.",
                        "retryable", true));
    }
}
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/orders/slow
# {"service":"orders","message":"Orders is unavailable ... served by the gateway fallback.", ...}  (HTTP 503, ~1s)
```

The breaker also **opens on failure rate** — once ≥50% of a 10-call window fails, it short-circuits _every_ call straight to the fallback (not even attempting the backend) until it half-opens to test the waters again. That's the whole value: a failing backend stops taking your gateway's threads down with it.

The one dependency subtlety between flavors: the reactive gateway needs the **reactor** variant of the Resilience4j starter (`spring-cloud-starter-circuitbreaker-reactor-resilience4j`), the servlet gateway needs the plain one (`spring-cloud-starter-circuitbreaker-resilience4j`). Get this wrong and the `CircuitBreaker` filter won't wire up. The config and behavior are otherwise identical.

### Rate limiting — the biggest divergence

This is the one place the two flavors genuinely differ under the hood, and it's worth understanding why.

**Reactive** uses the built-in `RequestRateLimiter` filter — a Redis Lua **token bucket** implemented directly against Redis:

```yaml
- name: RequestRateLimiter
  args:
    redis-rate-limiter.replenishRate: 5 # tokens/sec
    redis-rate-limiter.burstCapacity: 10 # bucket size
    redis-rate-limiter.requestedTokens: 1
    key-resolver: "#{@userKeyResolver}"
```

The `key-resolver` decides _what_ you count — and choosing the key is choosing the fairness policy. This resolver gives each authenticated user their own bucket, falling back to client IP for anonymous traffic:

```java
@Bean
public KeyResolver userKeyResolver() {
    return exchange -> exchange.getPrincipal()
            .map(Principal::getName)
            .switchIfEmpty(Mono.fromSupplier(() -> {
                var remote = exchange.getRequest().getRemoteAddress();
                return (remote != null && remote.getAddress() != null)
                        ? remote.getAddress().getHostAddress() : "anonymous";
            }));
}
```

**Servlet** has no `RequestRateLimiter` filter. Instead it ships `Bucket4jFilterFunctions.rateLimit(...)`, backed by **Bucket4j**. For a _distributed_ limit shared across gateway instances, you store the buckets in Redis via `bucket4j-redis`:

```java
.filter(rateLimit(c -> c
        .setCapacity(10)                     // burst
        .setPeriod(Duration.ofSeconds(2))    // refill 10 tokens / 2s  => 5/s
        .setKeyResolver(RateLimitConfig::resolveKey)))
```

The wiring Bucket4j needs is a proxy manager pointed at Redis. The detail that makes it click: the gateway hands Bucket4j a **String** key, so the Lettuce connection is typed `<String, byte[]>` — String keys, binary bucket state:

```java
@Bean
StatefulRedisConnection<String, byte[]> rateLimitRedisConnection(RedisClient client) {
    return client.connect(RedisCodec.of(StringCodec.UTF8, ByteArrayCodec.INSTANCE));
}

@Bean
AsyncProxyManager<String> asyncProxyManager(StatefulRedisConnection<String, byte[]> connection) {
    return LettuceBasedProxyManager.builderFor(connection)
            .withExpirationStrategy(
                ExpirationAfterWriteStrategy.basedOnTimeForRefillingBucketUpToMax(Duration.ofSeconds(10)))
            .build()
            .asAsync();
}
```

Same idea (a Redis-backed token bucket, keyed per user), different engine. **See it** — a burst gets throttled once the bucket empties:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $TOKEN" localhost:8080/orders/o-1001
done; echo
# 200 200 200 200 200 200 200 200 200 200 429 429 429 429 429 429 429 429 429 429
```

The reactive gateway returns the full standard set of headers (`X-RateLimit-Remaining`, `X-RateLimit-Burst-Capacity`, `X-RateLimit-Replenish-Rate`, `X-RateLimit-Requested-Tokens`); the servlet/Bucket4j side returns `X-RateLimit-Remaining`. Worth knowing: the two engines aren't bit-for-bit identical at the boundary. The reactive Redis Lua token bucket gives a crisp cutoff — ten `200`s then ten `429`s. Bucket4j's async, distributed refill is a hair less precise under a tight burst, so on the servlet gateway you'll sometimes see a stray success sneak through right at the edge:

```bash
# reactive  (:8080) — crisp cutoff
# 200 200 200 200 200 200 200 200 200 200 429 429 429 429 429 429 429 429 429 429
# servlet   (:8090) — a straggler slips through near the boundary
# 200 200 200 200 200 200 200 200 200 200 429 429 200 429 429 429 429 429 429 429
```

Neither is "wrong" — a token bucket only promises an _average_ rate with a burst allowance, and both honor that. Just don't write an assertion expecting an exact off-by-one boundary on the Bucket4j side.

Why Redis and not an in-memory counter at all? Because you almost always run _multiple_ gateway instances behind a load balancer, and an in-memory limit of 5/s per instance across 4 instances is really a 20/s limit — Redis is what makes the limit _global_.

## 5. Security at the Edge

Validate the token **once**, at the gateway, so the backends can trust that anything reaching them is already authenticated. This is one of the strongest reasons to run a gateway at all.

The gateway is configured as an **OAuth2 resource server**. The policy is identical in both flavors — only the types differ:

**Reactive** — `ServerHttpSecurity`, `authorizeExchange`, a `ReactiveJwtDecoder`:

```java
@Bean
SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http) {
    http
        .csrf(ServerHttpSecurity.CsrfSpec::disable)   // a gateway has no session/cookie to protect
        .authorizeExchange(exchange -> exchange
            .pathMatchers("/actuator/health/**", "/actuator/info").permitAll()
            .pathMatchers("/fallback/**", "/dev/**").permitAll()
            .pathMatchers("/inventory/**").permitAll()
            .pathMatchers("/orders/**").authenticated()
            .anyExchange().permitAll())
        .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
    return http.build();
}
```

**Servlet** — `HttpSecurity`, `authorizeHttpRequests`, a `JwtDecoder`. Read them side by side and the mapping is mechanical: `ServerHttpSecurity` → `HttpSecurity`, `authorizeExchange` → `authorizeHttpRequests`, `ReactiveJwtDecoder` → `JwtDecoder`, `pathMatchers` → `requestMatchers`.

```java
@Bean
SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http
        .csrf(csrf -> csrf.disable())
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/actuator/health/**", "/actuator/info").permitAll()
            .requestMatchers("/fallback/**", "/dev/**").permitAll()
            .requestMatchers("/inventory/**").permitAll()
            .requestMatchers("/orders/**").authenticated()
            .anyRequest().permitAll())
        .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
    return http.build();
}
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/orders                       # 401
TOKEN=$(curl -s 'localhost:8080/dev/token?sub=alice' | jq -r .access_token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" localhost:8080/orders   # 200
```

> The demo validates HS256 tokens with a shared secret so it runs with **no external IdP**, and a dev-only `/dev/token` endpoint (annotated `@Profile("dev")`) mints them. In production you delete both and point `spring.security.oauth2.resourceserver.jwt.jwk-set-uri` at your real identity provider's JWKS — the gateway then only ever _validates_, never issues.

### Identity propagation (and the confused deputy)

Validating the token at the edge is only half the job. The backends still need to know _who_ the caller is — but you don't want every backend re-parsing a JWT. So after validating, a global filter forwards the authenticated subject downstream as a plain `X-Auth-Subject` header. The backend never touches a token.

There is a security-critical subtlety here, and it's the kind of thing that turns a gateway into a liability if you get it wrong. You must **strip any client-supplied `X-Auth-Subject` first** — otherwise a caller could just send `X-Auth-Subject: admin` and impersonate anyone. This is the classic **confused deputy**: the backend trusts the gateway, so anything the gateway forwards is taken as gospel. The gateway must be the _only_ thing that can set that header.

```java
@Component
public class IdentityPropagationGlobalFilter implements GlobalFilter, Ordered {

    static final String SUBJECT_HEADER = "X-Auth-Subject";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        // 1. ALWAYS remove any inbound value — never trust the client for identity.
        ServerWebExchange stripped = exchange.mutate()
                .request(r -> r.headers(h -> h.remove(SUBJECT_HEADER)))
                .build();

        // 2. Assert the real subject from the validated token (if authenticated).
        return stripped.getPrincipal()
                .filter(p -> p instanceof Authentication auth && auth.isAuthenticated())
                .map(Principal::getName)
                .map(subject -> stripped.mutate()
                        .request(r -> r.headers(h -> h.set(SUBJECT_HEADER, subject)))
                        .build())
                .defaultIfEmpty(stripped)
                .flatMap(chain::filter);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 10;
    }
}
```

Try it: send `-H "X-Auth-Subject: HACKER"` with a valid token for `alice`, and the backend's echo endpoint still shows `alice`. The forged header never survives the strip. (The servlet gateway does the identical strip-then-assert as a `before` filter reading from the `SecurityContextHolder`.)

## 6. Observability

Three layers, from most to least "batteries included":

**1. Actuator.** On the **reactive** gateway, dedicated endpoints ship out of the box. `/actuator/gateway/routes` lists every live route — invaluable when a route "isn't working" and you want to confirm it's even registered:

```bash
curl -s localhost:8080/actuator/gateway/routes | jq '.[].route_id'
# "orders-java" "orders-flaky" "orders" "inventory"
```

> **Gotcha worth knowing:** `/actuator/gateway/*` is **reactive-only**. As of Spring Cloud Gateway 5.0.2, the servlet/functional flavor (`gateway-webmvc`) doesn't register those endpoints, so the same call on `:8090` returns **404**. On the servlet gateway, use `/actuator/mappings` to see the routes Spring registered instead. `/actuator/metrics` and `/actuator/circuitbreakers` work on _both_.

`/actuator/metrics` exposes Micrometer meters (`http.server.requests`, etc.) and `/actuator/circuitbreakers` shows live Resilience4j state. Turn them on in config (the reactive gateway will populate the `gateway` endpoint; the servlet one simply has nothing to expose there):

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, info, metrics, gateway, circuitbreakers, mappings
  tracing:
    sampling:
      probability: 1.0
```

**2. Correlation id.** The custom `AddCorrelationId` filter from §2 gives you always-on, exporter-free request correlation across the gateway and every backend it calls. This is deliberately distinct from tracing: a trace id is for your observability backend; a correlation id is a business-facing handle you can print in an error page or a support ticket.

**3. Distributed tracing.** Micrometer Tracing + Brave (`io.micrometer:micrometer-tracing-bridge-brave`) is on the classpath and sampling is 100%, so each request produces a span you can export to Zipkin or an OTLP collector. The trace context (`traceparent` / `b3` headers) propagates to the backends automatically — the echo endpoint shows them arriving, proving the gateway and backend share one trace.

## Declarative vs Programmatic: You Get Both

A deliberate symmetry runs through the whole demo: **both flavors support both styles**.

- **`gateway-webflux`** defines most routes in **YAML** and adds one **programmatic** route via a `RouteLocator` bean.
- **`gateway-webmvc`** defines most routes with the **functional** `RouterFunction` API and adds one **declarative** route in YAML.

Between the two modules you get all four combinations. Here's the reactive programmatic `RouteLocator` — note how it reuses the custom `AddCorrelationId` filter _bean_ directly, something YAML can't do:

```java
@Bean
public RouteLocator programmaticRoutes(RouteLocatorBuilder builder,
                                       AddCorrelationIdGatewayFilterFactory correlationId) {
    return builder.routes()
            .route("orders-java", r -> r
                    .path("/java/orders/**")
                    .and().method(HttpMethod.GET)
                    .filters(f -> f
                            .rewritePath("/java/orders/(?<segment>.*)", "/orders/${segment}")
                            .addRequestHeader("X-Gateway", "webflux")
                            .addResponseHeader("X-Routed-By", "programmatic-RouteLocator")
                            .filter(correlationId.apply(new AddCorrelationIdGatewayFilterFactory.Config())))
                    .uri("http://localhost:8081"))
            .build();
}
```

**When to use which?** YAML is compact, hot-reloadable, and great for simple routes. The programmatic/functional styles give you compile-time checking, IDE navigation, and access to other beans — reach for them when a route's shape depends on runtime values or other components. Decide per team; you can always mix.

## Watch It All Run

The demo's `scripts/demo-requests.sh` fires the same labeled request suite at **both** gateways so you can compare them line for line. Here's the real output, trimmed to the parts where the two flavors either agree or interestingly disagree.

**They agree on the important stuff** — routing/load-balancing round-robins, security rejects then accepts, and identity propagation strips the forged header:

```text
1) ROUTING + LOAD BALANCING — /inventory/whoami x6 (watch the instance flip)
{"instance":"inventory:8083"}
{"instance":"inventory:8082"}
{"instance":"inventory:8083"}   ... round-robin, both gateways

2) EDGE SECURITY — /orders with NO token => 401
3) EDGE SECURITY — /orders WITH token   => 200

4) IDENTITY PROPAGATION + ANTI-SPOOF — send a FORGED X-Auth-Subject
   receivedHeaders: {
     "X-Auth-Subject": "alice",              <- the REAL subject, not the forgery
     "X-Correlation-Id": "c6384270-...",     <- minted by our custom filter
     "X-Gateway": "webflux" | "webmvc"
   }
```

That `X-Auth-Subject: alice` is the whole confused-deputy defense working: the request sent a forged `X-Auth-Subject`, and the backend still sees the real subject the gateway asserted from the JWT.

**They differ in three telling places.** First, the **circuit-breaker time limiter** — the demo sets 1s on reactive and 2s on servlet, and the 503 timing proves each is enforced:

```text
6) CIRCUIT BREAKER — /orders/slow (3s) trips the time limiter => fallback
   reactive (:8080):  status=503 in 1.010623s   (1s limiter)
   servlet  (:8090):  status=503 in 2.010182s   (2s limiter)
```

Second, **rate limiting** — the crisp reactive cutoff vs Bucket4j's slightly fuzzier boundary (discussed above):

```text
7) RATE LIMITING — 20 rapid calls
   reactive (:8080):  200 x10, 429 x10                      (crisp)
   servlet  (:8090):  200 x10, 429 429 200 429 ...          (a straggler slips through)
```

Third — and this is the one to remember — **the actuator gateway endpoint only exists on the reactive flavor**:

```text
9) OBSERVABILITY — live routes from the actuator gateway endpoint
   reactive (:8080):  "orders-java" "orders-flaky" "orders" "inventory"
   servlet  (:8090):  /actuator/gateway/routes -> 404
                      (Spring Cloud Gateway Server WebMVC doesn't expose it yet;
                       falls back to /actuator/mappings)
```

If you take one thing from running both side by side, it's how _little_ differs — the disagreements above are the exhaustive list of behavioral gaps across the entire feature set. Everything else is byte-for-byte the same request handling with a different engine underneath.

## Testing

You can boot the whole gateway against a **real Redis** with Testcontainers and assert security and routing end to end. The reactive test uses `WebTestClient`; the servlet test uses Spring's newer `RestTestClient` — and they are otherwise near-identical, which again drives home how little differs between the flavors.

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("dev")
@Testcontainers
class GatewayWebfluxIntegrationTest {

    @Container
    static final GenericContainer<?> redis =
            new GenericContainer<>(DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379);

    @DynamicPropertySource
    static void redisProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
    }

    @Test
    void protectedRouteRejectsAnonymousCallers() {
        client.get().uri("/orders").exchange().expectStatus().isUnauthorized();
    }

    @Test
    void allRoutesAreRegistered() {
        client.get().uri("/actuator/gateway/routes")
                .exchange().expectStatus().isOk()
                .expectBody()
                .jsonPath("$[?(@.route_id=='orders')]").exists()
                .jsonPath("$[?(@.route_id=='inventory')]").exists();
    }
}
```

The reactive test above asserts route registration by hitting `/actuator/gateway/routes`. The servlet test _can't_ — that endpoint doesn't exist on the servlet flavor (the actuator gotcha from the observability section), so it asserts registration **behaviorally** instead: a request to a registered route reaches routing and fails downstream with something _other_ than 404, while a genuinely unmatched path 404s from Spring itself.

```java
@Test
void allRoutesAreRegistered() {
    // No /actuator/gateway/routes on the servlet gateway, so assert behaviorally:
    client.get().uri("/inventory/whoami")
            .exchange()
            .expectStatus().value(status -> assertThat(status).isNotEqualTo(404));

    client.get().uri("/this-path-matches-no-route")
            .exchange()
            .expectStatus().isNotFound();
}
```

Pair these full-context integration tests with fast **unit tests** for your custom logic — the demo unit-tests the `AddCorrelationId` filter factory and the Bucket4j key resolver in isolation, with no Docker required. The rule of thumb: unit-test the filters _you_ wrote, integration-test that the whole thing boots and the security + routing wiring is correct.

## Taking It to Production

The demo is deliberately simplified in a few places. Before you ship a gateway:

- **Delete the dev token minter and the shared HS256 secret.** Point the resource server at your IdP's JWKS (`jwk-set-uri`) so the gateway only ever validates. Decide whether to forward the raw `Authorization` header downstream or _only_ the derived identity.
- **Never trust client-supplied identity headers.** Strip-then-assert every header your backends trust (`X-Auth-Subject` here). The confused deputy is the single most common gateway security bug.
- **Externalize service discovery.** Swap the static instance list for Kubernetes/Eureka/Consul so instances come and go automatically.
- **Run Redis in HA** (Sentinel or Cluster). It's on the request path for rate limiting — if it's a single point of failure, so is your gateway.
- **Tune Resilience4j per route and per SLA.** Window sizes, thresholds, and timeouts that are fine for `/orders` may be wrong for a slow report endpoint.
- **Only retry idempotent methods**, and only on transient conditions (5xx, connection failures) — never blanket-retry `POST`.
- **Wire tracing to a real collector** and scrape `/actuator/prometheus`. The correlation id covers you until you do.

## Wrapping Up

Spring Cloud Gateway on Spring Boot 4 is the same powerful reverse proxy it's always been, with one big new wrinkle: **pick your flavor**. The reactive gateway (Netty, YAML/`RouteLocator`) is the feature-complete original; the servlet gateway (Tomcat, functional `RouterFunction`) is the simpler mental model and, for most teams without a reactive stack, the better default. The starters and config namespaces both got renamed — `spring-cloud-starter-gateway-server-{webflux,webmvc}` and `spring.cloud.gateway.server.{webflux,webmvc}` — so don't copy routes from old tutorials and expect them to bind.

Once you're past the setup, everything reduces to the same three-part model: **predicate → filters → uri**. Routing, path rewriting, load balancing, retries, circuit breakers, rate limiting, edge JWT validation, identity propagation, and observability are all just filters and a target. Build them once at the edge and your backend services get to stay boring — which is exactly what you want them to be.

The demo repository used throughout this post — both gateways, both backends, every feature built twice with tests and runnable demo scripts — is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-cloud-gateway-ultimate-guide). The `scripts/` directory has `run-demo.sh` (builds and starts Redis, both backends, and both gateways), `demo-requests.sh` (exercises every feature against both gateways, labeled), and `stop-demo.sh`, so you can watch the whole thing run end to end in a couple of commands.

If you found this useful, the [Spring Security 7 migration guide](/posts/ultimate-guide-spring-security-7-migration/), the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/), and the [rate limiting with Bucket4j and Redis](/posts/rate-limiting-spring-boot-bucket4j-redis/) post go deeper on pieces this guide touches.
