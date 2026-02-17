---
author: StevenPG
pubDatetime: 2026-02-16T12:00:00.000Z
title: "The Ultimate Guide to Spring Boot 4 Migration"
slug: ultimate-guide-spring-boot-4-migration
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - gradle
  - testing
description: A comprehensive, practical guide to migrating from Spring Boot 3.x to 4.0 — covering Gradle 9, Jackson 3, starter renames, testing changes, and everything in between.
---

# The Ultimate Guide to Spring Boot 4 Migration

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Boot 4.0 GA was released in November 2025, and it is a significant release. It's built on Spring Framework 7, ships with Jackson 3, requires Java 21, and renames a bunch of starters you've been using for years. That's a lot of moving parts.

This guide is for anyone migrating a production application or a side project from Spring Boot 3.x to 4.0. Whether you're dealing with a monolith, a handful of microservices, or a weekend project that's been sitting on 3.2 for a while, this covers the full scope of what you need to change.

These are all manually validated, and you can try them yourself.

I'm not going to sugarcoat it -- this is one of the larger Spring Boot migrations in recent memory. The Jackson 3 changes alone will touch most of your codebase. But if you approach it methodically, it's entirely manageable. The official [Spring Boot 4.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide) is the canonical reference. This post is my attempt at making the practical side of that migration as painless as possible.

## Before You Start -- Prerequisites

Before touching your Spring Boot version, make sure your foundation is solid.

**Java 21 minimum.** Spring Boot 4.0.x requires Java 21 through 25. If you're still on 17, that's the first thing to upgrade. Check my [Spring Version Compatibility Cheatsheet](/posts/spring-compat-cheatsheet) for the full matrix.

**Gradle 8.14+ minimum (Gradle 9 recommended).** Spring Boot 4 supports Gradle 8.14 and above. Gradle 9 is recommended and comes with its own set of changes (covered below).

**Upgrade to Spring Boot 3.5.x first.** This is the single most important prerequisite. Bump your project to the latest 3.5.x release and fix every deprecation warning. Spring Boot 3.5 exists specifically to bridge you to 4.0 -- it deprecates everything that's removed in 4.0 and gives you clear compiler warnings about what needs to change. If you skip this step, you'll be debugging removal errors instead of reading deprecation messages.

### Key Dependency Baseline

Here's what Spring Boot 4.0 pulls in under the hood:

| Dependency | Version |
|------------|---------|
| Spring Framework | 7.0 |
| Spring Security | 7.0 |
| Spring Data | 2025.1 |
| Hibernate | 7.1 |
| Jackson | 3.0 |
| Tomcat | 11.0 |
| Jetty | 12.1 |
| Kotlin | 2.2+ |
| Jakarta EE | 11 |

If any of your direct dependencies conflict with these versions, resolve that first.

## Gradle 9 Migration

This section is personal. I upgraded to Gradle 9 alongside Spring Boot 4 and hit every one of these issues. If you're on Gradle 8.14+, you can technically skip Gradle 9 for now, but you'll need to deal with it eventually. I recommend doing it at the same time -- rip the bandage off.

### Why Gradle 9?

Spring Boot 4 supports Gradle 9, and the Spring team recommends it. Gradle 9 brings:

- Kotlin 2.2 for build scripts
- Groovy 4 for Groovy DSL scripts
- Java 17 minimum for running Gradle itself (not your project -- Gradle the tool)
- Removal of several long-deprecated APIs

The last point is where the pain is. Gradle 9 removed APIs that have been deprecated since Gradle 7 or earlier, and a lot of plugins and build scripts still use them.

### Convention API Removal

The `convention` API is gone. If your build scripts or plugins used it, you'll get a hard error.

```kotlin
// Before (Gradle 8)
val javaConvention = project.convention.getPlugin(JavaPluginConvention::class.java)
javaConvention.sourceCompatibility = JavaVersion.VERSION_21

// After (Gradle 9)
java {
    sourceCompatibility = JavaVersion.VERSION_21
}
```

Same for the base plugin:

```kotlin
// Before
val baseConvention = project.convention.getPlugin(BasePluginConvention::class.java)
baseConvention.archivesBaseName = "my-app"

// After
base {
    archivesName.set("my-app")
}
```

The `java {}` and `base {}` blocks are the correct extension-based replacements. If you have custom Gradle plugins that use the convention API, those need updating too.

### `buildDir` to `layout.buildDirectory`

The `buildDir` property is removed. Every reference needs to change to the provider-based `layout.buildDirectory`.

```kotlin
// Before
val output = "$buildDir/generated"

// After
val output = layout.buildDirectory.dir("generated")
```

This one is easy to find with a project-wide search. Every occurrence of `buildDir` in your `build.gradle.kts` files needs to be replaced.

### Plugin Configuration Changes

Several plugin configurations switched from direct property assignment to the Property API.

**JaCoCo:**

```kotlin
// Before
tasks.jacocoTestReport {
    reports {
        csv.isEnabled = false
        xml.isEnabled = true
        xml.destination = file("$buildDir/reports/jacoco.xml")
    }
}

// After
tasks.jacocoTestReport {
    reports {
        csv.required.set(false)
        xml.required.set(true)
        xml.outputLocation.set(layout.buildDirectory.file("reports/jacoco.xml"))
    }
}
```

**Application plugin:**

```kotlin
// Before
application {
    mainClassName = "com.example.MainKt"
}

// After
application {
    mainClass.set("com.example.MainKt")
}
```

**JCenter removal -- use mavenCentral():**

If you still have `jcenter()` in your repositories block, remove it. JCenter has been shut down for years, but Gradle 9 no longer silently ignores it.

```kotlin
repositories {
    // jcenter() // Remove this - JCenter is shut down
    mavenCentral()
}
```

## Module and Starter Renames

Spring Boot 4 renamed several starters to better reflect what they actually contain. The most notable one: `spring-boot-starter-web` is now `spring-boot-starter-webmvc`.

| Old Starter | New Starter |
|-------------|-------------|
| `spring-boot-starter-web` | `spring-boot-starter-webmvc` |
| `spring-boot-starter-web-services` | `spring-boot-starter-webservices` |
| `spring-boot-starter-oauth2-authorization-server` | `spring-boot-starter-security-oauth2-authorization-server` |
| `spring-boot-starter-oauth2-client` | `spring-boot-starter-security-oauth2-client` |
| `spring-boot-starter-oauth2-resource-server` | `spring-boot-starter-security-oauth2-resource-server` |

The `web` to `webmvc` rename makes sense -- it distinguishes between Spring MVC and Spring WebFlux, which was always a source of confusion. The OAuth2 renames group everything under `security`, which is more consistent.

### The Classic Starter Bridge

If you need to migrate quickly and don't have time to update every dependency line, Spring provides transitional "classic" starters:

```kotlin
// Quick migration path - pulls in all modules like Boot 3 did
implementation("org.springframework.boot:spring-boot-starter-classic")
testImplementation("org.springframework.boot:spring-boot-starter-test-classic")
```

These classic starters are a temporary bridge. They pull in the same set of dependencies that the old starters did, so your application keeps working while you plan the real migration. But they will be removed in a future release. Don't ship with them long-term -- treat them as a stepping stone.

### Gradle Before/After

```kotlin
// Before (Spring Boot 3.x)
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
}

// After (Spring Boot 4.x)
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
}
```

## Jackson 3.0 Migration

This is the biggest breaking change in Spring Boot 4 for most projects. Jackson 3 is a major version bump with package renames, group ID changes, and class renames. If your application serializes or deserializes JSON (and it almost certainly does), this section applies to you.

### Group ID Change

Jackson 3 moved some of its artifacts to a new Maven group ID:

```kotlin
// Before
implementation("com.fasterxml.jackson.core:jackson-databind")
implementation("com.fasterxml.jackson.module:jackson-module-kotlin")

// After
implementation("tools.jackson.core:jackson-databind")
implementation("tools.jackson.module:jackson-module-kotlin")
```

Note that `jackson-annotations` stays at `com.fasterxml.jackson.annotation` (version 2.20, compatible with Jackson 3.x). This is intentional -- annotations are shared between Jackson 2 and 3.

### Package Rename in Java Code

This is the part that touches the most files:

```java
// Before
import com.fasterxml.jackson.databind.ObjectMapper;

// After
import tools.jackson.databind.ObjectMapper;
```

This affects every file that imports a Jackson class. A project-wide find-and-replace from `com.fasterxml.jackson.databind` to `tools.jackson.databind` will handle most of it, but review the results carefully -- the annotations package does not change.

### Spring Boot Class Renames

Spring Boot also renamed several of its own Jackson-related classes:

| Old (Spring Boot 3.x) | New (Spring Boot 4.x) |
|------------------------|----------------------|
| `JsonObjectSerializer` | `ObjectValueSerializer` |
| `Jackson2ObjectMapperBuilderCustomizer` | `JsonMapperBuilderCustomizer` |
| `@JsonComponent` | `@JacksonComponent` |
| `spring.jackson.read.*` | `spring.jackson.json.read.*` |
| `spring.jackson.write.*` | `spring.jackson.json.write.*` |

Don't forget the property renames. If you have `spring.jackson.read.ACCEPT_SINGLE_VALUE_AS_ARRAY=true` in your `application.yml`, it needs to become `spring.jackson.json.read.ACCEPT_SINGLE_VALUE_AS_ARRAY=true`.

### Jackson Core Class Renames

Jackson 3 itself renamed several heavily-used classes:

| Old (Jackson 2.x) | New (Jackson 3.x) |
|--------------------|-------------------|
| `JsonDeserializer` | `ValueDeserializer` |
| `JsonSerializer` | `ValueSerializer` |
| `JsonProcessingException` | `JacksonException` (now RuntimeException!) |
| `JsonMappingException` | `DatabindException` |
| `SerializerProvider` | `SerializationContext` |

Pay close attention to `JacksonException`. In Jackson 2, `JsonProcessingException` extended `IOException`. In Jackson 3, `JacksonException` extends `RuntimeException`. This means your `catch (IOException e)` blocks that were catching Jackson errors will no longer catch them. You need to update those catch blocks to handle `JacksonException` explicitly, or you'll have uncaught exceptions in production.

```java
// Before - Jackson 2.x
try {
    MyObject obj = objectMapper.readValue(json, MyObject.class);
} catch (IOException e) {
    // This caught JsonProcessingException because it extended IOException
    log.error("Failed to parse JSON", e);
}

// After - Jackson 3.x
try {
    MyObject obj = objectMapper.readValue(json, MyObject.class);
} catch (JacksonException e) {
    // JacksonException is now a RuntimeException - IOException won't catch it
    log.error("Failed to parse JSON", e);
}
```

### Bridge Module for Gradual Migration

If you can't migrate all your Jackson code at once, Spring Boot provides a compatibility bridge:

```kotlin
// Temporary compatibility bridge
implementation("org.springframework.boot:spring-boot-jackson2")
```

This module provides backward-compatible shims so that Jackson 2-style code continues to work while you migrate incrementally. Like the classic starters, this is a bridge -- not a long-term solution.

## JSpecify and Null Safety

I wrote a dedicated deep-dive on JSpecify: [Spring Boot 4 - What is JSpecify?](/posts/spring-boot-4-what-is-jspecify). That post covers the full picture -- what JSpecify can and cannot do, IDE setup, and practical patterns.

The short version for migration purposes:

- Spring Boot 4 has adopted [JSpecify](https://jspecify.dev/) for null safety annotations throughout its codebase.
- Spring's own `@Nullable` and `@NonNull` annotations are deprecated in favor of JSpecify equivalents.
- You should add `@NullMarked` at the package level via `package-info.java` and use `@Nullable` from JSpecify on parameters and return values that can be null.

Here's what a `package-info.java` looks like:

```java
@NullMarked
package com.example.myapp;

import org.jspecify.annotations.NullMarked;
```

This establishes a null-safe zone for the entire package. Any parameter or return type is assumed non-null unless explicitly annotated with `@Nullable`. Your IDE will light up with warnings for potential null issues, which is the point.

You don't have to adopt JSpecify on day one of your migration. But if you're writing new code or touching existing code during the migration, it's a good time to add it.

## Hibernate and Data Changes

Spring Boot 4 ships with Hibernate 7.1 and Spring Data 2025.1. Here are the key changes.

### Hibernate Processor

The annotation processor artifact was renamed:

```kotlin
// Before
annotationProcessor("org.hibernate:hibernate-jpamodelgen")

// After
annotationProcessor("org.hibernate.orm:hibernate-processor")
```

If you use the JPA static metamodel (those `Entity_` classes), this is a required change. Your build will fail without it.

### Spring Data 2025.1

Spring Data 2025.1 is the version aligned with Spring Boot 4. Most of the API remains the same, but there are a few notable changes.

### Elasticsearch RestClient

If you're using Spring Data Elasticsearch, the `RestClient` class has been replaced:

```java
// Before
RestClient restClient = ...;

// After
Rest5Client restClient = ...;
```

This change aligns with the Elasticsearch client library's own evolution. If you're not using Elasticsearch, you can ignore this.

## Removed Features

Spring Boot 4 removed several features that had been deprecated in earlier versions:

| Removed Feature | Replacement |
|----------------|-------------|
| Undertow embedded server | Tomcat or Jetty |
| Pulsar Reactive auto-configuration | Use Spring Pulsar directly |
| Embedded launch scripts | Gradle `application` plugin or container deployment |
| Spring Session Hazelcast | Hazelcast's own Spring integration |
| Spring Session MongoDB | MongoDB's own Spring integration |
| Spock testing support | JUnit 5 with Mockito |
| Classic loader implementation | Remove `LoaderImplementation.CLASSIC` configuration |

If you're using Undertow as your embedded server, this is probably the most disruptive removal. You'll need to switch to Tomcat (the default) or Jetty. For most applications, swapping the starter dependency is all that's needed.

## Testing

The testing changes in Spring Boot 4 are the kind that will silently break your tests if you don't catch them. They compile fine but fail at runtime with confusing errors. Let me walk through each one.

### MockitoExtension

In Spring Boot 3.x, `MockitoTestExecutionListener` was auto-registered. In Spring Boot 4, you need to explicitly add `MockitoExtension`:

```java
// Before - MockitoTestExecutionListener was auto-registered
@SpringBootTest
class MyServiceTest {
    @Mock
    private MyRepository repository;
}

// After - explicitly add MockitoExtension
@SpringBootTest
@ExtendWith(MockitoExtension.class)
class MyServiceTest {
    @Mock
    private MyRepository repository;
}
```

Without `@ExtendWith(MockitoExtension.class)`, your `@Mock` fields will be null and your tests will fail with NullPointerExceptions.

### @MockBean to @MockitoBean

`@MockBean` and `@SpyBean` are gone. They've been replaced with `@MockitoBean` and `@MockitoSpyBean` from a different package:

```java
// Before
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.mock.mockito.SpyBean;

@SpringBootTest
class OrderServiceTest {
    @MockBean
    private PaymentGateway paymentGateway;

    @SpyBean
    private OrderRepository orderRepository;
}

// After
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

@SpringBootTest
class OrderServiceTest {
    @MockitoBean
    private PaymentGateway paymentGateway;

    @MockitoSpyBean
    private OrderRepository orderRepository;
}
```

Important: these annotations can NO LONGER be used in `@Configuration` classes. They must be placed on test class fields directly. If you had a shared test configuration class that declared `@MockBean` fields, that pattern no longer works.

### @SpringBootTest Changes

In Spring Boot 3.x, `@SpringBootTest` auto-configured MockMvc and TestRestTemplate. In Spring Boot 4, you need to opt in explicitly:

```java
// Before - MockMVC was auto-configured
@SpringBootTest
class MyControllerTest {
    @Autowired
    private MockMvc mockMvc;
}

// After - must explicitly add @AutoConfigureMockMvc
@SpringBootTest
@AutoConfigureMockMvc
class MyControllerTest {
    @Autowired
    private MockMvc mockMvc;
}
```

Same for `TestRestTemplate`:

```java
// After - must explicitly add @AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestRestTemplate
class MyIntegrationTest {
    @Autowired
    private TestRestTemplate restTemplate;
}
```

Without the explicit auto-configure annotation, the `@Autowired` field will fail to inject and your test context won't start.

### RestTestClient

Spring Boot 4 introduces `RestTestClient` as a new fluent API for integration testing. It's the recommended approach going forward:

```java
// New fluent test API (recommended)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
class MyIntegrationTest {
    @Autowired
    private RestTestClient restTestClient;

    @Test
    void shouldReturnOk() {
        restTestClient.get().uri("/api/hello")
            .exchange()
            .expectStatus().isOk()
            .expectBody(String.class).isEqualTo("Hello, World!");
    }
}
```

If you've used `WebTestClient` before, the API will feel familiar. `RestTestClient` provides a similar fluent assertion style but works with the synchronous stack.

### Security Testing

The security test utilities moved to their own starter:

```kotlin
// build.gradle.kts - new dependency required for @WithMockUser
testImplementation("org.springframework.boot:spring-boot-starter-security-test")
```

If your tests use `@WithMockUser`, `@WithMockOAuth2Token`, or similar security test annotations, you'll need this dependency. Without it, those annotations won't be recognized.

## Other Notable Changes

These don't warrant their own sections but are worth knowing about:

- **DevTools live reload disabled by default.** If you relied on it, re-enable with `spring.devtools.livereload.enabled=true`.
- **Liveness/readiness probes enabled by default.** Kubernetes users will appreciate this. If you don't want them, disable with `management.endpoint.health.probes.enabled=false`.
- **Optional dependencies excluded from uber jars by default.** If you were relying on optional transitive dependencies being present in your fat jar, they won't be anymore.
- **Spring Batch now in-memory by default.** It no longer requires a database for job metadata. If you need persistent job state, configure a datasource explicitly.
- **Kafka/AMQP retry migrated to Spring Framework core retry.** The retry mechanism now uses Spring's built-in retry support instead of Spring Cloud-specific retry.

## Migration Checklist

Here's the ordered checklist I used for my own migration. Follow these steps in order:

1. Upgrade to Spring Boot 3.5.x and fix all deprecation warnings
2. Upgrade to Java 21 if not already
3. Upgrade Gradle to 8.14+ (or 9.x)
4. Fix Gradle build script deprecations (`buildDir`, conventions, etc.)
5. Update Spring Boot plugin to 4.0.x
6. Replace renamed starters (or use classic starters temporarily)
7. Migrate Jackson 2 to Jackson 3 imports and classes (or use bridge module)
8. Update test annotations (`@MockBean` to `@MockitoBean`, add `@AutoConfigureMockMvc`, etc.)
9. Replace removed features (Undertow, etc.)
10. Update JSpecify annotations
11. Update Hibernate processor dependency
12. Run full test suite and fix remaining issues

**Decision framework:** Use `spring-boot-starter-classic` and `spring-boot-jackson2` if you need to migrate quickly and plan to clean up later. Use the explicit new starters and Jackson 3 APIs if you have the time for a clean migration. Either approach works -- the bridges exist for exactly this reason.

## Resources

- [Spring Boot 4.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- [Spring Boot 4.0 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Release-Notes)
- [Jackson 3 Migration Guide](https://github.com/FasterXML/jackson/blob/main/jackson3/MIGRATING_TO_JACKSON_3.md)
- [Spring Boot 4 - What is JSpecify?](/posts/spring-boot-4-what-is-jspecify) (my deep-dive)
- [Spring Version Compatibility Cheatsheet](/posts/spring-compat-cheatsheet) (my cheatsheet)
- [Spring Boot 4 and Logbook](/posts/spring-boot-4-logbook-now-works) (Jackson 3 migration example)
