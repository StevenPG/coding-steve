---
title: Spring Version Compatibility Cheatsheet
description: A continuously updated reference for aligning Java, Gradle, Spring Boot, and Spring Cloud versions.
slug: spring-version-compatibility
pubDatetime: 2025-05-04T12:00:00.000Z
modDatetime: 2026-06-26T12:00:00.000Z
tags:
  - gradle
  - java
  - spring
order: 0
---

Using Spring Boot and Spring Cloud can significantly speed up Java development, particularly for microservices. However,
managing the dependencies between your JDK, build tool (like Gradle or Maven), Spring Boot, and Spring Cloud requires
attention to detail. Version mismatches are a common source of problems, leading to build failures or runtime errors
that can be difficult to diagnose.

This page collects the compatibility tables I reach for most often. I keep it updated as new versions ship, so bookmark
it rather than relying on a snapshot.

### Table Shortcuts

- [Java Version Compatibility with Spring Boot](#java-version-compatibility-with-spring-boot)
- [Spring Cloud Compatibility with Spring Boot](#spring-cloud-compatibility-with-spring-boot)
- [Gradle and Java Compatibility](#gradle-and-java-compatibility)

### Spring Support Mapping

Spring has now published a [compatibility list](https://spring.io/projects/generations)
called Spring Support Mapping. It provides a matrix of which versions of different Spring dependencies
are compatible with each other, including Spring Boot, Spring Framework and Spring Cloud.

## Compatibility Reference Tables

### Java Version Compatibility with Spring Boot

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

Key Notes:

- Spring Boot 4.x and 3.x both require Java 17 as a baseline. Spring Boot 4.x runs on Spring Framework 7
  and tracks the latest JDKs (4.1.x adds Java 26 support; first-class/native-image support is tested on Java 25).
- Spring Boot 2.x supports Java 8 but is tested with newer JDKs up to specific versions.

Reference doc (https://endoflife.date/spring-boot#java-compatibility)

### Spring Cloud Compatibility with Spring Boot

Spring Cloud uses "Release Trains" (e.g., 2023.0.x). Each train corresponds to specific Spring Boot versions. Mixing
versions not intended to work together is highly likely to cause issues.

Do not arbitrarily combine Spring Cloud trains and Spring Boot versions.
Always check the documentation page for the specific Spring Cloud release train (e.g., 2023.0.1) to find its required
Spring Boot version.

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

### Gradle and Java Compatibility

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

Key Points:

- The table lists the Gradle version that _first_ added support for running on each Java release. The latest Gradle
  release is 9.6 (June 2026), which can run on any JDK from 17 through 26.
- Newer Gradle versions are generally required to support newer Java versions for running Gradle itself.
- While you might run Gradle 9 on JDK 25, you can still configure it to compile your project code for Java 17 or Java 21
  using toolchains.
- Always check the specific Gradle version's documentation, as support details can change between minor releases.

(https://docs.gradle.org/current/userguide/compatibility.html)

## Why Version Compatibility is Necessary

Spring Boot simplifies dependency management through its starters and managed dependencies (BOM). Spring Cloud builds on
this, adding its own layer of managed dependencies. These systems work reliably when the versions are aligned because:

- APIs Change: Libraries evolve. Methods get added, removed, or change signatures. Code compiled against one version may
  fail at runtime if a different, incompatible version is present.
- Bytecode Requirements: Newer Java versions introduce bytecode features older JVMs can't handle. Conversely, older
  libraries might rely on APIs removed in newer JDKs. Your build tool (Gradle/Maven) also has minimum JDK requirements.
- Transitive Dependencies: The dependencies managed by Spring Boot and Spring Cloud have their own dependencies. A
  mismatch anywhere in this chain can cause conflicts.

### Common Errors from Version Mismatches

When versions aren't correctly aligned between Java, your build tool, Spring Boot, and potentially Spring Cloud, you
might encounter errors like:

- `java.lang.ClassNotFoundException`: The JVM can't find a specific class file at runtime. This often points to a missing
  dependency or an incorrect version being loaded.
- `java.lang.NoSuchMethodError`: Code calls a method that existed at compile time, but is missing in the version of the
  library loaded at runtime. A classic sign of a version conflict.
- `java.lang.AbstractMethodError`: An attempt was made to call an abstract method, which can happen if library APIs
  changed between versions in incompatible ways.
- Compilation Failures: Often related to using Java language features not supported by the configured
  targetCompatibility bytecode level, or when Spring Boot/Cloud versions require APIs from a newer JDK than you're using.
- Build Tool Errors: Gradle or Maven might fail if they are run with an incompatible JDK version (e.g., running Gradle 6
  with JDK 17 might cause issues).
- Spring Framework Issues: Problems like `UnsatisfiedDependencyException` or `BeanCreationException` during application
  startup can sometimes stem from underlying library incompatibilities caused by version mismatches.

### Resolving Compatibility Issues

Troubleshooting version conflicts involves a systematic approach:

- Consult Official Documentation: This is the primary source of truth. Check the specific version requirements for
  Gradle, Spring Boot, and Spring Cloud.
- Use Spring Initializr: For new projects, start.spring.io pre-selects compatible versions, providing a solid starting
  point.
- Utilize Maven/Gradle BOMs: Import the spring-boot-dependencies Bill of Materials (BOM) and, if used, the
  spring-cloud-dependencies BOM for your specific release train. This helps ensure consistent versions for transitive
  dependencies.

Maven Example (pom.xml)

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-dependencies</artifactId>
            <version>${spring-cloud.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-dependencies</artifactId>
            <version>${spring-boot.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>
```

Gradle Example (build.gradle - using dependencyManagement plugin)

```groovy
dependencyManagement {
    imports {
        // Import the BOMs
        mavenBom "org.springframework.cloud:spring-cloud-dependencies:${springCloudVersion}" // Specify Cloud version
        mavenBom "org.springframework.boot:spring-boot-dependencies:${springBootVersion}" // Specify Boot version
    }
}
```

- Inspect the Dependency Tree: Use `mvn dependency:tree` or `gradle dependencies` (or `gradle buildEnvironment`) to see
  the resolved dependency versions. Identify conflicts where different versions of the same library are being requested.
- Verify Build Tool Configuration: Ensure your Gradle or Maven setup is compatible with the JDK you're using to run the
  build. For Gradle, explicitly configure Java toolchains for compiling and testing.
- Test Consistently: Implement unit and integration tests to catch runtime errors early.

---

Disclaimer: Version compatibility information changes. Always refer to the official documentation for Gradle, Spring
Boot, and Spring Cloud for the most accurate and up-to-date details pertinent to your project.
