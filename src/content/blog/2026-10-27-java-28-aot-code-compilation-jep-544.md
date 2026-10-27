---
author: StevenPG
pubDatetime: 2026-10-27T23:00:00.000Z
title: "Java 28 AOT Code Compilation (JEP 544): Is the JIT Warmup Tax Finally Dead?"
slug: java-28-aot-code-compilation-jep-544
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - performance
  - graalvm
  - spring boot
description: "JEP 544 in Java 28 stores JIT-compiled native code in the AOT cache. I measured it on Spring Boot, a CLI and a CPU-bound batch job against JDK 25-27 caches and GraalVM native image: startup, warmup curves, bad training runs and every GC."
---

## Table of Contents

[[toc]]

# The warmup tax

Every JVM pays two bills before your code runs at full speed. The first is
**startup**: load, verify and link thousands of classes, run static
initializers, build the framework's object graph. The second is **warmup**: the
code starts out interpreted, the JVM watches which methods are hot, and C1 and
then C2 compile them in the background, on the same CPUs your application is
trying to use.

Project Leyden has been chipping away at the first bill for three releases:

| JDK | JEP | What the AOT cache stores |
|---|---|---|
| 24 | [483: AOT Class Loading & Linking](https://openjdk.org/jeps/483) | classes, already loaded and linked |
| 25 | [514: AOT Command-Line Ergonomics](https://openjdk.org/jeps/514) | (one-step `-XX:AOTCacheOutput` workflow) |
| 25 | [515: AOT Method Profiling](https://openjdk.org/jeps/515) | method profiles, so C2 can start early |
| 26 | [516: AOT Object Caching with Any GC](https://openjdk.org/jeps/516) | heap objects, now for every collector including ZGC |
| **28** | **[544: Ahead-of-Time Code Compilation](https://openjdk.org/jeps/544)** | **compiled native code** |

JEP 544 goes after the second bill. The training run now saves the **machine
code** the JIT produced, and the production run starts executing it
immediately instead of interpreting while the compilers catch up.

That's the piece GraalVM native image always had and the JVM didn't. So the
question for this post is simple: with JEP 544, is the JIT warmup tax finally
gone, and how much of native image's advantage is left?

I built three sample apps, ran about TODO hours of benchmarks on a 4-core x64
cloud VM and JDK 28 early-access build 21, and measured everything below. No
number in this post is estimated. The whole harness is in
[DemosAndArticleContent/blog/java-28-aot-code-compilation](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/java-28-aot-code-compilation).

TODO: TL;DR box with the headline numbers

# What JEP 544 actually adds

JEP 544 is integrated in JDK 28, which is scheduled for GA in March 2027. It
doesn't add a new workflow. You use the same two steps as JDK 25 and 26:

```bash
# 1. Training run: run a representative workload, the cache is written at exit
java -XX:AOTCacheOutput=app.aot -jar app.jar

# 2. Production run
java -XX:AOTCache=app.aot -jar app.jar
```

On JDK 28 step 1 now also compiles the methods the training run found hot and
stores the code in the cache. There is no flag to turn it on. A cache built by
JDK 28 contains code unless you train with
`-XX:+UnlockDiagnosticVMOptions -XX:-AOTCodeCaching`.

A few properties from the JEP that matter in practice:

- **AOT code and JIT code mix freely.** There's no AOT-only mode. If production
  hits code the training run never saw, or an assumption baked into the AOT
  code stops holding, HotSpot deoptimizes and the JIT compiles fresh code like
  it always has. Your application can't tell the difference.
- **No application changes and no tuning flags.** Same jar, same code.
- **All collectors.** Serial, Parallel, G1, Shenandoah and ZGC are supported,
  but the production GC must be the one you trained with.
- **No cross-compilation.** The code is for the CPU architecture *and the CPU
  features* of the training machine. x64 and AArch64 only for now.

## Seeing it work

`-XX:+PrintCompilation` marks every method whose code came from the cache with
an `A`, and `AP` for code that was preloaded at startup:

```text
37  169      A  4       java.lang.Byte::toUnsignedInt (6 bytes)
38  170      AP 4       java.lang.Object::<init> (1 bytes)
38  171      AP 4       jdk.internal.util.ArraysSupport::unsignedHashCode (36 bytes)
38  176      AP 4       java.util.HashMap::hash (20 bytes)
```

The `4` is the compilation tier: that's C2-optimized code at 37 milliseconds
into the run, before the application had a chance to warm anything up.
`-Xlog:aot` reports the code region being mapped:

```text
[0.045s][info][aot] Mapped static  region #4 at base 0x00007fc761eec000 top 0x00007fc764000000 (Code)
[0.046s][info][aot] Mapped 34571400 bytes at address 0x00007fc761eec010 from AOT Code Cache
[0.046s][info][aot] Loaded 12379 AOT code entries from AOT Code Cache
```

One trap I fell into: that last line is **not** proof the code is used. It
prints even when AOT code is disabled, because the region is still mapped and
indexed. Count the `A` lines instead. My harness refuses to benchmark any
configuration until it has seen them.

TODO: rest of the post
