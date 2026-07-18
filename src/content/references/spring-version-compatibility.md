---
title: Spring Version Compatibility Cheatsheet
description: A continuously updated reference for aligning Java, Gradle, Spring Boot, and Spring Cloud versions.
slug: spring-version-compatibility
pubDatetime: 2025-05-04T12:00:00.000Z
modDatetime: 2026-07-18T12:00:00.000Z
tags:
  - gradle
  - java
  - spring
order: 0
---

Quick lookup tables for aligning your JDK, Gradle, Spring Boot, and Spring Cloud versions. Kept current as new versions
ship &mdash; bookmark it. For the official, authoritative matrix, see Spring's
[Support Mapping](https://spring.io/projects/generations).

**Jump to:** [Spring Boot &harr; Java](#spring-boot--java) &middot;
[Spring Cloud &harr; Spring Boot](#spring-cloud--spring-boot) &middot;
[Gradle &harr; Java](#gradle--java)

## Spring Boot &harr; Java

| Spring Boot Version | Compatible Java Versions (Min - Max Targeted) |
| :------------------ | :-------------------------------------------- |
| 4.1.x               | Java 17 - 26                                  |
| 4.0.x               | Java 17 - 25                                  |
| 3.5.x               | Java 17 - 25                                  |
| 3.4.x               | Java 17 - 25                                  |
| 3.3.x               | Java 17 - 25                                  |
| 3.0.x - 3.2.x       | Java 17 - 21                                  |
| 2.7.x               | Java 8 - 21                                   |
| 2.6.x               | Java 8 - 19                                   |
| 2.5.x               | Java 8 - 18                                   |
| 2.4.x               | Java 8 - 16                                   |
| 2.2.x - 2.3.x       | Java 8 - 15                                   |
| 2.1.x               | Java 8 - 12                                   |
| 2.0.x               | Java 8 - 9                                    |
| 1.5.x               | Java 6 - 8                                    |

Spring Boot 4.x and 3.x baseline on Java 17. As of July 2026, only **4.1.x** (released June 2026) and **4.0.x** are in
open-source support &mdash; **3.5.x reached OSS end-of-life on June 30, 2026** (commercial support continues). Source:
[endoflife.date](https://endoflife.date/spring-boot#java-compatibility).

## Spring Cloud &harr; Spring Boot

| Spring Cloud Release Train                                                                                  | Corresponding Spring Boot Version                                             |
| :---------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
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

Don't mix trains and Boot versions arbitrarily &mdash; always confirm against the specific release train's docs. As of
July 2026 the current train is **Oakwood** (latest patch:
[2025.1.2](https://spring.io/blog/2026/06/11/spring-cloud-2025-1-2-aka-oakwood-has-been-released/), June 2026, adding
Spring Boot 4.1 compatibility); the next train, codenamed **Paddington**, will track Spring Boot 4.2.

## Gradle &harr; Java

| Gradle Version | Latest Supported Java Version |
| :------------- | :---------------------------- |
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

Shows the Gradle version that _first_ added support for running on each Java release (latest is Gradle 9.6.1, July
2026). As of July 2026 no Gradle release runs on Java 27 yet &mdash; you can still compile/test against newer JDKs via
toolchains while running Gradle itself on Java 17&ndash;26. Source:
[Gradle compatibility docs](https://docs.gradle.org/current/userguide/compatibility.html).

---

Disclaimer: Version compatibility changes over time. Always confirm against the official Gradle, Spring Boot, and Spring
Cloud documentation for your project.
