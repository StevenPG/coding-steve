---
author: StevenPG
pubDatetime: 2025-11-15T12:00:00.000Z
title: A Guide for Building with Java Modules
slug: java-modules-guide
featured: false
draft: true
ogImage: /assets/17e73d45-30ad-4daf-a92b-6333eec91b89.png
tags:
  - gradle
  - java
description: Many teams still haven't migrated their projects to using Java Modules, this is a simple guide with examples!
---
# How to use Java Modules with Gradle: A Practical Guide

Java's module system, introduced in Java 9 as part of Project Jigsaw, fundamentally changed how we structure and distribute Java applications. Yet many developers still avoid modules, missing out on significant benefits in terms of security, performance, and maintainability. In this post, we'll explore how to effectively use Java modules in a Gradle project, using the popular `locationtech-jts` geometry library as a real-world example.

## Project Jigsaw: A Brief History

Project Jigsaw was one of the most ambitious features introduced in Java 9, aimed at solving the "JAR Hell" problem that had plagued Java development for decades. Before modules, the classpath was essentially a flat namespace where all JARs were loaded together, leading to:

- **Version conflicts**: Multiple versions of the same library causing runtime failures
- **Bloated runtime**: Entire JARs loaded even when only small parts were needed
- **Poor encapsulation**: Internal APIs easily accessible, leading to brittle dependencies
- **Security concerns**: No fine-grained control over what code could access what

The goals of Project Jigsaw were straightforward but transformative:

1. **Reliable configuration**: Explicit dependencies that are checked at compile-time and startup
2. **Strong encapsulation**: Only explicitly exported packages are accessible to other modules
3. **Scalable development**: Better separation of concerns and cleaner architecture
4. **Performance**: Faster startup times and reduced memory footprint
5. **Security**: Principle of least privilege applied to code access

## Modules vs No Modules: A Side-by-Side Comparison

Let's build the same project twice—once using traditional classpath-based builds, and once using the Java module system—to see the differences in practice.

### The Traditional Approach (No Modules)

First, let's create a standard Gradle project that uses the `locationtech-jts` library for geometric calculations:

**build.gradle**
```groovy
plugins {
    id 'java'
    id 'application'
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.locationtech.jts:jts-core:1.19.0'
}

application {
    mainClass = 'com.example.GeometryApp'
}
```

**src/main/java/com/example/GeometryApp.java**
```java
package com.example;

import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.Polygon;

public class GeometryApp {
    public static void main(String[] args) {
        GeometryFactory factory = new GeometryFactory();
        
        // Create a simple polygon
        Coordinate[] coords = {
            new Coordinate(0, 0),
            new Coordinate(10, 0),
            new Coordinate(10, 10),
            new Coordinate(0, 10),
            new Coordinate(0, 0)
        };
        
        Polygon polygon = factory.createPolygon(coords);
        Point center = polygon.getCentroid();
        
        System.out.println("Polygon area: " + polygon.getArea());
        System.out.println("Centroid: " + center);
    }
}
```

This works, but we're operating in the traditional "everything accessible" world of the classpath.

### The Module-Based Approach

Now let's convert this to use Java modules:

**build.gradle**
```groovy
plugins {
    id 'java'
    id 'application'
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
    modularity.inferModulePath = true
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.locationtech.jts:jts-core:1.19.0'
}

application {
    mainClass = 'com.example.GeometryApp'
    mainModule = 'com.example.geometry'
}
```

**src/main/java/module-info.java**
```java
module com.example.geometry {
    requires org.locationtech.jts;
    
    exports com.example;
}
```

The application code remains identical, but now we have explicit module boundaries and dependencies.

### Performance Comparison

*[Placeholder for performance testing results]*

**Startup Time Comparison:**
- Traditional classpath: [X]ms average startup time
- Module-based: [Y]ms average startup time (~[Z]% improvement)

**Memory Usage:**
- Traditional classpath: [X]MB heap usage
- Module-based: [Y]MB heap usage (~[Z]% reduction)

**Build Analysis:**
```bash
# Traditional build
./gradlew build --profile

# Module-based build  
./gradlew build --profile
```

*[Results would show compilation time, dependency resolution, and packaging differences]*

### Key Differences in Practice

1. **Explicit Dependencies**: The module system forces you to declare exactly what your code needs
2. **Encapsulation**: Only exported packages are accessible to dependent modules
3. **Compile-time Verification**: Module conflicts are caught at compile-time, not runtime
4. **Tooling Integration**: Better IDE support for dependency analysis and refactoring

## Working with locationtech-jts Modules

The `locationtech-jts` library provides excellent module support. According to their [usage documentation](https://github.com/locationtech/jts/blob/ab57bffd4250f14416315249565e585a76c0c489/USING.md?plain=1#L110), the library is organized into several modules:

- `org.locationtech.jts` - Core geometry and algorithms
- `org.locationtech.jts.io` - Input/output operations (WKT, WKB, GeoJSON)
- `org.locationtech.jts.operation` - Advanced geometric operations

Here's how to use multiple JTS modules:

**module-info.java**
```java
module com.example.geometry {
    requires org.locationtech.jts;
    requires org.locationtech.jts.io;
    
    exports com.example;
    exports com.example.io;
}
```

**Enhanced application with I/O operations:**
```java
package com.example;

import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.io.WKTReader;
import org.locationtech.jts.io.WKTWriter;

public class GeometryIOApp {
    public static void main(String[] args) throws Exception {
        GeometryFactory factory = new GeometryFactory();
        WKTReader reader = new WKTReader(factory);
        WKTWriter writer = new WKTWriter();
        
        String wkt = "POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))";
        Polygon polygon = (Polygon) reader.read(wkt);
        
        System.out.println("Original: " + writer.write(polygon));
        System.out.println("Area: " + polygon.getArea());
        System.out.println("Buffered: " + writer.write(polygon.buffer(2.0)));
    }
}
```

## Why You Should Use Modules in Your Builds

### 1. **Reliability and Maintainability**

Modules eliminate many categories of runtime errors by moving dependency checks to compile-time. Your builds become more predictable, and integration issues are caught early.

### 2. **Performance Benefits**

- **Faster startup**: JVM can optimize module loading and eliminate unnecessary initialization
- **Memory efficiency**: Reduced memory footprint through better dead code elimination
- **Improved JIT compilation**: Better optimization opportunities with explicit module boundaries

### 3. **Security and Encapsulation**

```java
module com.example.geometry {
    requires org.locationtech.jts;
    
    exports com.example.api;
    // com.example.internal is NOT exported - truly private
}
```

Internal packages are genuinely inaccessible to other modules, enforcing clean API boundaries.

### 4. **Better Tooling and Developer Experience**

Modern IDEs provide enhanced support for modular projects:
- Dependency visualization
- Refactoring safety across module boundaries  
- Better code completion and navigation

### 5. **Future-Proofing**

As the Java ecosystem continues to embrace modules, non-modular projects will increasingly feel legacy. Starting with modules now positions your codebase for:
- Better integration with modern Java frameworks
- Access to module-specific JVM optimizations
- Compatibility with emerging Java platform features

## Getting Started

Ready to modularize your next project? Here's a simple migration path:

1. **Start with a new module**: Add `module-info.java` to your existing project
2. **Add explicit requires**: List your dependencies explicitly
3. **Export your APIs**: Only export packages that other modules should access
4. **Update your build**: Configure Gradle for module-aware compilation
5. **Test thoroughly**: Verify that your module boundaries are correct

The module system might seem daunting at first, but the benefits in reliability, performance, and maintainability make it well worth the initial investment. Start with a small project like our JTS geometry example, and gradually apply the patterns to larger codebases.

Your future self (and your teammates) will thank you for the cleaner, more maintainable code that results.

---

*Have questions about Java modules or want to share your own modularization experiences? Feel free to reach out or leave a comment below.*
