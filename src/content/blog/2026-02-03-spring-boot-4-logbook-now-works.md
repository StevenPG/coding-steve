---
author: StevenPG
pubDatetime: 2026-02-03T12:00:00.000Z
title: Spring Boot 4 and Logbook Now Work Together
slug: spring-boot-4-logbook-now-works
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - logging
description: Logbook 4.x now supports Spring Boot 4 and Jackson 3. Here's how to upgrade.
---

# Brief

Back in December 2025, I wrote about [Logbook being broken with Spring Boot 4][old-post]. If you landed on that post hoping for a solution, this is the follow-up you're looking for. Zalando has released Logbook 4.x with full Spring Boot 4 and Jackson 3 support.

This post exists so anyone searching for this issue can find the fix without digging through GitHub issues and release notes. I've verified all the examples below work with Spring Boot 4.0.0 and Logbook 4.0.1.

# The Original Issue

When Spring Boot 4 was released, it brought significant changes including:

- Migration from `javax` to `jakarta` namespace (completed from Spring Boot 3)
- **Jackson 3.x** as the default JSON library (this was the breaking change)
- Refactored autoconfiguration classes

Logbook 3.x relied on Jackson 2.x APIs and Spring Boot's autoconfiguration classes that were restructured in Spring Boot 4. This caused the infamous `ClassNotFoundException`:

```
java.lang.ClassNotFoundException: org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration
```

# The Jackson 3 Migration

The biggest change in Logbook 4.x is the migration to Jackson 3. Jackson 3 introduced several breaking changes:

1. **Package rename**: `com.fasterxml.jackson` became `tools.jackson` in some modules
2. **API changes**: Some deprecated methods were removed
3. **Module structure**: Jackson 3 reorganized how modules are loaded

Logbook 4.x handles all of this internally, so you don't need to worry about the Jackson migration details. Just update your Logbook version.

# First Fixed Version

The first version with Spring Boot 4 support was **4.0.0-RC.0** (released December 16, 2024). However, I recommend using **4.0.1** or later for production, as it includes important bug fixes like resolving issues with `ReadOnlyHttpHeaders`.

Key changes in Logbook 4.x:

- **Java 17 minimum** (upgraded from previous requirements)
- **Spring Boot 2.x support discontinued**
- Full **Spring Boot 4** and **Jackson 3** compatibility
- Migration to `jakarta` namespace (matching Spring Boot 3+)

See the full release notes on the [Logbook releases page][logbook-releases].

# How to Upgrade

## Gradle (build.gradle)

```groovy
plugins {
    id 'java'
    id 'org.springframework.boot' version '4.0.0'
    id 'io.spring.dependency-management' version '1.1.7'
}

group = 'com.example'
version = '0.0.1-SNAPSHOT'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'

    // Logbook 4.x - Spring Boot 4 compatible
    implementation 'org.zalando:logbook-spring-boot-starter:4.0.1'

    testImplementation 'org.springframework.boot:spring-boot-starter-test'
}

tasks.named('test') {
    useJUnitPlatform()
}
```

## Gradle Kotlin DSL (build.gradle.kts)

```kotlin
plugins {
    java
    id("org.springframework.boot") version "4.0.0"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.example"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")

    // Logbook 4.x - Spring Boot 4 compatible
    implementation("org.zalando:logbook-spring-boot-starter:4.0.1")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
```

## Maven (pom.xml)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>demo</name>
    <description>Demo project with Logbook</description>

    <properties>
        <java.version>21</java.version>
        <logbook.version>4.0.1</logbook.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <!-- Logbook 4.x - Spring Boot 4 compatible -->
        <dependency>
            <groupId>org.zalando</groupId>
            <artifactId>logbook-spring-boot-starter</artifactId>
            <version>${logbook.version}</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

# Basic Configuration

Once you've added the dependency, Logbook works with minimal configuration. Add this to your `application.yml`:

```yaml
logging:
  level:
    org.zalando.logbook: TRACE

logbook:
  include:
    - /**
  format:
    style: json
```

Or in `application.properties`:

```properties
logging.level.org.zalando.logbook=TRACE
logbook.include=/**
logbook.format.style=json
```

# Verify It Works

Start your Spring Boot 4 application and make a request. You should see Logbook logging the request and response:

```json
{
  "origin": "remote",
  "type": "request",
  "correlation": "abc123",
  "protocol": "HTTP/1.1",
  "remote": "127.0.0.1",
  "method": "GET",
  "uri": "http://localhost:8080/api/hello",
  "headers": {
    "Accept": ["application/json"],
    "Host": ["localhost:8080"]
  }
}
```

# Summary

If you've been holding off on upgrading to Spring Boot 4 because of Logbook, you can proceed now. Update your Logbook dependency to version **4.0.1** or later and you're set.

- Use Logbook **4.0.1** or later for Spring Boot 4
- Java 17 is now the minimum requirement
- Spring Boot 2.x is no longer supported
- No code changes needed beyond updating the version

[old-post]: /posts/spring-boot-4-logbook-is-broken-for-now
[logbook-releases]: https://github.com/zalando/logbook/releases
