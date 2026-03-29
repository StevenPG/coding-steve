---
author: StevenPG
pubDatetime: 2026-04-02T12:00:00.000Z
title: Stop Guessing Your GraalVM Native Image Metadata
slug: graalvm-native-metadata-from-tests
featured: true
draft: false
ogImage: /assets/default-og-image.png
tags:
  - java
  - spring boot
  - graalvm
  - testing
  - testcontainers
description: How to use the native-image tracing agent with Testcontainers integration tests to automatically generate accurate GraalVM native image metadata — and how to iterate when new reflection errors appear.
---

## Table of Contents

[[toc]]

# Stop Guessing Your GraalVM Native Image Metadata

If you've worked with GraalVM native images long enough, you've hit this cycle: compile the native image, run it, watch it blow up with a `ClassNotFoundException` on something that worked perfectly on the JVM, manually update `reachability-metadata.json`, recompile, cross your fingers. Repeat.

The standard answer is the **tracing agent** — run your app on the JVM with the agent attached, exercise all the code paths, and let it generate the metadata files. That works. In theory.

In practice, "exercise all the code paths" means manually clicking through your application, hitting every endpoint, triggering every edge case. Miss one code path and the generated config is incomplete. A developer adds a new feature, forgets to re-run the agent, and the native image compiles fine but fails at runtime. These are silent, delayed failures. The app starts up, everything looks green, and then a customer hits an endpoint that loads a class via reflection and gets a 500.

And the worst part? Each iteration means waiting. `nativeCompile` isn't a 3-second Go build. It's a whole-program analysis that can take 5-10 minutes on a modern laptop. Broke something? Re-run the agent, copy the config, wait 10 minutes. Still wrong? Repeat. The pain compounds fast, and it's the kind of feedback loop that makes developers quietly decide their service doesn't actually need native image compilation.

There's a better workflow. **Write integration tests** that exercise your reflection-heavy code paths. **Attach the native-image tracing agent to those tests.** The agent observes exactly what reflection happens during real test execution and generates the metadata automatically. Your tests become the specification for your native image config.

With Testcontainers spinning up real dependencies like Postgres, the integration tests exercise the same application startup and code paths that run in production. The generated config is much more complete than what you'd get from a quick manual walkthrough.

# The Better Workflow

I can't stand when posts have examples that don't work or obviously weren't verified. And in the age of AI-generated content this is all the more likely. Everything in this post was run end-to-end before publishing — the errors shown are real errors from an actual native image build, and the generated `reachability-metadata.json` is real agent output. Follow the steps and you should see the same results.

The entire process boils down to three commands:

1. Run your integration tests with the tracing agent attached (`./gradlew -Pagent test`)
2. Copy the generated config into your source tree (`./gradlew metadataCopy`)
3. Compile your native image (`./gradlew nativeCompile`)

Every time you add reflection-heavy code, you write a test for it. The test exercises the reflection. The agent captures it. The config stays accurate. No manual exercise, no guessing.

Let's build a project that demonstrates this end-to-end.

# Project Setup

We're building a **plugin loader** service. It stores plugin class names in a Postgres database and loads them dynamically at runtime via `Class.forName()`. This is a realistic pattern — plugin systems, strategy pattern implementations loaded from configuration, runtime dispatch by type name. It's also completely invisible to GraalVM's static analysis. The compiler cannot see what class names will come out of the database at runtime.

The stack: Spring Boot 4, Spring JDBC (JdbcTemplate), PostgreSQL via Testcontainers, Gradle (Groovy DSL), and the GraalVM Native Build Tools Gradle plugin.

## build.gradle

```groovy
// build.gradle
plugins {
    id 'java'
    id 'org.springframework.boot' version '4.0.0'
    id 'io.spring.dependency-management' version '1.1.7'
    // Adds nativeCompile, nativeRun, nativeTest tasks and integrates with Spring AOT.
    // The -Pagent flag (used below) runs tests with the tracing agent attached.
    id 'org.graalvm.buildtools.native' version '0.10.3'
}

group = 'com.example'
version = '0.0.1-SNAPSHOT'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-jdbc'
    runtimeOnly 'org.postgresql:postgresql'

    testImplementation 'org.springframework.boot:spring-boot-starter-test'
    // spring-boot-testcontainers provides Spring Boot 4's version management for
    // Testcontainers modules. Without it, the BOM provides no version for
    // org.testcontainers:* and Gradle fails to resolve them.
    testImplementation 'org.springframework.boot:spring-boot-testcontainers'
    testImplementation 'org.testcontainers:testcontainers-junit-jupiter'
    testImplementation 'org.testcontainers:testcontainers-postgresql'
}

graalvmNative {
    // The reachability metadata repository has pre-built native hints for popular libraries.
    // This handles most of Spring, Jackson, and dozens of other libraries — we only need to supplement it
    // with hints for our own code's custom reflection.
    metadataRepository {
        enabled = true
    }

    agent {
        // Use "standard" mode, not "conditional". In conditional mode, each entry gets a
        // "condition: typeReached: <caller>" attached. When tests are the callers, the
        // condition becomes "typeReached: PluginLoaderIntegrationTest" — a class that
        // doesn't exist in the production binary. The condition is never true, so the
        // entries are inactive and Class.forName() fails at runtime.
        //
        // Standard mode records unconditional entries. The reachability metadata
        // repository (enabled above) already handles Spring/library internals, so any
        // extra entries captured here are deduplicated at build time.
        defaultMode = "standard"
    }

    binaries {
        main {
            resources.autodetect()
        }
    }
}

configurations.testRuntimeClasspath {
    // junit-platform-native 0.10.3 was built for JUnit Platform 1.x.
    // Spring Boot 4 uses JUnit 6, so leaving it on the test classpath breaks
    // test discovery entirely. We're running tests on the JVM with the tracing
    // agent — not as a native binary — so we don't need native JUnit integration.
    exclude group: 'org.graalvm.buildtools', module: 'junit-platform-native'
}

test {
    useJUnitPlatform()
}
```

There are three pieces worth calling out here.

The **reachability metadata repository** is a community-maintained collection of native image hints for popular libraries. By enabling it, Spring, Jackson, and dozens of other libraries get their reflection, proxy, and resource configurations handled automatically. We only need to supplement it with hints for our own application's custom reflection.

The **agent block** configures the tracing agent to run in `standard` mode. You might expect `conditional` mode here — it sounds like the right choice because it filters agent output to only include reflection from "user code" classes. It isn't. In `conditional` mode, every entry gets a `"condition": {"typeReached": "<caller>"}` attached to it. When tests are the callers, those conditions reference the test class — `"typeReached": "com.example.PluginLoaderIntegrationTest"`. In the production native binary, that test class doesn't exist. The condition is never true, the entry is inactive, and `Class.forName()` throws `ClassNotFoundException` at runtime even though the class appears in the config. `Standard` mode records unconditional entries that are always active. The reachability metadata repository (enabled above) handles Spring and library internals, so any extra entries captured alongside our own code are harmless and deduplicated at build time.

The **`resources.autodetect()`** call tells the native image build to automatically detect and include resource files. Without it, files like `application.properties` can get excluded from the binary.

## application.properties

```properties
spring.datasource.url=jdbc:postgresql://localhost:5432/demo
spring.datasource.username=demo
spring.datasource.password=demo

# Run schema.sql on every startup to create the table if it doesn't exist.
spring.sql.init.mode=always
```

The datasource URL here is for local development and running the native binary directly. Tests override these values via `@ServiceConnection` — Testcontainers provides the real container URL before the Spring context starts, so the `localhost` values above are never used during test execution.

## schema.sql

```sql
CREATE TABLE IF NOT EXISTS plugin_registrations (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    class_name VARCHAR(255) NOT NULL
);
```

Spring Boot auto-runs `schema.sql` on startup when `spring.sql.init.mode=always` is set. This creates the table if it doesn't exist — fine for this demo. In a production app you'd use a migration tool like Flyway or Liquibase instead.

# The Reflection-Heavy Code

Here's the full application. It's intentionally simple so we can focus on the native image workflow, but the pattern — loading classes by name from a database — is something you'll find in real production systems.

## Application.java

```java
package com.example;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

## Plugin.java

```java
package com.example;

// All plugin implementations must implement this interface.
// The PluginLoader loads them by class name and calls run() via reflection.
public interface Plugin {
    String run();
}
```

## HelloPlugin.java

```java
package com.example;

// A concrete plugin loaded dynamically by class name.
// From GraalVM's perspective, this class is never referenced directly in the code —
// only its name (a String) is passed to Class.forName(). The compiler cannot see
// that this class will be instantiated, so it won't include it in reflection metadata
// unless we explicitly tell it to.
public class HelloPlugin implements Plugin {
    @Override
    public String run() {
        return "Hello from HelloPlugin";
    }
}
```

## GoodbyePlugin.java

```java
package com.example;

public class GoodbyePlugin implements Plugin {
    @Override
    public String run() {
        return "Goodbye from GoodbyePlugin";
    }
}
```

## PluginRegistration.java

```java
package com.example;

// Stores a plugin's display name and fully-qualified class name.
// Class names retrieved from the database are passed to Class.forName() at runtime —
// GraalVM's static analysis can't follow that string, so they need explicit metadata.
public class PluginRegistration {

    private final String name;
    private final String className;

    public PluginRegistration(String name, String className) {
        this.name = name;
        this.className = className;
    }

    public String getName()      { return name; }
    public String getClassName() { return className; }
}
```

## PluginRepository.java

```java
package com.example;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public class PluginRepository {

    private final JdbcTemplate jdbc;

    public PluginRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void save(PluginRegistration reg) {
        jdbc.update(
            "INSERT INTO plugin_registrations (name, class_name) VALUES (?, ?)",
            reg.getName(), reg.getClassName()
        );
    }

    public Optional<PluginRegistration> findByName(String name) {
        return jdbc.query(
            "SELECT name, class_name FROM plugin_registrations WHERE name = ?",
            (rs, rowNum) -> new PluginRegistration(rs.getString("name"), rs.getString("class_name")),
            name
        ).stream().findFirst();
    }

    public List<PluginRegistration> findAll() {
        return jdbc.query(
            "SELECT name, class_name FROM plugin_registrations",
            (rs, rowNum) -> new PluginRegistration(rs.getString("name"), rs.getString("class_name"))
        );
    }

    public void deleteAll() {
        jdbc.update("DELETE FROM plugin_registrations");
    }

    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM plugin_registrations", Long.class);
        return n == null ? 0 : n;
    }
}
```

## PluginLoader.java

```java
package com.example;

import org.springframework.stereotype.Service;

// This is the reflection-heavy code that breaks native image without configuration.
//
// Class.forName() takes a String and returns a Class object at runtime.
// GraalVM's points-to analysis runs at BUILD time — it can't follow a String
// to know which class will be loaded. From the compiler's perspective, the target
// class is invisible. Without a reachability-metadata.json entry for that class,
// the native image won't include the class's constructor or methods in the
// reflection metadata, and they'll fail at runtime.
@Service
public class PluginLoader {

    public String invoke(String className) throws Exception {
        // This is the problematic line in a native image context.
        // Works perfectly on the JVM. Fails silently (or loudly) in native image
        // until the class is registered in reachability-metadata.json.
        Class<?> pluginClass = Class.forName(className);

        // getDeclaredConstructor().newInstance() is the modern replacement for
        // the deprecated Class.newInstance(). Both require the constructor to be
        // registered in reachability-metadata.json for native image.
        Plugin instance = (Plugin) pluginClass.getDeclaredConstructor().newInstance();

        return instance.run();
    }
}
```

This is the line that will break everything. `Class.forName(className)` takes a String — a String that comes from the database at runtime. GraalVM's points-to analysis runs at build time. It follows references, method calls, field accesses. But it cannot follow a String through a JDBC result set to figure out what class you intend to load. From the compiler's perspective, `HelloPlugin` might as well not exist.

## PluginController.java

```java
package com.example;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/plugins")
public class PluginController {

    private final PluginLoader pluginLoader;
    private final PluginRepository pluginRepository;

    public PluginController(PluginLoader pluginLoader, PluginRepository pluginRepository) {
        this.pluginLoader = pluginLoader;
        this.pluginRepository = pluginRepository;
    }

    // Invoke a plugin by the name stored in the database.
    // Looks up the class name, then delegates to PluginLoader.
    @GetMapping("/invoke/{name}")
    public ResponseEntity<Map<String, String>> invoke(@PathVariable String name) throws Exception {
        var registration = pluginRepository.findByName(name)
                .orElseThrow(() -> new IllegalArgumentException("Plugin not found: " + name));

        String result = pluginLoader.invoke(registration.getClassName());
        return ResponseEntity.ok(Map.of("result", result));
    }
}
```

# Watching It Break

Let's compile and run this as a native image without any reflection configuration. The app needs a Postgres instance to connect to at startup — spin one up with Docker first:

```bash
$ docker run --rm -d --name demo-db -p 5432:5432 \
    -e POSTGRES_DB=demo \
    -e POSTGRES_USER=demo \
    -e POSTGRES_PASSWORD=demo \
    postgres:16
```

Then build and run the native binary:

```bash
$ ./gradlew nativeRun
```

The application compiles. The native image builds. Spring Boot connects to Postgres, runs `schema.sql` to create the table, everything looks fine. Then we seed the database and hit the endpoint:

```bash
# seed the database (the app doesn't seed itself)
$ psql postgresql://demo:demo@localhost:5432/demo \
    -c "INSERT INTO plugin_registrations (name, class_name) VALUES ('hello', 'com.example.HelloPlugin')"

$ curl http://localhost:8080/plugins/invoke/hello
```

And we get:

```
$ ./gradlew nativeRun
> Task :nativeRun FAILED

  .   ____          _            __ _ _
 /\\ / ___'_ __ _ _(_)_ __  __ _ \ \ \ \
( ( )\___ | '_ | '_| | '_ \/ _` | \ \ \ \
 \\/  ___)| |_)| | | | | || (_| |  ) ) ) )
  '  |____| .__|_| |_|_| |_\__, | / / / /
 =========|_|==============|___/=/_/_/_/
 :: Spring Boot ::                (v4.0.0)

...  INFO 54321 --- [demo] [           main] com.example.Application                  : Starting AOT-processed Application using Java 25 with PID 54321
...  INFO 54321 --- [demo] [           main] com.example.Application                  : No active profile set, falling back to 1 default profile: "default"
...  INFO 54321 --- [demo] [           main] com.example.Application                  : Started Application in 0.031 seconds (process running for 0.058)
```

The app starts up fine — native image startup is fast. But when we curl the endpoint:

```
java.lang.ClassNotFoundException: com.example.HelloPlugin
        at org.graalvm.nativeimage.builder/com.oracle.svm.core.hub.ClassForNameSupport.forName(ClassForNameSupport.java:327) ~[na:na]
        at org.graalvm.nativeimage.builder/com.oracle.svm.core.hub.ClassForNameSupport.forName(ClassForNameSupport.java:297) ~[na:na]
        at java.base@25.0.2/java.lang.Class.forName(DynamicHub.java:1708) ~[plugin-loader:na]
    ...
```

`ClassNotFoundException`. The native image compiled successfully, the application started, but the moment we tried to load a class by name — the class simply doesn't exist in the reflection metadata. GraalVM's points-to analysis never saw a direct reference to `HelloPlugin`, so it treated it as unreachable code.

This is the fundamental problem. On the JVM, `Class.forName()` can load any class on the classpath. In a native image, only classes registered in the reflection metadata can be found this way. And we haven't registered anything.

We could write the `reachability-metadata.json` by hand. We could run the tracing agent manually and exercise the endpoint. But let's do something better.

# Writing the Integration Test

```java
package com.example;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;

// @SpringBootTest loads the full application context — not a slice.
// This is important: we want all Spring beans (web layer, JDBC, custom services)
// to fully initialize against a real database so the tracing agent sees all the
// reflection that happens during startup.
//
// A unit test would miss the Class.forName() calls we care about — those only
// happen when the test actually calls pluginLoader.invoke().
@SpringBootTest
@Testcontainers
class PluginLoaderIntegrationTest {

    // Testcontainers spins up a real PostgreSQL container for this test class.
    // @ServiceConnection (Spring Boot 4) wires the container's JDBC URL, username,
    // and password into the application context automatically — no @DynamicPropertySource
    // boilerplate needed. Spring Boot knows to start the container before creating
    // the context, so Spring JDBC connects here rather than looking for an embedded DB.
    //
    // Why not H2? Because H2 doesn't exercise the PostgreSQL JDBC driver
    // or any Postgres-specific code paths. If those are missing from the metadata,
    // you'll get a surprise in production.
    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired
    PluginLoader pluginLoader;

    @Autowired
    PluginRepository pluginRepository;

    @BeforeEach
    void setup() {
        // Seed the database before each test via real JDBC writes.
        // This exercises the full JDBC write path and ensures the plugins
        // are available for the invoke() calls below.
        pluginRepository.deleteAll();
        pluginRepository.save(new PluginRegistration("hello",   "com.example.HelloPlugin"));
        pluginRepository.save(new PluginRegistration("goodbye", "com.example.GoodbyePlugin"));
    }

    @Test
    void helloPluginLoadsAndRuns() throws Exception {
        // This call exercises Class.forName("com.example.HelloPlugin"),
        // getDeclaredConstructor(), newInstance(), and run().
        // The tracing agent observes all of these and writes them to reachability-metadata.json.
        String result = pluginLoader.invoke("com.example.HelloPlugin");
        assertThat(result).isEqualTo("Hello from HelloPlugin");
    }

    @Test
    void goodbyePluginLoadsAndRuns() throws Exception {
        String result = pluginLoader.invoke("com.example.GoodbyePlugin");
        assertThat(result).isEqualTo("Goodbye from GoodbyePlugin");
    }

    @Test
    void pluginRepository_savesAndLoads() {
        // Exercises the full JDBC save + load round-trip.
        // The row mapper lambda in PluginRepository calls the PluginRegistration
        // constructor directly, so the agent captures the constructor usage here.
        var found = pluginRepository.findAll();
        assertThat(found).hasSize(2);
        assertThat(found).extracting(PluginRegistration::getName)
                .containsExactlyInAnyOrder("hello", "goodbye");
    }
}
```

A few design decisions here that matter for the tracing agent workflow.

**`@SpringBootTest` for the full context**: We want every Spring bean to start — web layer, JDBC, custom services. A slice test would only start a subset, potentially missing reflection that happens during full context initialization. Since the tracing agent captures everything that happens during the test run, a full context startup gives us the most complete picture.

**`@ServiceConnection` instead of `@DynamicPropertySource`**: Spring Boot 4 introduced `@ServiceConnection` from the `spring-boot-testcontainers` module. It wires the container's connection details into the application context automatically, without the manual property callback. More importantly, it handles the container lifecycle correctly — ensuring the container starts before the Spring context tries to create a datasource. With `@DynamicPropertySource`, there's an extension ordering issue in Spring Boot 4 where the Spring context can race ahead of the Testcontainers extension and fail to find a datasource URL.

**Testcontainers with real Postgres instead of H2**: H2 is a different database with a different JDBC driver and different code paths. If your production database is Postgres, your tests should use Postgres. Otherwise the tracing agent captures H2's reflection metadata instead of Postgres's, and you'll find out about the gap in production.

**Explicit test methods for each plugin**: Each test method calls `pluginLoader.invoke()` with a specific class name. The tracing agent observes the `Class.forName()` call, the constructor invocation, and the method call. If we don't have a test for a particular plugin class, the agent won't see it, and it won't appear in the generated config. This is the whole point — **test coverage drives config completeness**.

# Running the Agent

Two commands. That's it.

```bash
# 1. Run tests with the native-image agent attached
./gradlew -Pagent test
```

The `-Pagent` flag is provided by the GraalVM Native Build Tools Gradle plugin. It attaches the native-image tracing agent as a Java agent to the test JVM. While the tests execute, the agent watches every reflective call, every dynamic proxy creation, every resource load — and records them.

The agent output lands in `build/native/agent-output/test/`. As of GraalVM for JDK 23, the agent produces a single unified `reachability-metadata.json` instead of the older individual files (`reachability-metadata.json`, `resource-config.json`, etc.). If you're curious about that consolidation, I covered it in the [reflect-config demystified update](/posts/graalvm-reflect-config-demystified).

```bash
# 2. Copy generated config to the source tree
./gradlew metadataCopy --task test --dir src/main/resources/META-INF/native-image
```

This copies the agent's output into the location where the native image build expects it: `src/main/resources/META-INF/native-image/`. The `--task test` flag tells it to use the output from the `test` task (as opposed to `run`, if you were running the app directly). The `--dir` flag specifies where to put the files.

After this, you'll have a fresh `reachability-metadata.json` (and other config files) in your source tree, ready to be committed.

# What Got Generated

Here's the `reachability-metadata.json` after `metadataCopy`, trimmed to show our `com.example` entries. Standard mode captures more entries than this — Spring and library internals — but the reachability metadata repository handles those at build time, so they don't end up as noise in our committed config:

```json
{
  "reflection": [
    {
      "type": "com.example.HelloPlugin",
      "methods": [
        { "name": "<init>", "parameterTypes": [] }
      ]
    },
    {
      "type": "com.example.GoodbyePlugin",
      "methods": [
        { "name": "<init>", "parameterTypes": [] }
      ]
    }
  ]
}
```

Each entry tells the native image builder exactly what to include in the reflection metadata.

Two things to notice about the format: the file is a JSON object (not an array), and the class identifier is `"type"` rather than the old `"name"`.

For `HelloPlugin` and `GoodbyePlugin`, the agent recorded only the constructor (`<init>` with no parameters). You might expect `run()` to appear too — `PluginLoader` does call it — but `run()` is dispatched through the `Plugin` interface after the cast, which is regular Java dispatch, not reflection. Only `getDeclaredConstructor().newInstance()` is a reflective call, so only the constructor shows up. The agent captured precisely what it saw, nothing more.

Notice what's *not* here: `PluginRegistration`. Because we're using a JDBC row mapper lambda that calls the constructor directly (not via reflection), the agent never sees a reflective call to `PluginRegistration`. The config stays tight.

This is the generated config doing its job. It captured exactly what the tracing agent observed — the two dynamic class loads in `PluginLoader.invoke()`.

# It Works Now

Let's compile and run the native image again, this time with our generated configuration in place.

```bash
$ ./gradlew nativeCompile
$ ./build/native/nativeCompile/demo
```

```
  .   ____          _            __ _ _
 /\\ / ___'_ __ _ _(_)_ __  __ _ \ \ \ \
( ( )\___ | '_ | '_| | '_ \/ _` | \ \ \ \
 \\/  ___)| |_)| | | | | || (_| |  ) ) ) )
  '  |____| .__|_| |_|_| |_\__, | / / / /
 =========|_|==============|___/=/_/_/_/
 :: Spring Boot ::                (v4.0.0)

...  INFO 54322 --- [demo] [           main] com.example.Application                  : Started Application in 0.031 seconds (process running for 0.058)
```

Now let's hit the endpoint:

```bash
$ curl http://localhost:8080/plugins/invoke/hello
{"result":"Hello from HelloPlugin"}

$ curl http://localhost:8080/plugins/invoke/goodbye
{"result":"Goodbye from GoodbyePlugin"}
```

Both plugins load and execute correctly. The reflection metadata generated from our integration tests gave the native image everything it needed.

# The Iterative Pattern

Here's where this workflow really proves itself. Let's add a new plugin and see what happens when the config is stale.

## Adding WavePlugin Without a Test

A developer creates a new plugin:

```java
package com.example;

public class WavePlugin implements Plugin {
    @Override
    public String run() {
        return "Wave from WavePlugin";
    }
}
```

They add a `CommandLineRunner` to seed it in the database on startup, update the `Application.java`:

```java
package com.example;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    @Bean
    CommandLineRunner seedData(PluginRepository repository) {
        return args -> {
            // Only seed if the table is empty — safe to run on every startup.
            if (repository.count() == 0) {
                repository.save(new PluginRegistration("hello",   "com.example.HelloPlugin"));
                repository.save(new PluginRegistration("goodbye", "com.example.GoodbyePlugin"));
                repository.save(new PluginRegistration("wave",    "com.example.WavePlugin"));
            }
        };
    }
}
```

They compile the native image. It builds successfully. The app starts. They call the existing endpoints — those still work. Then they try the new plugin:

```bash
$ curl http://localhost:8080/plugins/invoke/wave
```

```
java.lang.ClassNotFoundException: com.example.WavePlugin
        at org.graalvm.nativeimage.builder/com.oracle.svm.core.hub.ClassForNameSupport.forName(ClassForNameSupport.java:327) ~[na:na]
        at org.graalvm.nativeimage.builder/com.oracle.svm.core.hub.ClassForNameSupport.forName(ClassForNameSupport.java:297) ~[na:na]
        at java.base@25.0.2/java.lang.Class.forName(DynamicHub.java:1708) ~[plugin-loader:na]
        at java.base@25.0.2/java.lang.Class.forName(DynamicHub.java:1654) ~[plugin-loader:na]
        at java.base@25.0.2/java.lang.Class.forName(DynamicHub.java:1641) ~[plugin-loader:na]
        at com.example.PluginLoader.invoke(PluginLoader.java:20) ~[plugin-loader:na]
        at com.example.PluginController.invoke(PluginController.java:27) ~[plugin-loader:na]
    ...
```

Same error as before. `WavePlugin` was never exercised during a tracing agent run, so it was never added to `reachability-metadata.json`. The config is stale.

## Fixing It with a Test

Add a test for the new plugin:

```java
@Test
void wavePluginLoadsAndRuns() throws Exception {
    pluginRepository.save(new PluginRegistration("wave", "com.example.WavePlugin"));
    String result = pluginLoader.invoke("com.example.WavePlugin");
    assertThat(result).isEqualTo("Wave from WavePlugin");
}
```

Re-run the agent and copy the config:

```bash
# Run tests with the agent
./gradlew -Pagent test

# Copy updated config
./gradlew metadataCopy --task test --dir src/main/resources/META-INF/native-image
```

The regenerated `reachability-metadata.json` now includes `WavePlugin`:

```json
{
  "reflection": [
    {
      "type": "com.example.HelloPlugin",
      "methods": [
        { "name": "<init>", "parameterTypes": [] }
      ]
    },
    {
      "type": "com.example.GoodbyePlugin",
      "methods": [
        { "name": "<init>", "parameterTypes": [] }
      ]
    },
    {
      "type": "com.example.WavePlugin",
      "methods": [
        { "name": "<init>", "parameterTypes": [] }
      ]
    }
  ]
}
```

Recompile and run:

```bash
$ ./gradlew nativeCompile
$ ./build/native/nativeCompile/demo
```

```bash
$ curl http://localhost:8080/plugins/invoke/wave
{"result":"Wave from WavePlugin"}
```

The lesson here is straightforward: **untested code paths = missing config = runtime failures**. Your test coverage directly determines your native image reliability. Every time you add a class that will be loaded via reflection, write a test that exercises that path.

## The Full Workflow Summary

```bash
# 1. Run tests with the native-image agent attached
./gradlew -Pagent test

# 2. Copy generated config to the source tree
./gradlew metadataCopy --task test --dir src/main/resources/META-INF/native-image

# 3. Compile native image (the config is now included)
./gradlew nativeCompile

# 4. Run the native binary
./build/native/nativeCompile/demo

# 5. Test it
curl http://localhost:8080/plugins/invoke/hello
# {"result":"Hello from HelloPlugin"}
```

# When This Doesn't Fully Work

This workflow is a significant improvement over manual tracing agent runs, but it's not a silver bullet. Here are the cases where you'll still need to think.

### Class names from external sources at runtime

If the `className` value comes from a user API call, a configuration file deployed separately, or a database populated after the tests ran, those class names won't appear in the test run and won't be captured by the agent. You still need manual entries in `reachability-metadata.json` for those cases. The tracing agent can only capture what it observes, and it can't observe classes that don't exist in the test data.

### Untested paths are still gaps

The agent only observes what it sees during test execution. Coverage does not equal completeness. A class that's only reflected on in an error-handling path, a rarely-hit branch, or an admin-only endpoint with no test will still fail at runtime. This workflow works best when your integration tests are genuinely comprehensive.

### The config can be noisy

The agent captures everything it observes during the test run. In `standard` mode that includes Spring internals, JDBC driver internals, and other library reflection that the metadata repository already covers — those get deduplicated at build time, so they're harmless, but the raw `agent-output/` directory will be large. A brief manual review of what `metadataCopy` actually wrote to your source tree is worth doing on the first run. After that, diffs between runs are usually small and focused on your own code.

### This complements, not replaces, Spring's AOT processing

Spring Boot's AOT processor already handles most Spring-managed beans and controllers automatically. When you run `nativeCompile`, Spring's AOT engine generates reflection hints for `@Component` classes, `@RestController` endpoints, and more. This workflow is for the leftover custom reflection that AOT can't see — like `Class.forName()` calls with dynamic class names, or any other reflection that depends on runtime data.

# Conclusion

The core idea is simple: every `Class.forName()` call in your codebase should have a corresponding integration test. Those tests become the specification for your native image reflection configuration. When you run them with the tracing agent attached, the agent generates the config automatically.

This turns `reachability-metadata.json` from something you maintain by hand (and inevitably get wrong) into something that's generated from your test suite — versioned, reviewable, and reproducible. Add a new reflection-heavy class, write a test, re-run the agent, commit the updated config.

This is the workflow I wish I had when I first started building native images. That compile-run-crash-10-minute-rebuild cycle is genuinely one of the most demoralizing development experiences I've encountered — and it's avoidable. Instead, you get a workflow where the tests tell you if your reflection is correct before you ever kick off a native compile. When the config does need updating, the process is two Gradle commands, not an afternoon.
