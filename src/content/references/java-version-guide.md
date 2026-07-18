---
title: Java Version Guide
description: What's new in each Java release from 8 onward, with LTS versions marked and links to release notes.
slug: java-version-guide
pubDatetime: 2026-06-26T12:00:00.000Z
modDatetime: 2026-07-18T12:00:00.000Z
tags:
  - java
order: 1
---

A "what's new" for every Java feature release since Java 8. Since Java 9, a feature release ships every **six months**
(March and September). **LTS** (Long-Term Support) releases &mdash; the ones most teams standardize on &mdash; now
arrive every **two years**; earlier they were three years apart.

**LTS line:** 8 &middot; 11 &middot; 17 &middot; 21 &middot; 25 (next: **29** in September 2027, per
[Oracle's roadmap](https://www.oracle.com/java/technologies/java-se-support-roadmap.html)). Expand any release below for its
highlights and a link to the release notes. For the complete picture of any version, see the
[JEP index](https://openjdk.org/jeps/0).

## Releases

<details class="ref-box" open>
<summary><span class="ref-box-title">Java 26</span><span class="ref-box-date">Mar 2026</span></summary>

- **HTTP/3 for the HTTP Client API** — talk to HTTP/3 servers with minimal code change ([JEP 517](https://openjdk.org/jeps/517))
- **Ahead-of-time object caching with any GC** — Project Leyden's AOT cache now works with ZGC and friends ([JEP 516](https://openjdk.org/jeps/516))
- **G1 throughput boost** — dual card tables cut synchronization; 5–15% gains for write-heavy apps ([JEP 522](https://openjdk.org/jeps/522))
- **Warnings for deep-reflection mutation of final fields** — first step toward making `final` really mean final ([JEP 500](https://openjdk.org/jeps/500))
- The **Applet API is gone** at last ([JEP 504](https://openjdk.org/jeps/504))
- Still in preview/incubator: lazy constants (formerly stable values, [JEP 526](https://openjdk.org/jeps/526)), structured concurrency ([JEP 525](https://openjdk.org/jeps/525)), primitive types in patterns ([JEP 530](https://openjdk.org/jeps/530)), PEM encodings ([JEP 524](https://openjdk.org/jeps/524)), Vector API ([JEP 529](https://openjdk.org/jeps/529))

[Release notes →](https://openjdk.org/projects/jdk/26/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 25</span><span class="ref-box-date">Sep 2025</span><span class="ref-box-lts">LTS</span></summary>

- **Flexible constructor bodies** — run statements before `this()`/`super()` ([JEP 513](https://openjdk.org/jeps/513))
- **Module import declarations** — `import module M` to pull in a module's exported packages ([JEP 511](https://openjdk.org/jeps/511))
- **Compact source files & instance `main` methods** — much smaller "hello world", great for learning ([JEP 512](https://openjdk.org/jeps/512))
- **Scoped values** standardized — a safer, immutable alternative to thread-locals ([JEP 506](https://openjdk.org/jeps/506))
- Still in preview: primitive types in patterns, structured concurrency, stable values

[Release notes →](https://openjdk.org/projects/jdk/25/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 24</span><span class="ref-box-date">Mar 2025</span></summary>

- **Stream Gatherers** standardized — custom intermediate stream operations ([JEP 485](https://openjdk.org/jeps/485))
- **Class-File API** standardized — parse/generate `.class` files without ASM ([JEP 484](https://openjdk.org/jeps/484))
- Quantum-resistant cryptography: ML-KEM ([JEP 496](https://openjdk.org/jeps/496)) and ML-DSA ([JEP 497](https://openjdk.org/jeps/497))
- **Ahead-of-time class loading & linking** — faster startup, part of Project Leyden ([JEP 483](https://openjdk.org/jeps/483))
- Compact object headers (experimental); the Security Manager is now permanently disabled

[Release notes →](https://openjdk.org/projects/jdk/24/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 23</span><span class="ref-box-date">Sep 2024</span></summary>

- **Markdown in Javadoc** — write doc comments in Markdown ([JEP 467](https://openjdk.org/jeps/467))
- Generational ZGC becomes the default mode ([JEP 474](https://openjdk.org/jeps/474))
- Primitive types in patterns, `instanceof`, and `switch` (preview)

[Release notes →](https://openjdk.org/projects/jdk/23/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 22</span><span class="ref-box-date">Mar 2024</span></summary>

- **Foreign Function & Memory API** standardized — call native code and manage off-heap memory, no JNI ([JEP 454](https://openjdk.org/jeps/454))
- **Unnamed variables & patterns** (`_`) standardized ([JEP 456](https://openjdk.org/jeps/456))
- Multi-file source-code programs via `java` launcher; statements before `super()` (preview)

[Release notes →](https://openjdk.org/projects/jdk/22/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 21</span><span class="ref-box-date">Sep 2023</span><span class="ref-box-lts">LTS</span></summary>

- **Virtual threads** standardized — cheap, massively scalable concurrency ([JEP 444](https://openjdk.org/jeps/444))
- **Record patterns** standardized — destructure records in `switch`/`instanceof` ([JEP 440](https://openjdk.org/jeps/440))
- **Pattern matching for `switch`** standardized ([JEP 441](https://openjdk.org/jeps/441))
- **Sequenced collections** — uniform first/last access ([JEP 431](https://openjdk.org/jeps/431))
- Generational ZGC; string templates & unnamed patterns (preview)

[Release notes →](https://openjdk.org/projects/jdk/21/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 20</span><span class="ref-box-date">Mar 2023</span></summary>

- Second previews of virtual threads, record patterns, and pattern matching for `switch`
- Scoped values (incubator)

[Release notes →](https://openjdk.org/projects/jdk/20/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 19</span><span class="ref-box-date">Sep 2022</span></summary>

- Virtual threads (preview) and structured concurrency (incubator) debut
- Record patterns (preview); pattern matching for `switch` (preview); FFM API (preview)

[Release notes →](https://openjdk.org/projects/jdk/19/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 18</span><span class="ref-box-date">Mar 2022</span></summary>

- **UTF-8 as the default charset** everywhere ([JEP 400](https://openjdk.org/jeps/400))
- Simple web server (`jwebserver`) for quick static hosting; code snippets in Javadoc

[Release notes →](https://openjdk.org/projects/jdk/18/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 17</span><span class="ref-box-date">Sep 2021</span><span class="ref-box-lts">LTS</span></summary>

- **Sealed classes** standardized — restrict which types can extend/implement ([JEP 409](https://openjdk.org/jeps/409))
- New macOS rendering pipeline (Metal); strong encapsulation of JDK internals
- The long-time baseline for Spring Boot 3.x and much of the modern ecosystem

[Release notes →](https://openjdk.org/projects/jdk/17/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 16</span><span class="ref-box-date">Mar 2021</span></summary>

- **Records** standardized ([JEP 395](https://openjdk.org/jeps/395)); **pattern matching for `instanceof`** standardized ([JEP 394](https://openjdk.org/jeps/394))
- `Stream.toList()`, Unix-domain socket channels, Vector API (incubator)

[Release notes →](https://openjdk.org/projects/jdk/16/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 15</span><span class="ref-box-date">Sep 2020</span></summary>

- **Text blocks** standardized — multi-line string literals ([JEP 378](https://openjdk.org/jeps/378))
- Sealed classes (preview); ZGC and Shenandoah become production-ready

[Release notes →](https://openjdk.org/projects/jdk/15/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 14</span><span class="ref-box-date">Mar 2020</span></summary>

- Records and pattern matching for `instanceof` debut (preview)
- **Switch expressions** standardized ([JEP 361](https://openjdk.org/jeps/361)); helpful `NullPointerException` messages

[Release notes →](https://openjdk.org/projects/jdk/14/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 13</span><span class="ref-box-date">Sep 2019</span></summary>

- Text blocks (preview); switch expressions (second preview)
- Dynamic CDS archives

[Release notes →](https://openjdk.org/projects/jdk/13/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 12</span><span class="ref-box-date">Mar 2019</span></summary>

- Switch expressions (preview); Shenandoah GC (experimental)
- Compact number formatting

[Release notes →](https://openjdk.org/projects/jdk/12/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 11</span><span class="ref-box-date">Sep 2018</span><span class="ref-box-lts">LTS</span></summary>

- **Standardized HTTP Client** (`java.net.http`) with HTTP/2 and WebSocket ([JEP 321](https://openjdk.org/jeps/321))
- `var` allowed in lambda parameters; run a single source file directly (`java Foo.java`)
- Flight Recorder open-sourced; new `String` methods (`isBlank`, `strip`, `lines`, `repeat`)

[Release notes →](https://openjdk.org/projects/jdk/11/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 10</span><span class="ref-box-date">Mar 2018</span></summary>

- **`var`** — local-variable type inference ([JEP 286](https://openjdk.org/jeps/286))
- Application class-data sharing; parallel full GC for G1

[Release notes →](https://openjdk.org/projects/jdk/10/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 9</span><span class="ref-box-date">Sep 2017</span></summary>

- **Module system (JPMS / Project Jigsaw)** ([JEP 261](https://openjdk.org/jeps/261))
- JShell (the REPL); collection factory methods (`List.of`, `Map.of`); private interface methods

[Release notes →](https://openjdk.org/projects/jdk/9/)

</details>

<details class="ref-box">
<summary><span class="ref-box-title">Java 8</span><span class="ref-box-date">Mar 2014</span><span class="ref-box-lts">LTS</span></summary>

- **Lambda expressions** and the **Stream API** — the biggest language shift in Java's history
- The `java.time` (JSR-310) date/time API; default methods on interfaces; `Optional`
- Still widely deployed; the last LTS before the modular era

[What's new in Java 8 →](https://www.oracle.com/java/technologies/javase/8-whats-new.html)

</details>

> **Java 27** (non-LTS) is the next feature release, due **September 2026**. As of mid-July 2026 its feature set is
> frozen (Rampdown Phase One began June 4) at nine JEPs. The headliners: **compact object headers on by default**
> ([JEP 534](https://openjdk.org/jeps/534)), **G1 as the default GC in all environments** ([JEP 523](https://openjdk.org/jeps/523)),
> **post-quantum hybrid key exchange for TLS 1.3** ([JEP 527](https://openjdk.org/jeps/527)), and **JFR in-process data
> redaction** ([JEP 536](https://openjdk.org/jeps/536)). The rest are re-runs: lazy constants
> ([JEP 531](https://openjdk.org/jeps/531)), primitive type patterns ([JEP 532](https://openjdk.org/jeps/532)),
> structured concurrency ([JEP 533](https://openjdk.org/jeps/533)), PEM encodings ([JEP 538](https://openjdk.org/jeps/538)),
> and a twelfth Vector API incubation ([JEP 537](https://openjdk.org/jeps/537)). See the
> [JDK 27 project page](https://openjdk.org/projects/jdk/27/) for the latest.

## How Java Support Works

- **Feature releases** ship every 6 months; each is supported only until the next one unless it's an LTS.
- **LTS releases** (8, 11, 17, 21, 25, …) receive years of updates from OpenJDK distributors &mdash; Adoptium / Eclipse
  Temurin, Amazon Corretto, Azul Zulu, Microsoft, Red Hat, and others. Most production systems run the latest LTS.
- **Previews & incubators** are off by default and require `--enable-preview`. They can change or be removed before
  standardization &mdash; don't ship them to production.

## Sources

- [OpenJDK JDK projects](https://openjdk.org/projects/jdk/) &mdash; per-release JEP lists
- [JEP index](https://openjdk.org/jeps/0) &mdash; every JDK Enhancement Proposal
- [endoflife.date/java](https://endoflife.date/java) &mdash; support and EOL timelines
