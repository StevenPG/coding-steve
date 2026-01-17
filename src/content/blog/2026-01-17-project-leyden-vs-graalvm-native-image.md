---
author: StevenPG
pubDatetime: 2026-01-17T12:00:00.000Z
title: Project Leyden vs GraalVM Native Image - A Complete Guide
slug: project-leyden-vs-graalvm-native-image
featured: true
ogImage: /assets/default-og-image.png
tags:
  - java
  - graalvm
  - performance
  - spring boot
description: A comprehensive comparison of Project Leyden and GraalVM Native Image for Java developers deciding how to optimize startup time and memory footprint.
---

## Table of Contents

[[toc]]

# Brief

Java's startup time and memory footprint have been pain points since the language's inception. Two major approaches have emerged to solve this: **GraalVM Native Image** and **Project Leyden**. Both aim to make Java applications start faster and use less memory, but they take fundamentally different approaches.

This post explains both technologies, their histories, how they work, and most importantly—when you should choose one over the other.

# The TL;DR Comparison

Before diving deep, here's a quick comparison for those who need a decision now:

| Aspect | GraalVM Native Image | Project Leyden |
|--------|---------------------|----------------|
| **Approach** | Full AOT compilation to native binary | AOT optimization within the JVM |
| **Java Compatibility** | Closed-world; requires configuration for dynamic features | Full compatibility with all Java features |
| **Startup Time** | Milliseconds (fastest possible) | 40-60% improvement over baseline JVM |
| **Peak Performance** | Often lower than JVM (no JIT at runtime) | Matches or exceeds JVM (JIT still available) |
| **Memory Footprint** | 30-50% less than JVM | Improved, but still runs on JVM |
| **Build Complexity** | High (resource-intensive, requires metadata) | Low (standard JVM tooling) |
| **Maturity** | Production-ready since 2019 | JEPs shipping since JDK 24 (2025) |
| **Best For** | Serverless, CLI tools, containers with strict limits | General Java applications, Spring Boot, microservices |

# GraalVM Native Image

## The History

GraalVM's story begins at Sun Microsystems Laboratories (now Oracle Labs) with the Maxine Virtual Machine project. The goal was ambitious: write a Java virtual machine in Java itself to avoid the problems of developing in C++ and benefit from meta-circular optimizations.

The timeline looks like this:

- **2011**: The GraalVM project began at Oracle Labs, focusing on a new high-performance JIT compiler called Graal
- **2014**: First public release of the Graal compiler targeting researchers and early adopters
- **September 2016**: Oracle announced plans to add ahead-of-time compilation to OpenJDK (JEP 295)
- **2017**: Starting with GraalVM 0.20, they began shipping a new virtual machine and ahead-of-time compiler
- **April 2018**: Oracle announced GraalVM 1.0, including Native Image capability
- **May 2019**: GraalVM 19.0 became the first production-ready release

The Native Image technology is built on what Oracle Labs internally called "Substrate VM"—a runtime designed to execute Java code compiled ahead-of-time into native binaries.

## How It Works

GraalVM Native Image takes a fundamentally different approach than the traditional JVM. Instead of interpreting bytecode and JIT-compiling hot paths at runtime, it compiles your entire application to a native executable at build time.

The process involves:

1. **Points-to Analysis**: The compiler analyzes your code to determine which classes, methods, and fields are reachable from the entry point
2. **Ahead-of-Time Compilation**: All reachable code is compiled to native machine code
3. **Static Initialization**: Some initializations can be performed at build time and "baked into" the binary
4. **Bundling**: The resulting binary includes a minimal runtime (Substrate VM) and your application code

The key concept here is the **closed-world assumption**: the compiler must know about all classes and methods at build time. This enables aggressive optimizations but creates challenges with Java's dynamic features.

```bash
# Basic native image build
native-image -jar my-app.jar

# With Spring Boot (using the Gradle plugin)
./gradlew nativeCompile
```

## The Closed-World Trade-off

The closed-world assumption is both GraalVM Native Image's greatest strength and its biggest limitation. Because the compiler knows exactly what code will run, it can:

- Remove unused code (dead code elimination)
- Inline aggressively
- Eliminate runtime class loading overhead
- Create optimized data structures

However, this means features that rely on runtime dynamism require special handling:

- **Reflection**: Must be declared in `reflect-config.json` or via annotations
- **Resources**: Must be explicitly included in `resource-config.json`
- **Proxies**: Dynamic proxies must be declared in `proxy-config.json`
- **Serialization**: Requires `serialization-config.json`

For Spring Boot applications, frameworks like Spring Native (now integrated into Spring Boot 3+) generate these configurations automatically for most cases. But custom reflection or dynamic class loading still requires manual configuration.

## Production Realities

GraalVM Native Image is production-ready, with significant adoption from frameworks like Spring Boot, Quarkus, and Micronaut. However, there are practical considerations:

**Build Requirements**:
- Native image builds are resource-intensive (4+ GB RAM, multiple CPUs recommended)
- Build times are significantly longer than JVM compilation
- GitHub Actions runners often require larger self-hosted runners

**Runtime Characteristics**:
- Startup times can be as low as a few milliseconds
- Memory usage is typically 30-50% lower than equivalent JVM applications
- Peak throughput may be lower than a fully warmed-up JVM (no runtime profiling and optimization)

**Debugging and Observability**:
- Traditional Java profilers don't work with native images
- Stack traces may differ from JVM behavior
- Some monitoring tools require native-image-specific instrumentation

# Project Leyden

## The History

Project Leyden was [announced by Mark Reinhold in May 2020](https://www.infoq.com/news/2020/05/java-leyden/) as a response to the growing pressure on Java's startup time, particularly in cloud-native environments. The project takes its name from the Leyden jar—one of the original devices for storing electrical energy—symbolizing the goal of "storing" computational work for later use.

The project's stated goal is direct: "improve the startup time, time to peak performance, and footprint of Java programs."

Unlike GraalVM Native Image, which creates a separate compilation path, Leyden works within the existing JVM infrastructure, building on technologies like Class Data Sharing (CDS) and the existing HotSpot JIT compiler.

## The Condenser Model

Project Leyden introduces a concept called **condensers**—specialized transformers that execute in sequence to optimize application code before or during execution. Think of it as a pipeline of optimization stages:

1. **Source Code** → Condenser 1 → Condenser 2 → ... → **Optimized Runtime**

Each condenser can perform transformations that "shift" work from runtime to an earlier phase. The key insight is that many computations performed at startup are deterministic and could be done once and cached.

The CDS and AOT caches are part of a "terminal stage" of this condenser pipeline, generated with standard `java` commands rather than requiring specialized tooling.

## JEPs and Current Status

Project Leyden has been delivering features incrementally through JDK Enhancement Proposals (JEPs):

**Delivered:**
- **JEP 483: Ahead-of-Time Class Loading & Linking** (JDK 24) - Classes can be loaded and linked at build time, ready for immediate use at startup
- **JEP 514: Ahead-of-Time Command-Line Ergonomics** (JDK 25) - Simplified command-line interface for AOT features
- **JEP 515: Ahead-of-Time Method Profiling** (JDK 25) - Method profiles from training runs stored for faster JIT warmup

**In Progress:**
- **JEP 516: Ahead-of-Time Object Caching** - Cache heap objects created during training runs
- **Ahead-of-Time Code Compilation** - Pre-compile hot methods to native code

## How It Works

Leyden uses a **training run** approach. You run your application once in a special mode that records:

- Which classes are loaded and in what order
- Method profiles (what code paths are hot)
- Which objects are created during startup

This information is stored in an **AOT cache** that subsequent runs can use to skip work:

```bash
# JDK 24: Two-step process
# Step 1: Training run to record configuration
java -XX:AOTMode=record -XX:AOTConfiguration=app.aotconf -jar my-app.jar

# Step 2: Create the cache from the configuration
java -XX:AOTMode=create -XX:AOTConfiguration=app.aotconf -XX:AOTCache=app.aot

# Production run with the cache
java -XX:AOTCache=app.aot -jar my-app.jar
```

JDK 25 simplifies this with JEP 514 (AOT Command-Line Ergonomics):

```bash
# JDK 25+: One-step cache creation
java -XX:AOTCacheOutput=app.aot -jar my-app.jar

# Production run (same as JDK 24)
java -XX:AOTCache=app.aot -jar my-app.jar
```

The important distinction from GraalVM: anything not captured in the training run falls back to regular JIT processing. This preserves full Java compatibility—if your application dynamically loads a class that wasn't seen during training, it still works; it just won't get the AOT optimization for that class.

## Performance Results

JEP 483 alone shows significant improvements. For Spring PetClinic (a representative Spring Boot application loading ~21,000 classes):

- **JDK 23**: 4.486 seconds startup
- **JDK 24 with AOT cache**: 2.604 seconds startup
- **Improvement**: 42%

The InfoQ coverage of JDK 24's release reported [40% faster startup](https://www.infoq.com/news/2025/03/java-24-leyden-ships/) for applications using the new AOT class loading features.

# Key Differences Explained

## Philosophy: Closed World vs. Open World

This is the fundamental architectural difference.

**GraalVM Native Image** uses a closed-world assumption. At build time, the compiler determines exactly what code can possibly run. Anything not visible at build time cannot be used at runtime. This enables maximum optimization but requires all dynamic behavior to be declared upfront.

**Project Leyden** maintains an open-world model. Training runs capture common paths and optimize them, but the full JVM is still available at runtime. Unexpected code paths work—they just don't get the AOT benefits.

This difference has profound implications:

| Scenario | GraalVM Native Image | Project Leyden |
|----------|---------------------|----------------|
| Undeclared reflection | Fails at runtime | Works (no AOT optimization) |
| Dynamic class loading | Not supported | Works (falls back to JIT) |
| Runtime bytecode generation | Not supported | Works (standard JVM) |
| Changing startup behavior | Requires rebuild | Retrain for optimization |

## Startup vs. Peak Performance

GraalVM Native Image wins on startup time. There's no JVM to boot, no bytecode to interpret, no classes to load. The application is running native code immediately.

However, Project Leyden (and JVM in general) typically achieves higher peak throughput. The JIT compiler can optimize based on actual runtime behavior, including optimizations that aren't possible with static analysis:

- Speculative optimizations based on observed type profiles
- Deoptimization and recompilation when assumptions change
- Runtime inlining decisions based on call frequencies

With Leyden's ahead-of-time method profiling (JEP 515), the JIT can begin compiling with good profile data immediately, reducing time to peak performance without sacrificing the JIT's adaptive optimization capabilities.

## Build and Deploy Complexity

**GraalVM Native Image** has higher build complexity:
- Resource-intensive builds (4GB+ RAM, extended build times)
- Requires metadata configuration for dynamic features
- Platform-specific binaries (build on Linux to deploy on Linux)
- Framework support required (Spring Native, Quarkus extensions)

**Project Leyden** uses standard JVM tooling:
- Training runs use the same `java` command
- AOT cache is portable between runs (same JDK, OS, architecture)
- No special framework integration required
- Works with any Java application

## Framework Support

Both approaches have strong framework support, but in different ways:

**GraalVM Native Image**:
- Spring Boot 3+ has built-in native image support
- Quarkus was designed with native image as a first-class target
- Micronaut uses compile-time dependency injection to avoid runtime reflection
- Extensive reachability metadata repository maintained by the community

**Project Leyden**:
- Works with any Java application without modification
- Spring Boot applications see significant benefits due to heavy class loading at startup
- No framework-specific integration required
- Benefits increase with JDK version as more JEPs are delivered

# When to Choose Each

## Choose GraalVM Native Image When:

1. **Startup time is critical and measured in milliseconds**
   - Serverless functions (AWS Lambda, Azure Functions, Google Cloud Functions)
   - CLI tools that should feel instant
   - Autoscaling applications that need to respond to load spikes immediately

2. **Memory is strictly constrained**
   - Small Kubernetes pod limits (128MB-512MB)
   - Edge computing or embedded systems
   - Cost optimization in cloud environments where memory is billed

3. **You control the entire deployment environment**
   - You can test thoroughly before production
   - You can rebuild when dependencies change
   - Your team is comfortable with native image constraints

4. **Your application has limited dynamic behavior**
   - Well-defined startup paths
   - Minimal use of reflection (or reflection use is predictable)
   - No runtime bytecode generation

## Choose Project Leyden When:

1. **You need full Java compatibility**
   - Dynamic class loading is required
   - Heavy use of reflection that's hard to configure
   - Runtime bytecode generation (code generators, proxies)

2. **Peak throughput matters more than startup**
   - Long-running services where startup happens once
   - Batch processing with high throughput requirements
   - Applications that benefit from JIT optimization over time

3. **You want incremental improvement without migration**
   - Upgrade JDK and get benefits automatically
   - No code changes required
   - No build process changes for basic functionality

4. **Build simplicity is important**
   - Standard Java tooling
   - No resource-intensive native compilation
   - Same binary works across compatible JDK versions

## The Middle Ground

For many applications, the decision isn't binary. Consider a microservices architecture:

- **API Gateway**: GraalVM Native Image (needs to scale quickly, mostly routing)
- **Business Logic Services**: Project Leyden (complex, long-running, benefit from JIT)
- **Event Processors**: Evaluate based on scale pattern (bursty vs. steady)

# The Road Ahead

## GraalVM Native Image

GraalVM continues to evolve. Recent versions have added:
- Profile-guided optimization (PGO) for better peak performance
- G1 garbage collector support
- Improved monitoring and observability
- Better build-time performance

The trajectory is toward closing the peak performance gap while maintaining startup advantages.

## Project Leyden

The project is delivering features incrementally. Beyond the JEPs already delivered:
- **Ahead-of-Time Object Caching** will enable caching heap objects created during startup
- **Ahead-of-Time Code Compilation** will pre-compile frequently used methods
- **Unified Ahead-of-Time Cache** consolidates various caches into a single mechanism

The vision is a spectrum of optimization levels, from "run normally" to "fully optimized for production deployment," all using standard JVM tooling.

# Conclusion

GraalVM Native Image and Project Leyden represent two valid approaches to the same problem. They're not mutually exclusive—GraalVM Native Image will likely benefit from Leyden's work on the JDK, and both projects push Java's performance boundaries.

**GraalVM Native Image** is the right choice when you need the absolute fastest startup and smallest footprint, and you're willing to accept the closed-world constraints and build complexity.

**Project Leyden** is the right choice when you want significant performance improvements while maintaining full Java compatibility and standard tooling.

For most enterprise Java applications—particularly Spring Boot services—Project Leyden offers a compelling path: upgrade your JDK, run a training phase, and get meaningful startup improvements without changing your code or build process.

The key takeaway: both technologies are production-viable, and understanding their trade-offs lets you make the right choice for your specific use case.

---

## Sources

- [Project Leyden - OpenJDK](https://openjdk.org/projects/leyden/)
- [JEP 483: Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483)
- [GraalVM Native Image Reference](https://www.graalvm.org/latest/reference-manual/native-image/)
- [Java Applications Can Start 40% Faster in Java 24 - InfoQ](https://www.infoq.com/news/2025/03/java-24-leyden-ships/)
- [Project Leyden Announces Early Access Build - InfoQ](https://www.infoq.com/news/2024/07/project-leyden-ea-release/)
- [Quarkus and Project Leyden](https://quarkus.io/blog/quarkus-and-leyden/)
- [Inside JDK 24: Understanding AOT Class Loading & Linking - SoftwareMill](https://softwaremill.com/inside-jdk-24-understanding-ahead-of-time-class-loading-and-linking/)
- [GraalVM Wikipedia](https://en.wikipedia.org/wiki/GraalVM)
- [Using Project Leyden with Spring Boot - BellSoft](https://bell-sw.com/blog/how-to-use-project-leyden-with-spring-boot/)
