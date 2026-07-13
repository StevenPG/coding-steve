---
author: StevenPG
pubDatetime: 2026-07-11T12:00:00.000Z
title: "Undertow Is Gone in Spring Boot 4: Fixing the ClassNotFoundException"
slug: spring-boot-4-undertow-classnotfoundexception
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - undertow
  - tomcat
  - jetty
description: Spring Boot 4 removed Undertow because it doesn't support Servlet 6.1. Here's the exact error you're seeing, why it happens, and a complete migration path to Tomcat or Jetty including the full server.undertow.* property mapping.
---

# Undertow Is Gone in Spring Boot 4: Fixing the ClassNotFoundException

## Table of Contents

[[toc]]

## The Error You're Seeing

You upgraded to Spring Boot 4, your build resolved (or didn't — more on that in a second), and now your application dies on startup with something like this:

```text
java.lang.ClassNotFoundException: io.undertow.Undertow
	at java.base/jdk.internal.loader.BuiltinClassLoader.loadClass(BuiltinClassLoader.java:641)
	at java.base/jdk.internal.loader.ClassLoaders$AppClassLoader.loadClass(ClassLoaders.java:188)
	at java.base/java.lang.ClassLoader.loadClass(ClassLoader.java:528)
```

or the Gradle/Maven variant, which fails before you even get to runtime:

```text
Could not find org.springframework.boot:spring-boot-starter-undertow:4.0.0.
Searched in the following locations:
  - https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-starter-undertow/4.0.0/spring-boot-starter-undertow-4.0.0.pom
```

or, if you pinned an old starter version to "fix" the resolution error, the more confusing runtime failure:

```text
org.springframework.context.ApplicationContextException: Unable to start web server
Caused by: org.springframework.context.ApplicationContextException:
  Unable to start ServletWebServerApplicationContext due to missing ServletWebServerFactory bean
```

All three are the same root problem: **Undertow support was removed from Spring Boot 4**. There is no `spring-boot-starter-undertow` for Boot 4.x, there is no Undertow autoconfiguration module anymore, and no amount of version pinning will bring it back.

My goal is to make posts like this the SIMPLEST place on the internet to fix things that caused me trouble. So: short diagnosis, then the actual migration, including the property mapping table you're really here for.

## Why Undertow Was Removed

Spring Boot 4 is built on Spring Framework 7 and Jakarta EE 11, which raises the servlet baseline to **Servlet 6.1**. Undertow does not implement Servlet 6.1. The Undertow project's servlet container work has effectively stalled — Red Hat's investment moved toward other runtimes — and the Spring team wasn't going to hold the entire release train on a container that couldn't meet the baseline.

The removal was tracked in [spring-projects/spring-boot#46917](https://github.com/spring-projects/spring-boot/issues/46917) ("Drop support for Undertow as it is not Servlet 6.1 compatible") and it shows up in the [Spring Boot 4.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide) as a one-line entry in the removals list. I covered the full 4.0 migration in my [Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration) — this post is the deep-dive on this one removal, because judging by the search traffic on the error message, a *lot* of applications were running Undertow.

What this means concretely:

- `spring-boot-starter-undertow` has no 4.x release. Ever.
- The `UndertowServletWebServerFactory` and `UndertowReactiveWebServerFactory` classes are gone from Spring Boot.
- Every `server.undertow.*` configuration property is dead. Boot 4 doesn't know they exist (and `spring-boot-properties-migrator` will not map them for you — there's no equivalent target for some of them).
- If Undertow classes are on your classpath from a stale pinned dependency, Boot 4's autoconfiguration will simply ignore them, and you'll get the `missing ServletWebServerFactory bean` failure above.

Your two options are **Tomcat** (the default, what Spring Boot uses when you do nothing) and **Jetty**. Both are Servlet 6.1 compliant in the versions Boot 4 ships (Tomcat 11, Jetty 12.1).

## Which Should You Pick: Tomcat or Jetty?

Honest answer: for 95% of applications it does not matter, and you should take **Tomcat** because it's the default and therefore the most-tested path in the entire Spring ecosystem. Every Spring Boot integration test, every tutorial, every Stack Overflow answer assumes Tomcat unless stated otherwise.

Pick **Jetty** if:

- You chose Undertow originally for its low memory footprint — Jetty is the closer analog of the two. Its thread pool model and buffer management philosophy are nearer to what Undertow was doing.
- You're using WebSocket-heavy workloads and have already benchmarked Jetty favorably.
- Your org already runs Jetty elsewhere and you want one container to reason about.

If you chose Undertow years ago because of a benchmark blog post and never touched a `server.undertow.*` property — you're a Tomcat migration, and it's a five-minute job.

## The Migration, Step by Step

### Step 1: Do It on Spring Boot 3.5 First

If you haven't upgraded yet, swap the server *before* moving to Boot 4. Undertow, Tomcat, and Jetty are all supported on the 3.5.x line, so you can make the container change as an isolated, revertible commit while everything else stays stable. Then the Boot 4 upgrade doesn't have to carry the container swap at the same time.

This is the same advice as the general migration guide: 3.5 is the bridge release; use it.

### Step 2: Swap the Dependency

**Gradle — moving to Tomcat (default):**

```kotlin
// Before
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc") {
        exclude(group = "org.springframework.boot", module = "spring-boot-starter-tomcat")
    }
    implementation("org.springframework.boot:spring-boot-starter-undertow")
}

// After — just delete the exclusion and the undertow starter
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
}
```

That's genuinely it for Tomcat. The web starter pulls Tomcat in transitively. If your Boot 3 build was written against `spring-boot-starter-web`, remember it's `spring-boot-starter-webmvc` in Boot 4 (covered in the [migration guide](/posts/ultimate-guide-spring-boot-4-migration)).

**Gradle — moving to Jetty:**

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc") {
        exclude(group = "org.springframework.boot", module = "spring-boot-starter-tomcat")
    }
    implementation("org.springframework.boot:spring-boot-starter-jetty")
}
```

**Maven — moving to Jetty:**

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc</artifactId>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-tomcat</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jetty</artifactId>
</dependency>
```

Then verify nothing is still dragging Undertow in transitively:

```bash
./gradlew dependencies --configuration runtimeClasspath | grep -i undertow
# or
./mvnw dependency:tree | grep -i undertow
```

If anything shows up (some third-party libraries declared Undertow dependencies for their own embedded servers), exclude it. Leftover Undertow jars won't be used, but they're dead weight and can confuse classpath scanning.

### Step 3: Migrate Your Configuration Properties

This is the part nobody documents in one place. Here is the mapping from every commonly used `server.undertow.*` property to its Tomcat and Jetty equivalents.

| Undertow (Boot 3.x) | Tomcat (Boot 4.x) | Jetty (Boot 4.x) | Notes |
|---|---|---|---|
| `server.undertow.threads.io` | *(no equivalent)* | *(no equivalent)* | Undertow's XNIO IO-thread concept doesn't map. Tomcat/Jetty manage acceptor/selector threads internally; you almost never need to tune them. |
| `server.undertow.threads.worker` | `server.tomcat.threads.max` | `server.jetty.threads.max` | The request-processing pool. Undertow default was `io-threads * 8`; Tomcat defaults to 200, Jetty to 200. |
| — | `server.tomcat.threads.min-spare` | `server.jetty.threads.min` | Minimum idle threads. |
| `server.undertow.buffer-size` | *(no direct equivalent)* | *(no direct equivalent)* | Undertow-specific buffer tuning. Drop it. |
| `server.undertow.direct-buffers` | *(no equivalent)* | *(no equivalent)* | Same — container-internal detail. |
| `server.undertow.max-http-post-size` | `server.tomcat.max-http-form-post-size` | `server.jetty.max-http-form-post-size` | Same semantics, form POST body limit. |
| `server.undertow.max-parameters` | `server.tomcat.max-parameter-count` | *(Jetty: form keys via `server.jetty.max-form-keys`)* | Request parameter cap. |
| `server.undertow.max-headers` | `server.tomcat.max-http-header-size` *(size, not count)* | `server.jetty.max-http-response-header-size` / request equivalent | Undertow capped header *count*; Tomcat/Jetty cap header *size*. Re-check what you were actually protecting against. |
| `server.undertow.max-cookies` | *(no equivalent)* | *(no equivalent)* | Drop it. |
| `server.undertow.accesslog.enabled` | `server.tomcat.accesslog.enabled` | `server.jetty.accesslog.enabled` | |
| `server.undertow.accesslog.dir` | `server.tomcat.accesslog.directory` | `server.jetty.accesslog.filename` *(full path)* | |
| `server.undertow.accesslog.pattern` | `server.tomcat.accesslog.pattern` | `server.jetty.accesslog.format` | Pattern syntaxes differ! See below. |
| `server.undertow.accesslog.prefix` / `.suffix` | `server.tomcat.accesslog.prefix` / `.suffix` | *(part of filename)* | |
| `server.undertow.accesslog.rotate` | `server.tomcat.accesslog.rotate` | `server.jetty.accesslog.retention-period` | |
| `server.undertow.options.server.*` | *(no equivalent)* | *(no equivalent)* | Raw XNIO/Undertow options. Each one needs individual evaluation — most were copy-pasted from tuning guides and can be dropped. |
| `server.undertow.allow-encoded-slash` | `server.tomcat.uri-encoding` + Tomcat connector customization | Jetty `UriCompliance` customization | See the encoded-slash section below — this one bites people. |
| `server.undertow.eager-filter-init` | *(no equivalent — Tomcat is eager by default)* | *(no equivalent)* | |
| `server.undertow.preserve-path-on-forward` | *(no equivalent)* | *(no equivalent)* | Rarely used; verify forwards in tests. |

Properties that are container-agnostic and need **no change**: `server.port`, `server.address`, `server.ssl.*`, `server.compression.*`, `server.http2.enabled`, `server.servlet.*`, `server.max-http-request-header-size`, `server.shutdown`. Those were always Boot-level abstractions.

### Access Log Pattern Translation

If you had a custom Undertow access log pattern, the tokens mostly carry over to Tomcat because both are modeled on Apache httpd's common log format, but verify each token. A typical Undertow pattern:

```yaml
# Before (Undertow)
server:
  undertow:
    accesslog:
      enabled: true
      pattern: '%h %l %u %t "%r" %s %b %D'

# After (Tomcat) — same tokens work, %D is still milliseconds
server:
  tomcat:
    accesslog:
      enabled: true
      pattern: '%h %l %u %t "%r" %s %b %D'
      directory: /var/log/myapp
```

Jetty's `accesslog.format` uses a different configuration style (Jetty's `CustomRequestLog` format strings) — if you're doing serious access-log analysis, this alone is a reason to prefer Tomcat for the migration.

### Step 4: Replace Programmatic Undertow Customizers

If you had a `WebServerFactoryCustomizer<UndertowServletWebServerFactory>` bean, it won't compile anymore. Here's the shape of the translation:

```java
// Before — Boot 3.x with Undertow
@Bean
WebServerFactoryCustomizer<UndertowServletWebServerFactory> undertowCustomizer() {
    return factory -> factory.addBuilderCustomizers(builder ->
        builder.setServerOption(UndertowOptions.ENABLE_HTTP2, true)
               .setWorkerThreads(64));
}
```

```java
// After — Boot 4.x with Tomcat
@Bean
WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
    return factory -> factory.addConnectorCustomizers(connector -> {
        // most Undertow builder options have property equivalents now;
        // only reach for the connector API when a property doesn't exist
    });
}
```

Before porting a customizer line-by-line, check whether Boot 4 has grown a property for whatever you were customizing — `server.http2.enabled=true` replaces the HTTP/2 example above entirely, and `server.tomcat.threads.max=64` replaces the worker threads call. In my experience most Undertow customizer beans dissolve into two or three properties.

### Step 5: The Encoded Slash Gotcha

This is the one that gets past your test suite. Undertow with `server.undertow.allow-encoded-slash=true` would happily accept URLs containing `%2F` and pass them through as path segments. Tomcat **rejects encoded slashes by default** with a 400, because they're a classic path-traversal vector.

If you have API paths where clients legitimately send `%2F` inside a path segment (encoded file paths, base64url values with padding, gateway-style pass-through routing), you need:

```java
@Bean
WebServerFactoryCustomizer<TomcatServletWebServerFactory> allowEncodedSlash() {
    return factory -> factory.addConnectorCustomizers(connector ->
        connector.setEncodedSolidusHandling(
            EncodedSolidusHandling.DECODE.getValue()));
}
```

Think hard before doing this — Tomcat's default exists for a reason. If only one endpoint needs it, consider moving that value to a query parameter or request body instead.

### Step 6: Verify

A checklist that has caught real issues for me on container swaps:

1. **Startup log** — confirm you see `Tomcat started on port 8080` (or Jetty), not a silent fallback.
2. **Actuator** — if you use it, `/actuator/metrics/tomcat.threads.busy` exists now; your Undertow-based dashboards (`undertow_*` metrics) are gone and Grafana panels need updating. I covered the actuator metrics surface in the [Ultimate Guide to Spring Boot Actuator](/posts/ultimate-guide-spring-boot-actuator).
3. **Graceful shutdown** — `server.shutdown=graceful` behaves the same, but re-test your Kubernetes rolling deploys; drain timing differs slightly between containers.
4. **Multipart uploads** — Undertow and Tomcat have different default size limits; test your largest expected upload.
5. **WebSockets** — if you use them, run a real client against the app. The Jakarta WebSocket API is the same but timeout/buffer defaults differ.
6. **Load test** — thread pool defaults differ (Undertow's worker default was CPU-derived; Tomcat's is a flat 200). If you tuned Undertow's pool under load, re-tune, don't copy numbers.

## What About WebFlux Apps?

If you were running Undertow under Spring WebFlux (`UndertowReactiveWebServerFactory`), the default reactive server is and remains **Reactor Netty**, and that's what you should move to — just delete the Undertow starter and the exclusion on `spring-boot-starter-webflux`, and Netty comes back as the default. The `server.undertow.*` properties have no meaning in the Netty world; Netty tuning happens through `ReactorResourceFactory` and `server.netty.*` properties.

## Can I Just Stay on Spring Boot 3.5 with Undertow?

For a while, yes. Spring Boot 3.5 is the last line that supports Undertow, and it has open-source support into 2026 with commercial support beyond that. If Undertow is deeply load-bearing for you (custom handlers, non-servlet Undertow usage), staying on 3.5 while you plan is a legitimate short-term position — but it's a position with an expiration date, and every month you wait, the rest of the ecosystem (Jackson 3, Spring Framework 7 APIs, new starters like [first-party gRPC](/posts/ultimate-guide-spring-grpc)) moves further away from you.

There is no scenario where Undertow comes back in Boot 4.x. Plan the swap.

## Summary

- Spring Boot 4 removed Undertow because Undertow doesn't implement Servlet 6.1, the Jakarta EE 11 baseline.
- The `ClassNotFoundException: io.undertow.Undertow`, the unresolvable `spring-boot-starter-undertow:4.0.0` coordinate, and the `missing ServletWebServerFactory` error are all the same problem.
- Swap to Tomcat (default, easiest) or Jetty (closer to Undertow's footprint philosophy).
- Migrate `server.undertow.*` properties using the table above; most tuning properties have direct `server.tomcat.*` equivalents and the rest should usually be dropped rather than ported.
- Watch out for the encoded-slash behavior change, access log pattern differences, and metric name changes in your dashboards.

## Resources

- [Spring Boot issue #46917 — Drop support for Undertow](https://github.com/spring-projects/spring-boot/issues/46917)
- [Spring Boot 4.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration) (my full migration guide)
- [The Ultimate Guide to Spring Boot Actuator](/posts/ultimate-guide-spring-boot-actuator) (metrics changes after the swap)
- [Tomcat 11 Documentation](https://tomcat.apache.org/tomcat-11.0-doc/)
- [Jetty 12 Documentation](https://jetty.org/docs/)
