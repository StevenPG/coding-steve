---
title: Spring Version Compatibility Cheatsheet
description: A continuously updated reference for aligning Java, Gradle, Spring Boot, and Spring Cloud versions.
slug: spring-version-compatibility
pubDatetime: 2025-05-04T12:00:00.000Z
modDatetime: 2026-11-21T12:00:00.000Z
tags:
  - gradle
  - java
  - spring
order: 0
---

Quick lookup tables for aligning your JDK, Gradle, Spring Boot, and Spring Cloud versions. Kept current as new versions
ship, so bookmark it. For the official, authoritative matrix, see Spring's
[Support Mapping](https://spring.io/projects/generations).

**Jump to:** [Spring Boot &harr; Java](#spring-boot--java) &middot;
[Spring Cloud &harr; Spring Boot](#spring-cloud--spring-boot) &middot;
[Gradle &harr; Java](#gradle--java)

## Spring Boot &harr; Java

| Spring Boot Version | Compatible Java Versions (Min - Max Targeted) |
| :------------------ | :-------------------------------------------- |
| 4.2.x               | Java 17 - 27                                  |
| 4.1.x               | Java 17 - 26                                  |
| 4.0.x               | Java 17 - 25                                  |
| 3.5.x               | Java 17 - 25                                  |
| 3.4.x               | Java 17 - 24                                  |
| 3.3.x               | Java 17 - 23                                  |
| 3.0.x - 3.2.x       | Java 17 - 21                                  |
| 2.7.x               | Java 8 - 21                                   |
| 2.6.x               | Java 8 - 19                                   |
| 2.5.x               | Java 8 - 18                                   |
| 2.4.x               | Java 8 - 16                                   |
| 2.2.x - 2.3.x       | Java 8 - 15                                   |
| 2.1.x               | Java 8 - 12                                   |
| 2.0.x               | Java 8 - 9                                    |
| 1.5.x               | Java 6 - 8                                    |

Spring Boot 4.x and 3.x baseline on Java 17. **Spring Boot 4.2.0 reached GA on November 19, 2026**, confirming the Java 17-27 range above. It ships
the new default Buildpacks builder (`paketobuildpacks/ubuntu-resolute-builder`, on an Ubuntu 26.04 base), refined
forwarded-header support for reactive servers (they no longer trust forwarded headers by default on cloud
platforms), and deprecates Apache Pulsar support. It pulls in Spring Framework 7.1.0, Spring Security 7.2.0, and
Spring Batch 6.1.0. Patch releases **4.1.3** and **4.0.10** shipped the same day. As of November 2026, **4.0.x**,
**4.1.x**, and **4.2.x** are all in open-source support: 4.0.x until **December 31, 2026** and 4.1.x until
**July 31, 2027** (4.2.x's end date will follow once published). **3.5.x reached OSS end-of-life on June 30, 2026**
(commercial support continues). Source: [endoflife.date](https://endoflife.date/spring-boot#java-compatibility).

> **Security note:** A critical OpenJDK flaw nicknamed "Java4Shell" ([CVE-2026-114938](https://nvd.nist.gov/vuln/detail/CVE-2026-114938)),
> a heap out-of-bounds write in the hardware-accelerated Base64 decoder, was fixed across vendor builds on
> November 17, 2026. It affects OpenJDK 17.0.6 and later, plus all 21, 25, and 27 builds before the November 2026
> patch level (Oracle lists 21.0.13, 25.0.5, and 27.0.1 as fixed). Every Java version a current Spring Boot release
> targets is in the affected range, so make sure your JDK distribution is patched regardless of which Spring Boot
> line you're on. Java 8 and 11 are not affected.

## Spring Cloud &harr; Spring Boot

| Spring Cloud Release Train                                                                                  | Corresponding Spring Boot Version                                             |
| :---------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| [2026.0.x (Paddington)](https://github.com/spring-cloud/spring-cloud-release/releases/tag/v2026.0.0)        | Spring Boot 4.2.x                                                             |
| [2025.1.x (Oakwood)](https://spring.io/blog/2025/11/25/spring-cloud-2025-1-0-aka-oakwood-has-been-released) | [Spring Boot 4.0.x / 4.1.x](https://spring.io/blog/2026/06/10/spring-boot-4/) |
| [2025.0.x (Northfields)](https://spring.io/blog/2025/05/29/spring-cloud-2025-0-0-is-abvailable)             | Spring Boot 3.5.x                                                             |
| [2024.0.x (Moorgate)](https://spring.io/blog/2024/12/03/spring-cloud-2024-0-0)                              | Spring Boot 3.4.x                                                             |
| [2023.0.x (Leyton)](https://spring.io/blog/2023/12/06/spring-cloud-2023-0-0-aka-leyton-is-now-available)    | Spring Boot 3.2.x / 3.3.x                                                     |
| 2022.0.x (Kilburn)                                                                                          | Spring Boot 3.0.x / 3.1.x                                                     |
| 2021.0.x (Jubilee)                                                                                          | Spring Boot 2.6.x / 2.7.x                                                     |
| 2020.0.x (Ilford)                                                                                           | Spring Boot 2.4.x / 2.5.x                                                     |
| Hoxton                                                                                                      | Spring Boot 2.2.x / 2.3.x                                                     |
| Greenwich                                                                                                   | Spring Boot 2.1.x                                                             |
| Finchley                                                                                                    | Spring Boot 2.0.x                                                             |
| Edgware                                                                                                     | Spring Boot 1.5.x                                                             |

Don't mix trains and Boot versions arbitrarily; always confirm against the specific release train's docs.
**Spring Cloud 2026.0.0 (Paddington) reached
GA on November 20, 2026**, built alongside Spring Boot 4.2.0 and bundling 14 modules at version 5.1.0. Spring Cloud
Bus is gone as a standalone module in this train; its functionality has been folded into Spring Cloud Stream. The
prior train, **2025.1.x (Oakwood)**, also got a patch the same day: **2025.1.5** (November 20, 2026, bundling
Commons 5.0.5, Config 5.0.7, and Gateway 5.0.5, and still supporting Spring Boot 4.0.x/4.1.x). Upgrade to Paddington
once you've moved to Boot 4.2.x; stay on an updated Oakwood patch if you're still on 4.0.x or 4.1.x.

## Gradle &harr; Java

| Gradle Version | Latest Supported Java Version |
| :------------- | :---------------------------- |
| 9.8            | Java 27                       |
| 9.4            | Java 26                       |
| 9.1            | Java 25                       |
| 8.14           | Java 24                       |
| 8.10           | Java 23                       |
| 8.8            | Java 22                       |
| 8.5            | Java 21                       |
| 8.3            | Java 20                       |
| 7.6            | Java 19                       |
| 7.5            | Java 18                       |
| 7.3            | Java 17                       |
| 7.0            | Java 16                       |
| 6.7            | Java 15                       |

Shows the Gradle version that _first_ added support for running on each Java release. Gradle 9.8 added full Java 27
support for both toolchains and the daemon, so Gradle itself now runs on Java 17&ndash;27; JVM 28 isn't supported yet
(note: Gradle isn't tested on macOS `AMD64` with Java 27+). **Gradle 9.9.0 GA'd November 6, 2026**, headlined by
incremental compilation for Kotlin DSL scripts via the Kotlin Build Tools API (up to 65% faster script recompilation
after a `buildSrc` or included-build change in large multi-project builds), plus test filtering for non-method JUnit
Platform tests (ArchUnit rules, Spek scopes) and predefined Problems API groups. Two patches followed fast: **9.9.1**
(November 10, 2026, three security fixes) and **9.9.2** (November 19, 2026, four more security fixes, including an
SFTP repository host-key-verification bypass and a daemon registry briefly readable by other local users, plus a
regression fix for plugin resolution against repositories that return 401 for the plugin marker jar). Run **9.9.2**;
don't stay on 9.9.0 or 9.9.1. You can still compile/test against newer JDKs via toolchains while running Gradle
itself on an older supported JVM. Source:
[Gradle compatibility docs](https://docs.gradle.org/current/userguide/compatibility.html).

---

Disclaimer: Version compatibility changes over time. Always confirm against the official Gradle, Spring Boot, and Spring
Cloud documentation for your project.
