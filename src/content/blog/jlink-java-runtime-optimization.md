---
author: StevenPG
pubDatetime: 2025-06-18T12:00:00.000Z
title: JLink - Java Runtime Optimization Reference Guide
slug: jlink-java-runtime-optimization
featured: true
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - software
  - java
  - jlink
  - docker
description: Complete reference guide for using JLink to create optimized Java runtime images and reduce application size by 60%.
---

## Table of Contents

[[toc]]

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

This post serves as a complete reference guide for JLink - Java's built-in tool for creating custom runtime images.
We'll explore how to set up JLink, optimize your Java applications, and achieve significant size reductions in your deployments.

# What is JLink?

JLink is a tool introduced in Java 9 as part of Project Jigsaw that allows you to create custom Java runtime images.
Instead of shipping your application with a full JDK or JRE, JLink lets you create a minimal runtime that contains
only the modules your application actually needs.

This approach offers several key benefits:

- **Smaller deployment size**: Reduce your runtime from hundreds of MB to just what you need
- **Faster startup times**: Less code to load means faster application startup
- **Improved security**: Smaller attack surface with fewer unused components
- **Better resource utilization**: Less memory and disk usage in production

## The Impact: Real Numbers

Here's an example of what JLink can do for your application size:

Sample SaaS Backend Spring Application:

- **With JLink**: 191MB
- **Without JLink**: 473MB

That's a **60% reduction** in deployment size! This translates to faster deployments, reduced bandwidth costs,
and more efficient container images.

# How JLink Works

JLink analyzes your application's module dependencies and creates a custom runtime image that includes:

1. Only the JDK modules your application requires
2. Your application code and dependencies
3. A minimal launcher to start your application

The process involves two main steps:

1. **Dependency Analysis**: Using `jdeps` to determine which modules are needed
2. **Runtime Creation**: Using `jlink` to build the custom runtime image

# Setting Up JLink

## Prerequisites

- Java 9 or later (JLink is included in the JDK)
- A modularized application (or at least knowledge of your dependencies)
- Basic understanding of Java modules (JPMS)

## Basic JLink Command Structure

```bash
jlink --add-modules <modules> \
      --strip-debug \
      --no-man-pages \
      --no-header-files \
      --compress=2 \
      --output <output-directory>
```

Let's break down these options:

- `--add-modules`: Specifies which modules to include
- `--strip-debug`: Removes debug information to reduce size
- `--no-man-pages`: Excludes manual pages
- `--no-header-files`: Excludes C header files
- `--compress=2`: Applies maximum compression
- `--output`: Specifies the output directory for the custom runtime

# Complete Docker Example

Here's a complete Dockerfile that demonstrates JLink in action with a Spring Boot application:

```dockerfile
FROM gradle:8-jdk24-alpine AS jlink-builder

COPY . .

RUN ./gradlew build

# Define JAVA_HOME explicitly for this stage
ENV JAVA_HOME=/opt/java/openjdk

# Unpack jar to get the dependencies
RUN jar -xvf build/libs/my-application.jar

# Dynamically determine jdeps
RUN jdeps --ignore-missing-deps -q  \
    --recursive  \
    --multi-release 24  \
    --print-module-deps  \
    --class-path 'BOOT-INF/lib/*'  \
    build/libs/my-application.jar > deps.info

# Use the actual path to jlink in the JDK
RUN $JAVA_HOME/bin/jlink  \
         --add-modules `cat deps.info` \
         --strip-debug \
         --no-man-pages \
         --no-header-files \
         --compress=2 \
         --output /jre

# Base image
FROM alpine:3.21

# Setup environment
RUN mkdir /jre24
ENV JAVA_HOME=/jre24
ENV PATH=$JAVA_HOME/bin:$PATH

# Copy the custom JRE
COPY --from=jlink-builder /jre $JAVA_HOME

COPY --from=jlink-builder /build/libs/my-application.jar /my-app.jar

ENTRYPOINT ["java", "-jar", "/my-app.jar"]
```

## Breaking Down the Docker Example

### Stage 1: Building and Analyzing

```dockerfile
FROM gradle:8-jdk24-alpine AS jlink-builder
```

We start with a Gradle image that includes JDK 24, giving us access to the latest JLink features.

```dockerfile
# Unpack jar to get the dependencies
RUN jar -xvf build/libs/backend-0.0.1-SNAPSHOT.jar
```

We unpack the JAR file to access the dependencies, which is necessary for `jdeps` analysis.

```dockerfile
# Dynamically determine jdeps
RUN jdeps --ignore-missing-deps -q  \
    --recursive  \
    --multi-release 24  \
    --print-module-deps  \
    --class-path 'BOOT-INF/lib/*'  \
    build/libs/my-application.jar > deps.info
```

This is where the magic happens. `jdeps` analyzes our application and determines exactly which Java modules are needed:

- `--ignore-missing-deps`: Ignores missing dependencies that might not be modularized
- `--recursive`: Analyzes dependencies recursively
- `--multi-release 24`: Handles multi-release JARs for Java 24
- `--print-module-deps`: Outputs only the module names we need
- `--class-path`: Specifies where to find the application's dependencies

### Stage 2: Creating the Custom Runtime

```dockerfile
RUN $JAVA_HOME/bin/jlink  \
         --add-modules `cat deps.info` \
         --strip-debug \
         --no-man-pages \
         --no-header-files \
         --compress=2 \
         --output /jre
```

JLink creates our custom runtime using the modules identified by `jdeps`. The backticks execute the `cat deps.info` command to read the required modules.

### Stage 3: Final Image

```dockerfile
FROM alpine:3.21
```

We use a minimal Alpine Linux base image for the final stage.

```dockerfile
# Copy the custom JRE
COPY --from=jlink-builder /jre $JAVA_HOME
```

We copy our custom JRE from the builder stage, giving us a minimal Java runtime.

# Advanced JLink Techniques

## Custom Module Path

If you have custom modules or need to specify additional module paths:

```bash
jlink --module-path /path/to/modules:/path/to/more/modules \
      --add-modules your.module.name \
      --output custom-runtime
```

## Including Additional Modules

Sometimes you might need modules that `jdeps` doesn't detect:

```bash
jlink --add-modules java.base,java.logging,your.detected.modules \
      --output custom-runtime
```

## Launcher Scripts

JLink can create custom launcher scripts:

```bash
jlink --add-modules java.base \
      --launcher myapp=mymodule/com.example.Main \
      --output custom-runtime
```

# Troubleshooting Common Issues

## Missing Module Dependencies

If your application fails to start with module-related errors:

1. Run `jdeps` with `--verbose` to see detailed dependency information
2. Add missing modules manually with `--add-modules`
3. Check for reflection-based dependencies that `jdeps` might miss

## Large Runtime Size

If your custom runtime is still large:

1. Verify `--compress=2` is being used
2. Ensure `--strip-debug` is enabled
3. Check if unnecessary modules are being included
4. Consider using `--exclude-files` to remove specific files

## Platform-Specific Issues

JLink creates platform-specific runtimes. If you're building on macOS but deploying to Linux:

1. Use Docker for consistent build environments
2. Consider cross-compilation options
3. Build on the target platform when possible

# Best Practices

## 1. Always Use Multi-Stage Docker Builds

Keep your build environment separate from your runtime environment to minimize final image size.

## 2. Automate Dependency Analysis

Use `jdeps` in your build pipeline to automatically determine required modules rather than hardcoding them.

## 3. Test Your Custom Runtime

Always test your custom runtime thoroughly, as missing modules can cause runtime failures.

## 4. Monitor Runtime Size

Track your runtime size over time to catch dependency bloat early.

## 5. Consider Security Implications

Smaller runtimes have smaller attack surfaces, but ensure you're not removing security-critical modules.

# Integration with Build Tools

## Gradle Plugin

```gradle
plugins {
    id 'org.beryx.jlink' version '2.25.0'
}

jlink {
    options = ['--strip-debug', '--compress', '2', '--no-header-files', '--no-man-pages']
    launcher {
        name = 'myapp'
    }
}
```

## Maven Plugin

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-jlink-plugin</artifactId>
    <version>3.1.0</version>
    <configuration>
        <stripDebug>true</stripDebug>
        <compress>2</compress>
        <noHeaderFiles>true</noHeaderFiles>
        <noManPages>true</noManPages>
    </configuration>
</plugin>
```

# Conclusion

JLink is a powerful tool for optimizing Java applications, offering significant benefits in terms of deployment size,
startup time, and resource utilization. The 60% size reduction we achieved (from 473MB to 191MB) demonstrates the
real-world impact of proper JLink usage.

Key takeaways:

1. **Use `jdeps` for automatic dependency analysis** - Don't guess which modules you need
2. **Leverage multi-stage Docker builds** - Keep build and runtime environments separate
3. **Apply all optimization flags** - `--strip-debug`, `--compress=2`, etc.
4. **Test thoroughly** - Custom runtimes can behave differently than full JREs
5. **Automate the process** - Integrate JLink into your CI/CD pipeline

By following the patterns and examples in this guide, you'll be able to create optimized Java runtime images
that deploy faster, use fewer resources, and provide a better overall experience for your applications.

Remember: the goal isn't just to make things smaller, but to make them better. JLink helps you ship exactly
what your application needs - nothing more, nothing less.