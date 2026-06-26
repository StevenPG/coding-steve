---
title: Java Version Guide
description: What's new in each Java release from 8 onward, with LTS versions marked and links to release notes.
slug: java-version-guide
pubDatetime: 2026-06-26T12:00:00.000Z
modDatetime: 2026-06-26T12:00:00.000Z
tags:
  - java
order: 1
---

A scannable "what's new" for every Java feature release since Java 8. Since Java 9, a new feature release ships every
**six months** (March and September). **LTS** (Long-Term Support) releases &mdash; the ones most teams standardize on
&mdash; now arrive every **two years** (17, 21, 25); earlier they were three years apart (8, 11, 17).

Version numbers link to the official OpenJDK release page where available. For the full feature list of any release, see
the [JEP index](https://openjdk.org/jeps/0).

## Release History

| Version                                          | Released | LTS         | Headline Features                                                                                                  |
| :----------------------------------------------- | :------- | :---------- | :---------------------------------------------------------------------------------------------------------------- |
| [25](https://openjdk.org/projects/jdk/25/)       | Sep 2025 | ✅ **LTS**  | Flexible constructor bodies, module import declarations, compact source files & instance `main`, scoped values    |
| [24](https://openjdk.org/projects/jdk/24/)       | Mar 2025 | —           | Stream Gatherers (standard), Class-File API, quantum-resistant crypto (ML-KEM/ML-DSA), ahead-of-time class loading |
| [23](https://openjdk.org/projects/jdk/23/)       | Sep 2024 | —           | Markdown in Javadoc, generational ZGC by default, primitive types in patterns (preview)                           |
| [22](https://openjdk.org/projects/jdk/22/)       | Mar 2024 | —           | **Foreign Function & Memory API** (standard), unnamed variables & patterns, multi-file source programs            |
| [21](https://openjdk.org/projects/jdk/21/)       | Sep 2023 | ✅ **LTS**  | **Virtual threads** (standard), record patterns, pattern matching for `switch`, sequenced collections             |
| [20](https://openjdk.org/projects/jdk/20/)       | Mar 2023 | —           | Second previews of virtual threads, record patterns, scoped values                                                |
| [19](https://openjdk.org/projects/jdk/19/)       | Sep 2022 | —           | Virtual threads (preview), structured concurrency (incubator), record patterns (preview)                          |
| [18](https://openjdk.org/projects/jdk/18/)       | Mar 2022 | —           | UTF-8 as the default charset, simple web server (`jwebserver`), code snippets in Javadoc                          |
| [17](https://openjdk.org/projects/jdk/17/)       | Sep 2021 | ✅ **LTS**  | **Sealed classes** (standard), new macOS/Metal rendering pipeline, strong encapsulation of JDK internals          |
| [16](https://openjdk.org/projects/jdk/16/)       | Mar 2021 | —           | **Records** (standard), pattern matching for `instanceof` (standard), `Stream.toList()`, Unix-domain sockets      |
| [15](https://openjdk.org/projects/jdk/15/)       | Sep 2020 | —           | **Text blocks** (standard), sealed classes (preview), ZGC & Shenandoah production-ready                            |
| [14](https://openjdk.org/projects/jdk/14/)       | Mar 2020 | —           | Records (preview), pattern matching for `instanceof` (preview), switch expressions (standard), helpful NPEs       |
| [13](https://openjdk.org/projects/jdk/13/)       | Sep 2019 | —           | Text blocks (preview), switch expressions (2nd preview), dynamic CDS archives                                     |
| [12](https://openjdk.org/projects/jdk/12/)       | Mar 2019 | —           | Switch expressions (preview), Shenandoah GC (experimental), compact number formatting                            |
| [11](https://openjdk.org/projects/jdk/11/)       | Sep 2018 | ✅ **LTS**  | Standardized **HTTP Client**, `var` in lambdas, single-file source launch, Flight Recorder, new `String` methods  |
| [10](https://openjdk.org/projects/jdk/10/)       | Mar 2018 | —           | **`var`** local-variable type inference, application class-data sharing, parallel full GC for G1                   |
| [9](https://openjdk.org/projects/jdk/9/)         | Sep 2017 | —           | **Module system (JPMS)**, JShell, collection factory methods (`List.of`), private interface methods               |
| [8](https://www.oracle.com/java/technologies/javase/8-whats-new.html) | Mar 2014 | ✅ **LTS** | **Lambdas**, **Stream API**, `java.time`, default methods, `Optional`                                  |

> **Java 26** is the next feature release, targeted for **March 2026**. It is non-LTS; the next LTS is **Java 27**
> (September 2027). Check the [OpenJDK JDK project page](https://openjdk.org/projects/jdk/) for its finalized JEPs.

## How Java Support Works

- **Feature releases** ship every 6 months; each is supported only until the next one unless it's an LTS.
- **LTS releases** (8, 11, 17, 21, 25, …) receive years of updates from Oracle and OpenJDK distributors (Adoptium /
  Eclipse Temurin, Amazon Corretto, Azul Zulu, Microsoft, Red Hat, etc.). Most production systems run the latest LTS.
- **Previews & incubators** are off by default and require `--enable-preview`. They can change or be removed before
  standardization &mdash; don't ship them to production.

## Sources

- [OpenJDK JDK projects](https://openjdk.org/projects/jdk/) &mdash; per-release JEP lists
- [JEP index](https://openjdk.org/jeps/0) &mdash; every JDK Enhancement Proposal
- [endoflife.date/java](https://endoflife.date/java) &mdash; support and EOL timelines
