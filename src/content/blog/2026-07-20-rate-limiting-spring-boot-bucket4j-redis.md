---
author: StevenPG
pubDatetime: 2026-07-20T12:00:00.000Z
title: Rate Limiting in Spring Boot with Bucket4j and Redis
slug: rate-limiting-spring-boot-bucket4j-redis
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - redis
  - infrastructure
description: Proper distributed rate limiting on Spring Boot 4 — token buckets with Bucket4j, shared state in Redis, per-user and per-API-key tiers, correct 429 responses, and k6 load tests proving the limits hold.
---

# Rate Limiting in Spring Boot with Bucket4j and Redis

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. "Spring Boot rate limiting" is one of those searches where the top results are either a `HashMap` of counters that resets whenever the pod restarts, or a fifteen-dependency API-gateway tutorial. The middle path — **correct, distributed rate limiting inside your app with Bucket4j and Redis** — is genuinely simple, and this post builds it on Spring Boot 4 with a k6 load test to prove the limits actually hold.

Demo repo, as always, at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/bucket4j-redis-rate-limiting).

## Token Buckets in 90 Seconds

Bucket4j implements the **token bucket** algorithm: a bucket holds up to `capacity` tokens and refills at a fixed rate; each request consumes one token; empty bucket means rejected request. Two properties make it the standard answer:

- **Bursts are allowed but bounded.** A client can spend saved-up tokens quickly (good UX for a page firing several calls at once), but sustained throughput can't exceed the refill rate.
- **It's cheap.** State per bucket is two numbers — token count and last-refill timestamp — which is what makes storing thousands of them in Redis practical.

The naive alternative (fixed windows: "100 requests per minute, reset at :00") has the classic boundary exploit — 100 requests at 11:59:59 plus 100 at 12:00:01 — which token buckets don't.

## Why Redis Is Not Optional

An in-memory limiter enforces its limit _per instance_. Three replicas behind a load balancer means your "100 req/min" is actually ~300, the counters vanish on every deploy, and the effective limit changes when you scale. If a rate limit matters enough to build, it matters enough to be **shared state** — and Redis is the natural home: fast, with atomic compare-and-swap, and TTLs to garbage-collect idle buckets.

Bucket4j ships a Redis integration that stores serialized bucket state and updates it atomically, so N app instances all draw from the same bucket.

## The Build

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")

    implementation("com.bucket4j:bucket4j-core:8.10.1")
    implementation("com.bucket4j:bucket4j-redis:8.10.1")
    implementation("io.lettuce:lettuce-core")
}
```

Lettuce (the client Spring Data Redis uses under the hood) connects us to Redis; `bucket4j-redis` provides the `LettuceBasedProxyManager` that makes remote buckets look like local ones:

```java
@Configuration
public class RateLimitConfiguration implements WebMvcConfigurer {

    @Bean(destroyMethod = "shutdown")
    RedisClient redisClient(@Value("${rate-limit.redis-uri}") String redisUri) {
        return RedisClient.create(redisUri);
    }

    @Bean
    LettuceBasedProxyManager<byte[]> proxyManager(RedisClient redisClient) {
        return LettuceBasedProxyManager.builderFor(redisClient)
                .withExpirationStrategy(ExpirationAfterWriteStrategy
                        .basedOnTimeForRefillingBucketUpToMax(Duration.ofMinutes(2)))
                .build();
    }
}
```

The expiration strategy is the detail everyone forgets: without it, every client that ever hits you leaves a bucket key in Redis forever. This strategy sets each key's TTL to "time until the bucket would be full again, plus a bit" — an idle bucket expires exactly when expiring it is indistinguishable from a fresh one.

## The Interceptor: Two Tiers of Limits

Real APIs don't have one limit. The demo implements the common shape — authenticated callers get a generous per-key limit, anonymous traffic shares a strict per-IP limit:

```java
@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private final LettuceBasedProxyManager<byte[]> proxyManager;

    // ...

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                             Object handler) throws Exception {
        String apiKey = request.getHeader("X-Api-Key");
        String bucketKey = apiKey != null && !apiKey.isBlank()
                ? "rl:key:" + apiKey
                : "rl:ip:" + clientIp(request);
        BucketConfiguration config = apiKey != null ? apiKeyLimit() : anonymousLimit();

        BucketProxy bucket = proxyManager.builder()
                .build(bucketKey.getBytes(StandardCharsets.UTF_8), () -> config);

        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            response.setHeader("X-Rate-Limit-Remaining",
                    String.valueOf(probe.getRemainingTokens()));
            return true;
        }

        long retryAfterSeconds = probe.getNanosToWaitForRefill() / 1_000_000_000 + 1;
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("""
                {"error": "rate limit exceeded", "retryAfterSeconds": %d}
                """.formatted(retryAfterSeconds));
        return false;
    }

    /** 100 requests/minute refilled gradually, burst capacity 120. */
    private BucketConfiguration apiKeyLimit() {
        return BucketConfiguration.builder()
                .addLimit(Bandwidth.builder()
                        .capacity(120)
                        .refillGreedy(100, Duration.ofMinutes(1))
                        .build())
                .build();
    }

    /** 20 requests/minute for anonymous traffic. */
    private BucketConfiguration anonymousLimit() {
        return BucketConfiguration.builder()
                .addLimit(Bandwidth.builder()
                        .capacity(20)
                        .refillGreedy(20, Duration.ofMinutes(1))
                        .build())
                .build();
    }
}
```

Register it for your API paths (`registry.addInterceptor(rateLimitInterceptor).addPathPatterns("/api/**")`) and you're enforcing.

Details that make this production-shaped rather than demo-shaped:

- **`tryConsumeAndReturnRemaining`** gives you the probe object, which is what lets you send real `Retry-After` and `X-Rate-Limit-Remaining` headers. Well-behaved clients (and every good SDK) use these to back off — a 429 without `Retry-After` is a stampede invitation.
- **`refillGreedy`** trickles tokens continuously (one every 600ms for 100/min) rather than dumping them each interval, which smooths traffic instead of synchronizing retries.
- **One Redis round trip per request** on the happy path. The compare-and-swap loop only retries under write contention on the _same_ bucket.
- **Per-IP limiting is honest-best-effort.** Behind a proxy you must read `X-Forwarded-For` (and trust only your own proxy's value); IPs are shared by NATs and rotated by attackers. Treat the anonymous tier as abuse dampening, and API keys as the real identity.

## Proving It with k6

A rate limiter you haven't load-tested is a hypothesis. The repo includes a k6 script running two scenarios simultaneously — anonymous traffic at 3x its limit, and API-key traffic just under its own:

```javascript
export const options = {
  scenarios: {
    anonymous: {
      executor: "constant-arrival-rate",
      rate: 60,
      timeUnit: "1m",
      duration: "2m", // limit is 20/min
      preAllocatedVUs: 10,
    },
    with_api_key: {
      executor: "constant-arrival-rate",
      rate: 90,
      timeUnit: "1m",
      duration: "2m", // limit is 100/min
      preAllocatedVUs: 10,
      exec: "withApiKey",
    },
  },
};
```

Run `docker compose up -d`, `./gradlew bootRun`, then `k6 run k6/rate-limit-test.js`. Over the 2-minute run the counters land where the bucket math says they must: the anonymous scenario sends 120 requests against a budget of 20/min + 20 burst and gets roughly **60 accepted / 60 rejected**, while the API-key scenario — under its refill rate the whole time — comes through with **zero 429s**. Watching k6 report exactly the numbers you predicted from `capacity` and `refillGreedy` is the moment this stops feeling like configuration and starts feeling like arithmetic.

There's also a Testcontainers integration test asserting the precise 20-accepted/5-rejected boundary, in the spirit of the [Testcontainers post coming later this week](/posts/ultimate-guide-testcontainers-spring-boot).

## What About Filters, Gateways, and Resilience4j?

Fair questions, quick answers:

- **Spring Cloud Gateway's `RequestRateLimiter`** is the right tool if you already run a gateway — same algorithm, enforced at the edge. This post's approach is for when the limit belongs to _the service itself_ (or there is no gateway).
- **Resilience4j's `RateLimiter`** protects a _client_ from overwhelming something downstream (outbound). Bucket4j-per-caller protects _you_ from clients (inbound). Different directions; many services legitimately want both.
- **A servlet `Filter` vs `HandlerInterceptor`** — either works; the interceptor runs after Spring MVC routing, which is handy if limits vary by handler.

## Summary

Distributed rate limiting on Spring Boot 4 is: Bucket4j for correct token-bucket math, Redis (via `LettuceBasedProxyManager`) so every instance enforces the same budget, an interceptor that keys buckets by API key or IP, and honest 429s with `Retry-After`. The whole thing is ~150 lines, adds one Redis round trip per request, and — per the k6 run — does exactly what the math says under 3x overload.

Clone [the demo](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/bucket4j-redis-rate-limiting) and watch your own 429s roll in.

[bucket4j-docs]: https://bucket4j.com/
[k6]: https://k6.io/
[retry-after]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After
