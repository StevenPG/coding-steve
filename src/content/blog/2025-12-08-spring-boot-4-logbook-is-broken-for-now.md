---
author: StevenPG
pubDatetime: 2025-12-08T12:00:00.000Z
title: "Spring Boot 4 and Logbook: ClassNotFoundException"
slug: spring-boot-4-logbook-is-broken-for-now
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - logging
description: Attempting to use Logbook with Spring Boot 4 (broken on arrival)
---

> **Update (February 2026):** This issue has been resolved! Logbook 4.x now fully supports Spring Boot 4. See my follow-up post: [Spring Boot 4 and Logbook: It Works Now!](/posts/spring-boot-4-logbook-now-works)

----

# Spring Boot 4 and Logbook Compatibility Issue: ClassNotFoundException

If you're upgrading to Spring Boot 4 and using [Zalando's Logbook library](https://github.com/zalando/logbook) for HTTP request/response logging, you've likely encountered this frustrating error:

```
java.lang.ClassNotFoundException: org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration
```

It's easy to recreate this error by simply creating a new Spring Boot 4 project using https://start.spring.io/ and adding the Logbook starter as a dependency.

```gradle
implementation 'org.zalando:logbook-spring-boot-starter:3.12.3'
```

## The Problem and Error Details

Logbook, Zalando's popular HTTP request and response logging library, is not currently compatible with Spring Boot 4. The library fails to start due to missing Spring Boot autoconfiguration classes that have been refactored or removed in the latest Spring Boot release.

The full stack trace typically looks like this:

```
Caused by: java.lang.ClassNotFoundException: org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration
	at java.base/jdk.internal.loader.BuiltinClassLoader.loadClass(BuiltinClassLoader.java:580) ~[na:na]
	at java.base/java.lang.ClassLoader.loadClass(ClassLoader.java:490) ~[na:na]
	at java.base/java.lang.Class.forName0(Native Method) ~[na:na]
	at java.base/java.lang.Class.forName(Class.java:547) ~[na:na]
	at org.springframework.util.ClassUtils.forName(ClassUtils.java:302) ~[spring-core-7.0.1.jar:7.0.1]
	at org.springframework.util.ClassUtils.resolveClassName(ClassUtils.java:343) ~[spring-core-7.0.1.jar:7.0.1]
```

## Root Cause

Spring Boot 4 introduced significant changes to its autoconfiguration architecture, including:

- Refactoring of Jackson autoconfiguration classes
- Updates to conditional annotations and configuration loading
- Changes in the Spring Boot starter dependencies structure

Logbook's autoconfiguration relies on specific Spring Boot internal classes that have been modified or relocated in Spring Boot 4, causing the `ClassNotFoundException`.

## Current Status

As documented in [GitHub issue #2177](https://github.com/zalando/logbook/issues/2177), the Logbook maintainers are aware of this compatibility issue. However, there's no official release yet that supports Spring Boot 4.

## The Best Solution for now

### Stay on Spring Boot 3.x

If Logbook is critical to your application and you don't need Spring Boot 4 features immediately:

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.5</version>
    <relativePath/>
</parent>
```

There are alternative (and more manual) logging solutions that are too plentiful to list here,
especially considering the number of available clients for Spring 7.

If you MUST upgrade, it may be worth looking into a replacement.

## Recommendations

1. **Monitor the GitHub issue** for updates on Spring Boot 4 compatibility
2. **Consider the urgency** of your Spring Boot 4 upgrade vs. Logbook dependency
3. **Plan migration strategy** if you choose temporary alternatives
4. **Test thoroughly** if you implement custom logging solutions

## Next Steps

The Logbook community is actively working on Spring Boot 4 compatibility. Keep an eye on:

- [Logbook GitHub repository](https://github.com/zalando/logbook)
- [Issue #2177](https://github.com/zalando/logbook/issues/2177) for status updates