---
author: StevenPG
pubDatetime: 2026-08-26T12:00:00.000Z
title: "Every Timeout in a Spring Boot Request Path (and the Ones That Don't Exist)"
slug: every-timeout-in-a-spring-boot-request-path
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - postgres
  - kafka
  - kubernetes
  - performance
description: A layer-by-layer audit of every timeout a request passes through in a Spring Boot 4 service — ingress, Tomcat, HTTP clients, HikariCP, JDBC, Postgres, Kafka, and Kubernetes shutdown. Which ones have sane defaults, which ones are infinite until you set them, how to size a timeout budget that actually adds up, and why virtual threads made the missing ones harder to notice.
---

# Every Timeout in a Spring Boot Request Path (and the Ones That Don't Exist)

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble.

Here is the outage I have now watched happen, in some form, at three different jobs:

One downstream dependency gets slow. Not down — _slow_. It still accepts TCP connections, it still holds them open, it just stops answering. Within ninety seconds your service is unreachable too, and so is everything that calls _you_. Nothing crashed. No exception was thrown. Your dashboards show a service that is up, healthy, and doing nothing at all.

The cause is almost never exotic. Somewhere in the request path there is a wait with no upper bound, and one slow dependency turned into a queue that filled every resource you had.

The fix is not clever, and that's exactly the problem — it's boring, so nobody writes it down. It's a **timeout budget**: every blocking operation in the path has a deadline, and the deadlines add up to less than the deadline of whoever called you.

This post is the audit. Every layer a request touches in a typical Spring Boot 4 service, what the timeout is called at that layer, what it defaults to, and whether that default will save you. **The short version: a surprising number of them are infinite until you set them.**

There is no demo repo for this one. There's nothing to run — the deliverable is a checklist you apply to a service you already have.

## The Rule That Makes All of It Make Sense

Before the table, the one principle that turns a pile of properties into a design:

> **Every timeout you set must be strictly smaller than the timeout of the thing waiting on you, and strictly larger than the sum of what you wait on.**

That's it. If your caller gives up after 10 seconds, nothing inside your request path should be permitted to take 10 seconds, because then your caller's retry lands on a request you're still processing and you now have two. Budgets flow _inward and downward_, each layer taking a slice and leaving margin.

The failure mode when this is inverted has a name worth knowing: **retry amplification**. Caller times out at 5s and retries; you're still working on attempt one, which is waiting on a database query with no timeout. Now two queries. The caller retries again. Now three. Every retry adds load to a system that is slow _because_ it is overloaded. Timeouts that don't nest are how a small latency bump becomes a self-sustaining outage.

So: pick a number for the whole request at the edge, then spend it.

```
  client 10s
   └── ingress / gateway   8s
        └── your handler   6s        ← spring.mvc.async.request-timeout
             ├── downstream call A   2s connect + read
             ├── downstream call B   2s connect + read
             └── database            1s statement_timeout
                                   ────
                                    ~5s of work, 1s of margin
```

Margin is not waste. It's what absorbs a GC pause, a TLS handshake on a cold connection, and the queue time you can't see.

## The Full Audit Table

Every layer, in the order a request meets them. **Bold defaults are the dangerous ones** — the ones that are unlimited, or effectively unlimited, until you intervene.

| Layer                     | Setting                                       | Default          | What blows up without it                        |
| ------------------------- | --------------------------------------------- | ---------------- | ----------------------------------------------- |
| Ingress (nginx)           | `proxy-connect-timeout`                       | 5s               | —                                               |
| Ingress (nginx)           | `proxy-read-timeout`                          | 60s              | Slow upstreams hold worker connections          |
| Gateway API               | `HTTPRoute.timeouts.request`                  | **unset**        | Implementation-dependent; usually unbounded     |
| Spring Cloud Gateway      | `...httpclient.connect-timeout`               | 45s              | —                                               |
| Spring Cloud Gateway      | `...httpclient.response-timeout`              | **unset**        | Gateway threads pinned by one slow route        |
| Tomcat                    | `server.tomcat.connection-timeout`            | 20s              | Slowloris; connections held pre-request         |
| Tomcat                    | `server.tomcat.threads.max`                   | 200              | Not a timeout — but it's the queue that fills   |
| Spring MVC                | `spring.mvc.async.request-timeout`            | **unset**        | Async requests that never complete              |
| RestClient / RestTemplate | `spring.http.client.connect-timeout`          | **unset**        | Waits for a TCP handshake forever               |
| RestClient / RestTemplate | `spring.http.client.read-timeout`             | **unset**        | **The classic.** Slow dependency = dead service |
| WebClient (Reactor Netty) | connect timeout                               | 30s              | —                                               |
| WebClient (Reactor Netty) | `responseTimeout`                             | **unset**        | Same as above, harder to notice                 |
| Resilience4j              | `TimeLimiter.timeoutDuration`                 | 1s               | — (aggressive by design)                        |
| HikariCP                  | `connectionTimeout`                           | 30s              | Waiting for a pool slot                         |
| HikariCP                  | `validationTimeout`                           | 5s               | —                                               |
| HikariCP                  | `maxLifetime`                                 | 30m              | Stale conns behind a NAT/firewall idle-killer   |
| HikariCP                  | `leakDetectionThreshold`                      | **0 (off)**      | Leaked connections are silent                   |
| pgjdbc                    | `connectTimeout`                              | 10s              | —                                               |
| pgjdbc                    | `socketTimeout`                               | **0 (infinite)** | Half-open TCP = thread parked forever           |
| JPA                       | `jakarta.persistence.query.timeout`           | **unset**        | One bad plan holds a pool connection            |
| Spring TX                 | `@Transactional(timeout = ...)`               | **unset**        | Long transactions pin connections + bloat       |
| Postgres                  | `statement_timeout`                           | **0 (infinite)** | A seq scan on 400M rows runs to completion      |
| Postgres                  | `lock_timeout`                                | **0 (infinite)** | DDL waits behind a reader, blocking everyone    |
| Postgres                  | `idle_in_transaction_session_timeout`         | **0 (infinite)** | Idle TX holds locks and blocks vacuum           |
| Kafka consumer            | `max.poll.interval.ms`                        | 5m               | Slow processing → rebalance loop                |
| Kafka consumer            | `session.timeout.ms`                          | 45s              | —                                               |
| Kafka producer            | `delivery.timeout.ms`                         | 2m               | —                                               |
| Spring lifecycle          | `server.shutdown`                             | **immediate**    | In-flight requests killed on deploy             |
| Spring lifecycle          | `spring.lifecycle.timeout-per-shutdown-phase` | 30s              | —                                               |
| Kubernetes                | `terminationGracePeriodSeconds`               | 30s              | SIGKILL mid-request if graceful exceeds it      |

Count the bold rows. **Eleven** of the settings in that table are unlimited or absent by default, and every one of them sits directly in a normal request path. A default Spring Boot service talking to Postgres over HTTP has _no_ read timeout on its outbound calls, _no_ statement timeout on its queries, and _no_ socket timeout on its JDBC connections. It is, out of the box, a service that will wait forever, three separate times.

Versions matter for these numbers: the table reflects Spring Boot 4.x, HikariCP 5.x/6.x, pgjdbc 42.x, PostgreSQL 18, and Kafka 4.x. Rather than trust me, verify against your own build — there's a section at the end on how to dump what your service is actually running with. Defaults drift between versions, and the ones that matter most are the ones you set explicitly anyway.

## Layer by Layer

### 1. The Edge

Your ingress already has opinions. Ingress-NGINX defaults to a 60-second `proxy-read-timeout`, which is generous but finite, and that finiteness has quietly saved a lot of services whose owners never configured anything downstream.

Gateway API is where this bites people migrating. `HTTPRoute` has a `timeouts.request` field, and it is **unset by default** — behavior with it absent is implementation-defined, and several implementations mean "wait indefinitely." If you're mid-migration off Ingress-NGINX, this is a real behavioral change hiding inside what looks like a config translation. I wrote about the rest of that translation gap in [Ingress-NGINX Migration Part 2](/posts/ingress-nginx-migration-rate-limiting-tls-gateway-api); add this to the list of annotations that don't map cleanly.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
spec:
  rules:
    - timeouts:
        request: 8s # the whole budget, edge to edge
        backendRequest: 6s # one attempt, so retries fit inside `request`
```

That two-field split is the nesting rule expressed in YAML, and it's the clearest example of it anywhere in this post: `backendRequest` bounds a single try, `request` bounds all tries including retries. If you set only one, set `request`.

### 2. Tomcat

`server.tomcat.connection-timeout` (20s) covers the window between a connection being accepted and a complete request arriving. It's your Slowloris defense, and the default is fine.

What Tomcat does _not_ give you is a cap on how long your handler runs. There is no "kill this request after N seconds" knob for a blocking servlet request, and this surprises people constantly. `spring.mvc.async.request-timeout` applies only to async return types — `Callable`, `DeferredResult`, `CompletableFuture`. For an ordinary synchronous controller method, the request runs until it returns.

This is the single most important structural fact in this whole post: **the servlet container will not rescue you.** Every bound on a synchronous request comes from the individual blocking calls inside it. If they're all unbounded, the request is unbounded, and no amount of edge configuration changes that — the edge gives up, but your thread does not. The caller sees a 504 and retries; your thread is still in there, still waiting, still holding its database connection.

`server.tomcat.threads.max` (200) isn't a timeout, but it's the thing that runs out. It's the queue depth of the outage. Which brings us to the part that changed.

### 3. What Virtual Threads Changed (It's Not What You'd Hope)

Turn on `spring.threads.virtual.enabled=true` and Tomcat stops using a bounded pool of platform threads. Each request gets its own virtual thread; a blocked virtual thread unmounts from its carrier and costs you roughly a heap object.

The instinct is that this fixes the whole problem. It does not. It removes the _symptom that used to warn you_.

In the platform-thread world, a slow dependency exhausted 200 threads and your service fell over loudly and fast. That's a bad outage, but it's a _legible_ one: thread dump, 200 threads parked on the same socket read, root cause in ninety seconds.

With virtual threads, those 10,000 stuck requests just... accumulate. Cheaply. Quietly. Heap grows slowly. The service still serves new requests, because there's always another virtual thread. And every one of those parked requests is still holding whatever it grabbed before it blocked — most importantly a **HikariCP connection**, which is still a hard-capped pool of ten.

So the wall moves. Instead of thread exhaustion at 200, you hit connection-pool exhaustion at 10, and now the failure surfaces as `HikariPool-1 - Connection is not available, request timed out after 30000ms` in requests that have nothing to do with the slow dependency. Your error signal now points at your database, which is completely healthy, while the actual cause is an HTTP call three layers away.

Virtual threads made unbounded waits cheaper to accumulate and harder to attribute. They raise the ceiling on how many requests you can have in flight; they do nothing about how long each one is permitted to take. If anything, they make an explicit timeout budget _more_ necessary, because you lost the crash that used to tell you that you didn't have one. I covered the related sharp edges in [Virtual Thread Pinning in 2026](/posts/virtual-thread-pinning-2026-jep-491).

### 4. Outbound HTTP

This is where most incidents actually start.

Spring Boot 4 gives you one place to set it for all auto-configured clients:

```yaml
spring:
  http:
    client:
      connect-timeout: 2s
      read-timeout: 4s
```

`RestClient.Builder` and `RestTemplateBuilder` beans pick these up. **A hand-built client does not.** `RestClient.create()` in a `@Configuration` class bypasses the auto-configured builder entirely and gets no timeouts at all — so does `new RestTemplate()`. Grep your codebase for both; the client someone constructed directly to attach one interceptor is the one that will take you down.

WebClient needs its own treatment, and its default is the trap. Reactor Netty gives you a 30-second connect timeout for free, so `WebClient` _looks_ like it has timeouts configured. There is no default response timeout:

```java
HttpClient httpClient = HttpClient.create()
    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 2000)
    .responseTimeout(Duration.ofSeconds(4));

WebClient client = WebClient.builder()
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

Prefer `responseTimeout` on the connector over a reactive `.timeout()` operator downstream. The connector-level one closes the connection; the operator only abandons the subscription, which can leave the socket in use. Use both if you like — but the connector one is the one that reclaims the resource.

If you're using OAuth2, remember the token endpoint is an HTTP call too, on the same request path, and it's frequently built from a _different_ client than your business calls. A hung token fetch fails exactly like a hung API call. See [The Ultimate Guide to Spring Web Clients with OAuth2](/posts/ultimate-guide-spring-web-clients-oauth2).

### 5. HikariCP

Hikari's defaults are the best-tuned in this entire table, which is why I only want to change two of them.

```yaml
spring:
  datasource:
    hikari:
      connection-timeout: 3000 # down from 30s — fail fast, don't queue
      leak-detection-threshold: 20000 # off by default; turn it on
      max-lifetime: 900000 # under any network idle-kill upstream
```

**`connectionTimeout: 30s` is too long for a web request.** If the pool is empty, waiting 30 seconds for a slot is just adding 30 seconds of queue to a service that is already in trouble — and doing it while holding a Tomcat thread (or, now, a virtual thread and everything it references). Failing in 3 seconds turns a spreading outage into a fast, obvious error with a clear name. Batch jobs are the exception; give those their own `DataSource` with a longer wait.

`leakDetectionThreshold` is off by default and costs nothing to enable. It logs a stack trace when a connection has been checked out longer than the threshold — pointing at the exact line that borrowed it. That is the single highest-value log line in this entire post and it is disabled in every service that hasn't been through an incident.

`maxLifetime` matters when a firewall, NAT gateway, or cloud load balancer silently drops idle TCP connections. Hikari's default is 30 minutes; if something in the path kills connections at 15, keep `maxLifetime` comfortably below it or you'll serve traffic through sockets that are already dead on the other end.

And pool size: **it is not a timeout, but it is the resource every timeout in this post is really protecting.** The pool is smaller than you think it should be — usually around ten — and no amount of raising it fixes an unbounded query. It just means more connections stuck in the same place.

### 6. JDBC and Postgres

pgjdbc's `socketTimeout` defaults to `0`, meaning infinite, and it's the backstop for the ugliest failure in the set: a connection that is gone at the TCP level without either side being told. A dropped NAT mapping, a node reboot, a fabric blip. Your thread is blocked in a socket read that will never return, and no database-side setting can help, because as far as the database is concerned there is nothing running. Only a socket-level deadline recovers this.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://db:5432/app?connectTimeout=5&socketTimeout=30
```

Note the units — pgjdbc takes those in **seconds**, while nearly everything else in Spring Boot takes milliseconds or a `Duration`. Set `socketTimeout` well above your longest legitimate query; it's a backstop for a dead socket, not a query governor.

The query governor is `statement_timeout`, and it also defaults to infinite. Set it per-connection so it applies to everything, including the query someone runs by hand:

```yaml
spring:
  datasource:
    hikari:
      connection-init-sql: "SET statement_timeout = '5s'; SET lock_timeout = '3s'; SET idle_in_transaction_session_timeout = '30s'"
```

Three settings, three distinct failure modes, all infinite by default:

- **`statement_timeout`** — caps one statement. Without it, a plan regression on a table that grew past a threshold turns a 20ms index lookup into a sequential scan that runs until something else gives up first.
- **`lock_timeout`** — caps how long you wait _for a lock_, separately from execution. This is the one that turns a routine migration into an outage: your `ALTER TABLE` queues behind a long-running read, and because Postgres locks queue, _every subsequent query on that table now queues behind your ALTER_. One slow reader plus one DDL takes the whole table offline. Anyone doing schema changes on a live system should set this. See also [Flyway vs Liquibase in 2026](/posts/flyway-vs-liquibase-2026), where the same hazard applies to migration tooling.
- **`idle_in_transaction_session_timeout`** — kills sessions that opened a transaction and then went to lunch. An idle transaction holds its locks _and_ holds back the vacuum horizon, so dead tuples accumulate across the whole database. This is how one buggy client causes table bloat in tables it never touched.

For finer control, `@Transactional(timeout = 5)` (seconds) and `jakarta.persistence.query.timeout` (milliseconds) work per-operation, and can tighten a specific path below the connection-wide default. Just don't use them _instead_ of the server-side settings — application-level timeouts only apply to code paths you remembered.

### 7. Kafka

Kafka's timeouts are about consumer-group membership rather than request latency, and its defaults are mostly sane. The one to know is `max.poll.interval.ms`, at 5 minutes: exceed it and the broker concludes your consumer is dead and rebalances the group. If your handler occasionally takes longer than that, you don't get a slow consumer — you get a rebalance loop, where the group spends its time reassigning partitions instead of processing anything, and every rebalance makes the backlog worse.

The fix is almost never raising the interval. It's making the handler faster, or reducing `max.poll.records` so a batch can't exceed the window. Raising `max.poll.interval.ms` to 15 minutes just means it takes 15 minutes to notice a genuinely wedged consumer.

Also: **whatever your consumer calls, calls with your timeout budget.** A Kafka handler with no read timeout on an HTTP call is the same bug as a web handler with no read timeout, except it manifests as consumer lag and a rebalance loop instead of a 504. Same missing property, completely different-looking incident. Details in [The Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams).

### 8. Shutdown

Not a request timeout, but it's where a correctly-configured service still drops traffic on every single deploy.

Spring Boot does **not** enable graceful shutdown by default. Without it, SIGTERM stops the container immediately and in-flight requests die — a burst of 502s on every rollout, which teams learn to ignore precisely because it happens every time.

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

And the constraint people miss — this has to nest inside Kubernetes:

```yaml
terminationGracePeriodSeconds: 30 # must exceed the Spring phase timeout
```

If `timeout-per-shutdown-phase` exceeds `terminationGracePeriodSeconds`, Kubernetes SIGKILLs you mid-drain and graceful shutdown accomplished nothing. Keep the Spring number comfortably below the Kubernetes one — the same nesting rule as everywhere else, one last time.

## Auditing a Service You Already Have

Four commands. Do this on something running in production; the gap between what you believe is configured and what is actually configured is usually where the interesting finding lives.

**1. What Postgres is actually enforcing**, per connection — run it as your application user, since these can be set at the role or database level:

```sql
SHOW statement_timeout;
SHOW lock_timeout;
SHOW idle_in_transaction_session_timeout;
```

Three zeros means nothing is bounded.

**2. What's stuck right now**, which doubles as a live check that your settings work:

```sql
SELECT pid, state, now() - query_start AS duration, left(query, 60)
FROM pg_stat_activity
WHERE state <> 'idle' AND now() - query_start > interval '5 seconds'
ORDER BY duration DESC;
```

Anything here older than your `statement_timeout` means it isn't applying to that path.

**3. What Spring resolved**, via Actuator — the source of truth for what your properties became after profiles, config maps, and environment overrides had their say:

```bash
curl -s localhost:8080/actuator/configprops | jq '.. | objects | with_entries(select(.key | test("[Tt]imeout")))  | select(length > 0)'
```

If you don't have Actuator wired up, [start here](/posts/ultimate-guide-spring-boot-actuator).

**4. The grep that finds the real bug.** Every hand-constructed HTTP client that skipped the auto-configured builder:

```bash
grep -rn "new RestTemplate()\|RestClient.create()\|WebClient.create()" --include=*.java --include=*.kt src/
```

Every hit is a client with no timeouts. In my experience this command finds something in most codebases over about a year old.

## What I'd Actually Change First

If you read this and do exactly one thing, do the outbound read timeout. It's one property, it covers the most common origin of this failure, and it takes a minute:

```yaml
spring:
  http:
    client:
      connect-timeout: 2s
      read-timeout: 5s
```

Then, roughly in order of value per minute spent:

1. `statement_timeout` on the connection, via `connection-init-sql`
2. `leak-detection-threshold` on Hikari — free diagnostics, permanently
3. `socketTimeout` on the JDBC URL — the backstop for dead sockets
4. `lock_timeout`, before your next migration rather than after
5. Graceful shutdown, nested under `terminationGracePeriodSeconds`

None of this is clever. That's the point — it's the boring configuration that stands between one slow dependency and a full outage, and it stays unset because nobody's job is to set it. Adding it to a checklist that runs before a service ships is worth more than any amount of tuning after.

Pick a total budget. Spend it deliberately. Make sure it adds up.
