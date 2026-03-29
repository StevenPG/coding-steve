---
author: StevenPG
pubDatetime: 2026-03-31T12:00:00.000Z
title: "Fixing Page<T> Deserialization in Spring Boot 4 with Jackson 3"
slug: spring-boot-4-page-deserialization-jackson3
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
description: Spring Boot 4's Jackson 3 upgrade silently breaks Page<T> deserialization for REST clients. Here's why it happens and the one-dependency fix.
---

# Fixing Page&lt;T&gt; Deserialization in Spring Boot 4 with Jackson 3

## Table of Contents

[[toc]]

You're building a Spring Boot 4 service that consumes a paginated API from another service. You set up a `RestClient` or `HttpServiceProxyFactory`, define your interface, and return `Page<T>`. This is the standard Spring Data pattern. It worked in Spring Boot 3. It should work now.

Then you run it and get this:

```
Error while extracting response for type [org.springframework.data.domain.Page<com.example.MyEntity>] and content type [application/json]
Caused by: tools.jackson.databind.exc.MismatchedInputException: Cannot construct instance of `org.springframework.data.domain.Page`
(or through reference chain): abstract types either need to be mapped to concrete types, have custom deserializer, or contain additional type information
```

If you're here because you hit that error, you're in the right place. This post explains why Spring Boot 4 breaks `Page<T>` deserialization, why every existing Stack Overflow answer won't help, and a one-dependency fix I published to solve it.

## Why This Happens

Spring Boot 4 ships Jackson 3 as the default JSON library. This is a major version bump from Jackson 2 — the package moved from `com.fasterxml.jackson` to `tools.jackson`. It's not a drop-in upgrade.

Spring Data Commons 4.x includes a `SpringDataJackson3Configuration.PageModule` that's supposed to handle `Page` serialization and deserialization. If you look at the auto-configuration, it looks like this should Just Work. Here's the problem: **that module only handles serialization**.

The `PageModule` registers a `SerializerModifier` for `PageImpl` — so when your service *sends* a `Page<T>` as a JSON response, Jackson knows how to serialize it. But it adds zero deserializers. No abstract type mappings. No `@JsonCreator` support. Nothing.

So when your service is on the *receiving* end — consuming a paginated JSON response from another service — Jackson 3 looks at `Page<T>`, sees an interface, and has no idea how to construct an instance. It fails immediately.

This is a gap in Spring Data Commons 4.x. Serialization works. Deserialization doesn't.

## Why the Old Fixes Don't Work

If you search for this error, you'll find dozens of Stack Overflow answers pointing to the OpenFeign `PageJacksonModule` and `SortJacksonModule`. These were the standard solution in the Spring Boot 2 and 3 era.

They won't work here. Those modules extend `com.fasterxml.jackson.databind.Module` — that's Jackson 2. Spring Boot 4 uses `tools.jackson.databind.ObjectMapper` — that's Jackson 3. They're fundamentally incompatible. You can't register a Jackson 2 module on a Jackson 3 `ObjectMapper`. It won't compile.

The other common advice is to create a `RestPage<T> extends PageImpl<T>` class with a `@JsonCreator` constructor and copy-paste it into every project. That does work, but it requires wiring it into your Jackson configuration manually, and it's the kind of boilerplate that gets copied between projects with subtle bugs introduced each time.

## The Debugging Journey

This one cost me some time, and it's worth documenting because the failure mode is misleading.

I started with the obvious approaches:

1. **`@Import(SpringDataJackson3Configuration.class)`** — Discovered it only registers serializers. No help for deserialization.

2. **`SimpleModule.addAbstractTypeMapping(Page.class, RestPage.class)` as a bean** — Appeared to fail with the same error.

3. **`JsonMapperBuilderCustomizer` with a mixin** — Same apparent failure.

4. **`@Bean @Primary JsonMapper` replacing all `HttpMessageConverter`s** — Still "failed."

Each approach produced a stack trace that started with the same `Cannot construct instance of Page` message. So I kept escalating the solution, assuming each previous approach wasn't registering correctly.

Then I finally read the **full** stack trace instead of just the first few lines. Buried further down was a completely different error:

```
MismatchedInputException: Cannot map null into type int
```

The actual failure was on `RestPage["number"]`. The upstream service was returning `null` for page metadata fields like `number`, `size`, and `totalElements`. My `RestPage` class was using primitive `int` and `long` for those fields. Jackson 3 can't deserialize `null` into a primitive — it throws immediately.

Every single approach I tried was actually working. The abstract type mapping was fine. The mixin was fine. The customizer was fine. The real error was a null-to-primitive mismatch buried under a misleading top-level exception.

The fix was switching `RestPage` to use wrapper types (`Integer`, `Long`) with null-safe defaults. Once I did that, the simplest approach — a single `JsonMapperBuilderCustomizer` — worked perfectly.

The lesson: when Jackson gives you a "cannot construct" error, always read the full stack trace. The root cause might be three exceptions deep.

## The Solution

Rather than copy-paste a `RestPage` class into every project that consumes paginated APIs, I published a Spring Boot starter that handles it automatically:

[spring-boot-starter-page-jackson3](https://github.com/StevenPG/spring-boot-starter-page-jackson3)

## Usage

Add the dependency. That's it.

**Gradle:**
```groovy
implementation 'com.stevenpg:spring-boot-starter-page-jackson3:0.0.1'
```

**Maven:**
```xml
<dependency>
    <groupId>com.stevenpg</groupId>
    <artifactId>spring-boot-starter-page-jackson3</artifactId>
    <version>0.0.1</version>
</dependency>
```

Then use `Page<T>` as a return type like you normally would:

```java
@HttpExchange("/api/users")
interface UserClient {
    @GetExchange
    Page<User> getUsers(Pageable pageable);
}
```

No additional configuration. No custom beans. No mixin registration. The auto-configuration handles everything.

## Seeing It In Action

If you want to run the fix yourself before adding it to your project, the demo repository shows the before-and-after with runnable code:

[github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-starter-page-jackson3](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-starter-page-jackson3)

It's three Spring Boot 4 applications you run simultaneously:

| Module                | Port   | Purpose                                             |
|-----------------------|--------|-----------------------------------------------------|
| `page-server`         | `8080` | Serves a `Page<User>` response                      |
| `page-client-success` | `8081` | Consumes the server **with** the library — works    |
| `page-client-failure` | `8082` | Consumes the server **without** the library — fails |

Start each in its own terminal:

```bash
# Terminal 1
cd page-server && ../gradlew bootRun

# Terminal 2
cd page-client-success && ../gradlew bootRun

# Terminal 3
cd page-client-failure && ../gradlew bootRun
```

Hit the success client and you get a proper deserialized response:

```bash
curl "http://localhost:8081/call-server?page=0&size=3"
```

```json
{
  "status": "SUCCESS",
  "message": "Page<User> deserialized with spring-boot-starter-page-jackson3",
  "page": 0,
  "size": 3,
  "totalElements": 10,
  "totalPages": 4,
  "content": [
    { "id": 1, "name": "Alice", "email": "alice@example.com" },
    { "id": 2, "name": "Bob",   "email": "bob@example.com" },
    { "id": 3, "name": "Charlie", "email": "charlie@example.com" }
  ]
}
```

Hit the failure client and you get the exact error this post is about:

```bash
curl "http://localhost:8082/call-server?page=0&size=3"
```

```json
{
  "status": "FAILURE",
  "rootCause": "tools.jackson.databind.exc.InvalidDefinitionException: Cannot construct instance of `org.springframework.data.domain.Page`...",
  "fix": "Add 'com.stevenpg:spring-boot-starter-page-jackson3:0.0.1' to your dependencies!"
}
```

The only difference between the two clients is one line in `build.gradle`:

```groovy
// page-client-success has this
implementation 'com.stevenpg:spring-boot-starter-page-jackson3:0.0.1'

// page-client-failure does not
```

## How It Works Under the Hood

The library is intentionally minimal. Three pieces:

**1. `PageJackson3AutoConfiguration`** — A Spring Boot auto-configuration class that registers a `JsonMapperBuilderCustomizer` bean. It's annotated with `@AutoConfiguration` and uses `@ConditionalOnClass({Page.class, JsonMapperBuilderCustomizer.class})` to only activate when Spring Data and Jackson 3 are both on the classpath.

**2. The customizer** adds a `@JsonDeserialize(as = RestPage.class)` mixin on `Page.class`. This tells Jackson 3: "whenever you encounter a `Page` interface, deserialize it as `RestPage`." This uses `tools.jackson.databind.annotation.JsonDeserialize` — Jackson 3's annotation, not Jackson 2's.

**3. `RestPage<T>`** extends `PageImpl<T>` with a `@JsonCreator` constructor that uses wrapper types (`Integer`, `Long`) instead of primitives. When the upstream service returns `null` for page metadata fields, the constructor defaults them to safe values instead of throwing.

The JSON format it handles is the standard Spring Data page response:

```json
{
  "content": [{"name": "Alice"}, {"name": "Bob"}],
  "number": 0,
  "size": 20,
  "totalElements": 100,
  "totalPages": 5,
  "first": true,
  "last": false
}
```

## Requirements

| Dependency | Version |
|---|---|
| Spring Boot | 4.0+ |
| Spring Data Commons | 4.0+ |
| Jackson | 3.x |
| Java | 17+ |

## Conclusion

This is a gap in the Spring ecosystem that should ideally be closed in Spring Data Commons itself. The `PageModule` already handles serialization — adding a deserializer or abstract type mapping for `Page` would complete the picture and make this library unnecessary. Until that happens, this starter fills the gap with zero configuration.

The source is at [github.com/StevenPG/spring-boot-starter-page-jackson3](https://github.com/StevenPG/spring-boot-starter-page-jackson3). If you hit the same issue and this saved you an afternoon of debugging, that's exactly why I published it.
