---
author: StevenPG
pubDatetime: 2026-05-08T12:00:00.000Z
title: "The Ultimate Guide to Spring Modulith"
slug: ultimate-guide-spring-modulith
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - spring modulith
  - architecture
  - domain-driven design
description: A comprehensive guide to Spring Modulith — covering module boundaries, event-driven communication, the Event Publication Registry, Moments, testing with ApplicationModuleTest, and observability.
---

# The Ultimate Guide to Spring Modulith

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Modulith has been quietly becoming one of the most underrated tools in the Spring ecosystem. It sits in a space that most developers gloss over: the space between "one giant @SpringBootApplication" and "thirty microservices that take forty minutes to deploy."

This guide covers the full breadth of Spring Modulith — what a modular monolith actually means, how to structure your packages, how modules communicate without tight coupling, the Event Publication Registry that gives you at-least-once delivery without a message broker, testing strategies at every level, and the observability story. Every code example comes from a real working demo: a four-module e-commerce application built on Java 21 and Spring Boot 4.

If you already know the basics and want to jump straight to testing or events, use the table of contents. Otherwise, read straight through — the architecture section makes everything else click.

## What Is a Modular Monolith?

Before getting into Spring Modulith, it's worth being precise about what we're solving.

Most applications start as a monolith. That's fine. The problem is they tend to drift toward what's called a **Big Ball of Mud** — a codebase where everything depends on everything, there are no meaningful boundaries, and making a change in one area reliably breaks something unrelated. At that point, teams often reach for microservices as the cure.

Microservices solve coupling, but they introduce a different class of problems: distributed tracing, network failures, eventual consistency across service boundaries, operational overhead, and a testing story that requires spinning up many services just to check one workflow. For a team of five building a product that isn't yet operating at Netflix scale, this is often the wrong trade.

The **modular monolith** is the middle path:

- Single deployable unit (one Spring Boot app)
- Hard-enforced module boundaries (no sneaking across package lines)
- Event-driven communication between modules (loose coupling without the network)
- Independent testability per module
- Clear upgrade path to microservices if you genuinely outgrow it

Spring Modulith provides the tooling to build exactly this on top of Spring Boot. It's not a framework you bolt on — it's a set of conventions, verifiers, testing utilities, and integrations that make the modular monolith pattern practical.

### When Modulith vs Microservices

| Situation | Recommendation |
|---|---|
| Small-to-medium team (&lt;20 engineers) | Start with Modulith |
| Domain boundaries not yet proven | Start with Modulith, extract later |
| Shared database is acceptable | Modulith |
| Per-module scaling requirements differ drastically | Microservices |
| Independent deployment of modules is a hard requirement | Microservices |
| Already a modular monolith, hitting scaling limits | Extract the bottleneck module only |
| Greenfield, uncertain requirements | Modulith — always easier to split than to merge |

The key insight: a well-structured modular monolith is straightforward to extract into microservices because your module boundaries are already clean. A Big Ball of Mud monolith is nearly impossible to extract cleanly.

## Project Setup

### Version Compatibility

| Spring Modulith | Spring Boot | Java |
|---|---|---|
| **1.4.x** | **3.5.x** | 17+ |
| **2.0.x** | **4.0.x** | 17+ |

The demo in this post targets **Spring Boot 4 / Spring Modulith 2.0.x**. If you're on Spring Boot 3.5, swap the version to `1.4.11` in the BOM — the API is nearly identical; the differences are noted inline where they exist.

### Dependencies

The demo uses Gradle, but Maven equivalents are shown where relevant.

```kotlin
// build.gradle.kts
plugins {
    java
    id("org.springframework.boot") version "4.0.6"
    id("io.spring.dependency-management") version "1.1.7"
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    // Core Spring Boot
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    runtimeOnly("com.h2database:h2")

    // Spring Modulith — core and starters
    implementation("org.springframework.modulith:spring-modulith-starter-core")
    implementation("org.springframework.modulith:spring-modulith-starter-jpa")    // Event Publication Registry backed by JPA
    implementation("org.springframework.modulith:spring-modulith-actuator")       // /actuator/modulith endpoint
    implementation("org.springframework.modulith:spring-modulith-observability")  // Micrometer tracing for events
    implementation("org.springframework.modulith:spring-modulith-moments")        // Time-based domain events
    // Alternative: spring-modulith-starter-insight = observability + actuator + core bundled

    // Observability
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-registry-prometheus")

    // Testing
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.modulith:spring-modulith-starter-test")
    testImplementation("org.springframework.modulith:spring-modulith-junit")  // parameterized module tests
}
```

```xml
<!-- Maven equivalent for the Modulith starters -->
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.modulith</groupId>
            <artifactId>spring-modulith-bom</artifactId>
            <version>2.0.5</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>org.springframework.modulith</groupId>
        <artifactId>spring-modulith-starter-core</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.modulith</groupId>
        <artifactId>spring-modulith-starter-jpa</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.modulith</groupId>
        <artifactId>spring-modulith-starter-test</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
```

### The Starters Explained

| Starter | What it adds |
|---|---|
| `spring-modulith-starter-core` | Module detection, verification, `ApplicationModules` API |
| `spring-modulith-starter-jpa` | Persists events to a DB table before dispatching (at-least-once delivery) |
| `spring-modulith-starter-jdbc` | Same as JPA version but pure JDBC, lighter weight |
| `spring-modulith-actuator` | `/actuator/modulith` endpoint exposing the module graph |
| `spring-modulith-observability` | Module-to-module event hops become Micrometer spans/traces |
| `spring-modulith-moments` | Time-based domain events (`DayHasPassed`, `WeekHasPassed`, etc.) |
| `spring-modulith-starter-insight` | Convenience bundle: core + actuator + observability |
| `spring-modulith-starter-test` | `@ApplicationModuleTest`, `AssertablePublishedEvents`, `Scenario` |

## Module Structure and Package Conventions

Spring Modulith discovers modules by convention. No XML, no annotation-driven scanning configuration — just package layout.

### The Root Package

Every Spring Modulith application starts with a root package. By default, this is the package of your `@SpringBootApplication` class. Every **direct sub-package** of that root becomes a module.

```
com.stevenpg.ecommerce/
├── EcommerceApplication.java      ← @SpringBootApplication (root package)
├── catalog/                       ← "catalog" module
├── orders/                        ← "orders" module
├── inventory/                     ← "inventory" module
└── payments/                      ← "payments" module
```

That's it. No registration, no configuration file. Modulith scans the root package at startup and treats each sub-package as a module boundary.

### The `@Modulith` Application Annotation

`@Modulith` is a drop-in replacement for `@SpringBootApplication` that adds metadata about the module system:

```java
@Modulith(
    systemName = "E-Commerce Platform",
    sharedModules = {"shared"},                   // always loaded, always accessible
    useFullyQualifiedModuleNames = false
)
public class EcommerceApplication {
    public static void main(String[] args) {
        SpringApplication.run(EcommerceApplication.class, args);
    }
}
```

`sharedModules` is useful when you have a utility module (e.g., `shared`, `common`) that every other module may depend on without explicitly declaring it in `allowedDependencies`. The `systemName` appears in generated documentation.

This is optional — if you keep `@SpringBootApplication`, Modulith still works. Use `@Modulith` when you want to configure shared modules or the system name.

### Public vs Internal Surface

Each module has two layers:

**Public surface** — the root package of the module. Everything here is accessible to other modules. This is where you put:
- Domain entities and value objects
- Service interfaces and implementations that other modules need to call
- Domain event types
- Command objects (inputs)

**Internal sub-package** — a sub-package named `internal/`. Nothing here is accessible to other modules, enforced at both compile time and test time. This is where you put:
- Repository interfaces
- Listeners that respond to events
- Controllers (Spring can still find and register them; other Java code cannot inject them)

```
catalog/
├── Product.java              ← @Entity — public, other modules may reference it
├── CatalogService.java       ← @Service — public
└── internal/
    └── ProductRepository.java ← JpaRepository — hidden from other modules

orders/
├── Order.java                ← @Entity — public
├── OrderManagement.java      ← @Service — public
├── OrderPlacedEvent.java     ← record — public domain event
├── PlaceOrderCommand.java    ← record — public input type
└── internal/
    └── OrderRepository.java  ← hidden

inventory/
├── InventoryItem.java        ← @Entity — public
├── InventoryService.java     ← @Service — public
├── StockReservedEvent.java   ← record — public domain event
├── StockShortageEvent.java   ← record — public domain event
├── LowStockWarningEvent.java ← record — public domain event
└── internal/
    ├── InventoryItemRepository.java
    ├── OrderPlacedListener.java    ← @ApplicationModuleListener
    └── DailyInventoryAuditListener.java ← @ApplicationModuleListener

payments/
├── Payment.java              ← @Entity — public
├── PaymentService.java       ← @Service — public
├── PaymentCompletedEvent.java ← record — public
├── PaymentFailedEvent.java   ← record — public
└── internal/
    ├── PaymentRepository.java
    └── StockReservedListener.java  ← @ApplicationModuleListener
```

### Controllers Are Package-Private

One important idiom: **controllers should be package-private** (no `public` modifier on the class). Spring's component scan will still find and register them. But no other module can inject or reference them in Java code, reinforcing the boundary.

```java
// CatalogController.java — note: no "public" keyword
@RestController
@RequestMapping("/api/catalog")
@RequiredArgsConstructor
class CatalogController {

    private final CatalogService catalogService;

    @GetMapping
    ResponseEntity<List<Product>> listProducts() {
        return ResponseEntity.ok(catalogService.findAll());
    }
}
```

### Verifying Your Module Structure

You can assert that your module structure is valid in a single test that runs on every build:

```java
class ModuleStructureTests {

    @Test
    void moduleStructureIsValid() {
        ApplicationModules.of(EcommerceApplication.class).verify();
    }
}
```

`verify()` checks:
- No cycles between modules
- No access to `internal/` packages from outside the module
- No direct field injection across module boundaries

If a boundary is violated, this test fails with a clear message identifying exactly which class is illegally referencing which other class.

### The `@ApplicationModule` Annotation

You can explicitly declare a module's display name and restrict its allowed dependencies via a `package-info.java` file at the root of each module package. This is optional but strongly recommended — it turns your dependency rules into failing tests.

```java
// catalog/package-info.java — leaf module, no dependencies
@org.springframework.modulith.ApplicationModule(
    displayName = "Catalog",
    allowedDependencies = {}
)
package com.stevenpg.ecommerce.catalog;
```

```java
// orders/package-info.java — may only depend on catalog
@org.springframework.modulith.ApplicationModule(
    displayName = "Orders",
    allowedDependencies = {"catalog"}
)
package com.stevenpg.ecommerce.orders;
```

```java
// inventory/package-info.java — may only depend on orders
@org.springframework.modulith.ApplicationModule(
    displayName = "Inventory",
    allowedDependencies = {"orders"}
)
package com.stevenpg.ecommerce.inventory;
```

```java
// payments/package-info.java — depends on inventory (events) and orders (direct call)
@org.springframework.modulith.ApplicationModule(
    displayName = "Payments",
    allowedDependencies = {"inventory", "orders"}
)
package com.stevenpg.ecommerce.payments;
```

`allowedDependencies` is checked during `ApplicationModules.verify()`. If a module tries to depend on something not in that list, the verification test fails with a clear error message. Use an empty array to declare a leaf module with zero external dependencies.

### Named Interfaces

By default, only the root package of a module is accessible to other modules. Named Interfaces let you expose a specific sub-package by name, without opening the entire internal package:

```java
// com/stevenpg/ecommerce/orders/spi/package-info.java
@org.springframework.modulith.NamedInterface("spi")
package com.stevenpg.ecommerce.orders.spi;
```

Another module can then depend on just that named interface:

```java
@ApplicationModule(
    allowedDependencies = {"orders::spi"}  // only the spi sub-package, not the full orders module
)
package com.stevenpg.ecommerce.payments;
```

This is useful when a module has a large public API but you want to restrict other modules to a narrow SPI (e.g., event types only) rather than giving them access to your service classes.

## Cross-Module Communication

There are two valid ways for modules to talk to each other. Understanding when to use each is the core design decision in a modular monolith.

### Direct Service Calls

A module may directly inject a public service from another module. This creates a **compile-time, synchronous dependency**:

```java
// orders module directly depends on catalog module
@Service
@RequiredArgsConstructor
public class OrderManagement {

    private final CatalogService catalogService;  // direct cross-module call — allowed

    public Order placeOrder(PlaceOrderCommand command) {
        // Validate product existence via catalog module's public API
        Product product = catalogService.findById(command.productId())
            .orElseThrow(() -> new IllegalArgumentException("Unknown product: " + command.productId()));

        Order order = new Order(command.customerId(), product, command.quantity());
        // ... persist and return
    }
}
```

This is fine when:
- The dependency is intentional and you want the compiler to enforce it
- The called module is a true dependency (orders inherently needs catalog)
- The operation must complete synchronously and you need the return value

### Application Events

When a module needs to notify other modules that something happened, but doesn't care who's listening or what they do, **Application Events** are the right tool. This is Spring's built-in `ApplicationEventPublisher` with Modulith's transactional semantics layered on top.

```java
// orders module publishes an event — no knowledge of who consumes it
@Service
@Transactional
public class OrderManagement {

    private final OrderRepository orders;
    private final CatalogService catalog;
    private final ApplicationEventPublisher events;

    OrderManagement(OrderRepository orders, CatalogService catalog, ApplicationEventPublisher events) {
        this.orders = orders;
        this.catalog = catalog;
        this.events = events;
    }

    public Order placeOrder(PlaceOrderCommand command) {
        var order = new Order(command.customerId());

        for (var item : command.items()) {
            Product product = catalog.findById(item.productId())
                .orElseThrow(() -> new IllegalArgumentException("Product not found: " + item.productId()));
            order.addItem(new OrderItem(product.getId(), product.getName(), item.quantity(), product.getPrice()));
        }

        orders.save(order);

        List<OrderPlacedEvent.LineItem> lineItems = order.getItems().stream()
            .map(i -> new OrderPlacedEvent.LineItem(i.getProductId(), i.getQuantity(), i.getUnitPrice()))
            .toList();

        events.publishEvent(new OrderPlacedEvent(order.getId(), order.getCustomerId(), lineItems, order.total()));

        return order;
    }
}
```

The listener lives in the consuming module's `internal/` package:

```java
// inventory module listens for the orders module's event
@ApplicationModuleListener
class OrderPlacedListener {

    private final InventoryService inventoryService;

    OrderPlacedListener(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }

    void on(OrderPlacedEvent event) {
        inventoryService.reserveStock(event.orderId(), event.items());
    }
}
```

`@ApplicationModuleListener` is doing several things at once:
1. It registers the method as a Spring `@EventListener`
2. It sets the transaction phase to `AFTER_COMMIT` — the listener **only fires after the publishing transaction commits**
3. It runs in its own new transaction
4. When combined with the Event Publication Registry, it guarantees at-least-once delivery

### Events as Immutable Records

Domain events should be immutable value objects. Java records are the natural fit:

```java
// In the orders module's public package — other modules may reference this
public record OrderPlacedEvent(
    UUID orderId,
    UUID customerId,
    List<LineItem> items,
    BigDecimal totalAmount
) {
    public record LineItem(UUID productId, int quantity, BigDecimal unitPrice) {}
}
```

Keep events in the **publishing module's public package**. The consuming module imports the event type — it does not own it. This means the dependency arrow for event consumption still points toward the publisher, which keeps your module graph acyclic.

### The Complete Event Flow

Here's the full saga in the demo application:

```
POST /api/orders
  → OrderManagement.placeOrder()
      → persists Order (status: PENDING)
      → publishes OrderPlacedEvent
          [transaction commits]
          → OrderPlacedListener.on(OrderPlacedEvent)     [AFTER_COMMIT, new tx]
              → inventory.reserveStock()
                  success → publishes StockReservedEvent
                      [transaction commits]
                      → StockReservedListener.on(StockReservedEvent) [AFTER_COMMIT, new tx]
                          → payment gateway call
                              approved → payment.complete()
                                         orderManagement.confirm(orderId)
                                         publishes PaymentCompletedEvent
                              declined → payment.fail()
                                         orderManagement.markPaymentFailed(orderId)
                                         publishes PaymentFailedEvent
                  shortage → publishes StockShortageEvent
```

Each hop has transactional isolation. A failure in the payment step does not roll back the inventory reservation — each listener owns its transaction. This is important to design around: you need to think about compensating actions (what happens if payment fails after stock was reserved) rather than relying on a single database transaction to roll everything back.

## The Event Publication Registry

The Event Publication Registry is one of Spring Modulith's most important features, and it's easy to overlook.

**The problem:** `@ApplicationModuleListener` fires after commit. But what if the application crashes between the publishing commit and the listener completing? The event is lost. You'd need a message broker (Kafka, RabbitMQ) to guarantee delivery. The Event Publication Registry solves this without adding infrastructure.

**How it works:** When you include `spring-modulith-starter-jpa` (or `-jdbc`), every published event is persisted to a database table **within the same transaction** as the publishing operation. The record is marked `STARTED`. Once the listener completes successfully, the record is updated to `COMPLETED` (or deleted, depending on config). On restart, any records still in `STARTED` state are republished.

```yaml
# application.yml
spring:
  modulith:
    events:
      republish-outstanding-events-on-restart: true
      completion-mode: delete        # remove completed events (vs. keeping them for audit)
      staleness:
        processing: 10m              # mark events stuck in STARTED for >10m as FAILED
```

The schema Spring Modulith creates (automatically, via Liquibase or Flyway if you're managing it yourself):

```sql
-- Simplified view of the event_publication table
CREATE TABLE event_publication (
    id           UUID PRIMARY KEY,
    listener_id  VARCHAR(255),   -- identifies which listener this record is for
    event_type   VARCHAR(255),
    serialized_event TEXT,
    publication_date TIMESTAMP,
    completion_date  TIMESTAMP   -- NULL until successfully processed
);
```

### What This Gives You

| Scenario | Behavior |
|---|---|
| Normal flow | Event published → listener runs → record marked complete/deleted |
| App crash before listener runs | On restart, event is republished and listener retries |
| Listener throws exception | Record stays in `STARTED` — will retry on next restart |
| Event stuck > staleness threshold | Marked `FAILED` — visible via `/actuator/modulith` |
| Multiple listeners for same event | Separate record per listener — each tracked independently |

This is at-least-once delivery backed by your existing database. No Kafka required. For many applications, this is entirely sufficient.

### When to Add a Real Message Broker

The Event Publication Registry is not a replacement for Kafka or RabbitMQ in all cases. You still want a dedicated broker when:

- Consumers live in a different service (you've split modules out)
- You need fan-out to many independent consumers
- You need to replay event history beyond application restarts
- Your event throughput exceeds what a relational database handles well

Spring Modulith supports externalizing events to a message broker via `@Externalized`. The format is `"topicName::routingKey"` where the routing key is optional and supports SpEL:

```java
@Externalized("orders.placed")                        // topic name only
public record OrderPlacedEvent(UUID orderId, /* ... */) {}

@Externalized("orders.placed::#{#this.orderId}")      // topic::key — SpEL for partition key
public record OrderShippedEvent(UUID orderId) {}

@Externalized   // no target → defaults to "moduleName.EventClassName"
public record OrderCancelledEvent(UUID orderId) {}
```

For advanced routing (payload transformation, custom headers, filtering), use a configuration bean:

```java
@Bean
EventExternalizationConfiguration eventExternalizationConfiguration() {
    return EventExternalizationConfiguration
        .defaults("com.stevenpg.ecommerce")
        .mapping(OrderPlacedEvent.class, e -> new ExternalOrderPayload(e.orderId()))
        .headers(e -> Map.of("source", "ecommerce-modulith"))
        .build();
}
```

Add the appropriate binder for your broker:

```kotlin
// Kafka
implementation("org.springframework.modulith:spring-modulith-events-kafka")

// RabbitMQ
implementation("org.springframework.modulith:spring-modulith-events-amqp")
```

With this in place, Modulith automatically publishes the event both internally (to `@ApplicationModuleListener` handlers) and externally (to the broker). The Event Publication Registry tracks both publications independently.

## Time-Based Events with Moments

Modulith Moments introduces a set of time-based domain events fired on a configurable schedule:

| Event | Fired when |
|---|---|
| `HourHasPassed` | Every hour |
| `DayHasPassed` | Midnight (start of new day) |
| `WeekHasPassed` | Start of new ISO week |
| `MonthHasPassed` | First of month |
| `QuarterHasPassed` | First day of quarter |
| `YearHasPassed` | January 1st |

These replace `@Scheduled` cron annotations with something module-aware, testable, and retry-capable.

```java
// inventory/internal/DailyInventoryAuditListener.java
@ApplicationModuleListener
class DailyInventoryAuditListener {

    private final InventoryService inventoryService;
    private final ApplicationEventPublisher events;

    DailyInventoryAuditListener(InventoryService inventoryService,
                                 ApplicationEventPublisher events) {
        this.inventoryService = inventoryService;
        this.events = events;
    }

    void on(DayHasPassed event) {
        inventoryService.findAll().stream()
            .filter(item -> item.getAvailableQuantity() < 10)
            .forEach(item -> events.publishEvent(
                new LowStockWarningEvent(item.getProductId(), item.getAvailableQuantity())
            ));
    }
}
```

Enable Moments in your configuration:

```yaml
spring:
  modulith:
    moments:
      zone-id: UTC        # timezone for event timing (default: UTC)
      granularity: hours  # finest granularity to emit (default: hours)
```

### The TimeMachine for Tests

The killer feature of Moments is the `TimeMachine`. Instead of waiting for real clock ticks in your tests, you advance time programmatically:

```java
@ApplicationModuleTest(mode = ALL_DEPENDENCIES)
class InventoryModuleTests {

    @Autowired TimeMachine timeMachine;
    @Autowired InventoryService inventoryService;

    @Test
    void dailyAuditEmitsLowStockWarning(Scenario scenario) {
        // Set up an item with only 5 units
        inventoryService.addItem(someProductId, 5);

        // Advance the clock by one day — fires DayHasPassed
        scenario.stimulate(() -> timeMachine.shiftBy(Duration.ofDays(1)))
            .andWaitForEventOfType(LowStockWarningEvent.class)
            .toArriveAndVerify(warning -> {
                assertThat(warning.productId()).isEqualTo(someProductId);
                assertThat(warning.availableQty()).isLessThan(10);
            });
    }
}
```

Enable the TimeMachine in your test `application.yml` (keep it out of production config):

```yaml
# src/test/resources/application.yml
spring:
  modulith:
    moments:
      enable-time-machine: true
```

## Testing

Testing is where Spring Modulith really earns its keep. You get three progressively broader test modes plus APIs specifically designed for testing event-driven code.

### The Three Bootstrap Modes

`@ApplicationModuleTest` accepts a `mode` parameter that controls which modules Spring loads for the test:

```java
import static org.springframework.modulith.test.ApplicationModuleTest.BootstrapMode.*;
```

**STANDALONE (default)** — loads only the module under test. Its dependencies are not loaded, so you must mock them. Best for pure unit-style integration tests.

```java
@ApplicationModuleTest  // STANDALONE by default
class CatalogModuleTests {

    @Autowired CatalogService catalogService;

    @Test
    void findAllReturnsAllProducts() {
        // Only catalog beans are in the context
        // No orders, inventory, or payments beans
        List<Product> products = catalogService.findAll();
        assertThat(products).isNotEmpty();
    }
}
```

**DIRECT_DEPENDENCIES** — loads the module under test plus its direct dependencies. Useful when the module genuinely needs its neighbors to function.

```java
@ApplicationModuleTest(mode = DIRECT_DEPENDENCIES)
class OrderModuleTests {

    @Autowired OrderManagement orderManagement;
    // CatalogService is available because orders directly depends on catalog

    @Test
    void placeOrderPublishesOrderPlacedEvent(AssertablePublishedEvents events) {
        var command = new PlaceOrderCommand(customerId, productId, 2);

        orderManagement.placeOrder(command);

        // Assert that the event was published with the right data
        assertThat(events)
            .contains(OrderPlacedEvent.class)
            .matching(e -> e.customerId().equals(customerId));
    }
}
```

**ALL_DEPENDENCIES** — loads the module under test and its entire transitive dependency chain. Use this when testing workflows that span multiple modules.

```java
@ApplicationModuleTest(mode = ALL_DEPENDENCIES)
class InventoryModuleTests {

    @Autowired InventoryService inventoryService;
    // Orders and catalog modules are also loaded (inventory transitively needs them)

    @Test
    void reservingStockPublishesStockReservedEvent(Scenario scenario) {
        var event = new OrderPlacedEvent(orderId, customerId, items, total);

        scenario.publish(event)
            .andWaitForStateChange(
                () -> inventoryService.findReservedQuantity(productId),
                reserved -> reserved >= expectedQuantity
            )
            .andVerify(reserved -> assertThat(reserved).isEqualTo(expectedQuantity));
    }
}
```

### AssertablePublishedEvents

`AssertablePublishedEvents` is injected as a test method parameter. It captures all Application Events published during the test and gives you a fluent assertion API:

```java
@Test
void placeOrderPublishesCorrectEvent(AssertablePublishedEvents events) {
    orderManagement.placeOrder(new PlaceOrderCommand(customerId, productId, 3));

    assertThat(events)
        .contains(OrderPlacedEvent.class)
        .matching(e -> e.customerId().equals(customerId))
        .matching(e -> e.items().size() == 1)
        .matching(e -> e.items().get(0).quantity() == 3);
}
```

You can also assert on the absence of events:

```java
assertThat(events)
    .doesNotContain(StockShortageEvent.class);
```

### The Scenario API

`Scenario` is the tool for testing `@ApplicationModuleListener` — the async, `AFTER_COMMIT` listeners. These are notoriously painful to test because they run after the publishing transaction commits, in a new transaction. `Scenario` handles the Awaitility polling for you:

```java
// Testing an event arriving triggers correct state change
@Test
void orderPlacedCausesStockReservation(Scenario scenario) {
    var orderEvent = new OrderPlacedEvent(orderId, customerId, items, total);

    scenario.publish(orderEvent)
        .andWaitForStateChange(
            () -> inventoryService.findByProductId(productId)
                    .map(InventoryItem::getQuantityReserved)
                    .orElse(0),
            reserved -> reserved >= quantity
        )
        .andVerify(reserved -> assertThat(reserved).isEqualTo(quantity));
}

// Testing a shortage path — wait for a specific event to arrive
@Test
void orderPlacedWithInsufficientStockPublishesShortageEvent(Scenario scenario) {
    var orderEvent = new OrderPlacedEvent(orderId, customerId, largeItems, total);

    scenario.publish(orderEvent)
        .andWaitForEventOfType(StockShortageEvent.class)
        .toArriveAndVerify(shortage -> {
            assertThat(shortage.orderId()).isEqualTo(orderId);
        });
}
```

### Module Structure Verification Tests

Add a `ModularityTests` class with no Spring context — these tests run at static bytecode analysis speed:

```java
class ModularityTests {

    static final ApplicationModules modules = ApplicationModules.of(EcommerceApplication.class);

    @Test
    void verifyNoIllegalCrossModuleAccess() {
        modules.verify();
    }

    @Test
    void exactlyFourModulesAreDetected() {
        assertThat(modules.stream()).hasSize(4);
    }

    @ParameterizedTest
    @ValueSource(strings = {"catalog", "orders", "inventory", "payments"})
    void expectedModuleExists(String moduleName) {
        assertThat(modules.getModuleByName(moduleName)).isPresent();
    }

    @Test
    void catalogHasNoExternalModuleDependencies() {
        var deps = modules.getModuleByName("catalog").orElseThrow()
            .getDirectDependencies(modules);
        assertThat(deps.isEmpty()).isTrue();
    }

    @Test
    void ordersOnlyDependsOnCatalog() {
        var depNames = modules.getModuleByName("orders").orElseThrow()
            .getDirectDependencies(modules).uniqueModules()
            .map(m -> m.getIdentifier().toString())
            .toList();
        assertThat(depNames).containsExactlyInAnyOrder("catalog");
    }

    @Test
    void orderPlacedEventBelongsToOrdersModule() {
        assertThat(modules.getModuleByType(OrderPlacedEvent.class))
            .hasValueSatisfying(m -> assertThat(m.getIdentifier().toString()).isEqualTo("orders"));
    }

    @Test
    void generateModuleDocumentation() {
        new Documenter(modules)
            .writeDocumentation()
            .writeIndividualModulesAsPlantUml();
    }
}
```

`modules.stream()` iterates over discovered modules without starting Spring. `getModuleByType()` verifies that an event record lives in the correct module's public package. These assertions turn architectural decisions into executable documentation.

Run `generateModuleDocumentation()` locally to produce PlantUML diagrams in `build/spring-modulith-docs/`. 

These files are generated after executing the test:

![Image of Directory](/assets/modulith/generated_files.png)

Contained within the spring-modulith-docs directory is the summary diagram of the module structure:

![Image of Directory](/assets/modulith/generated_puml.png)

### End-to-End Scenario Tests

When you want to test a workflow that spans the entire module graph, use `@SpringBootTest` with `@EnableScenarios`. This loads the full application context and gives you the `Scenario` API:

```java
@SpringBootTest
@EnableScenarios
class OrderFlowScenarioTests {

    @Autowired OrderManagement orders;
    @Autowired JdbcTemplate jdbc;

    @Test
    void successfulOrderFlowPublishesPaymentCompletedEvent(Scenario scenario) {
        // seed a product
        var productId = UUID.randomUUID();
        jdbc.update("INSERT INTO products (id, name, description, price, sku) VALUES (?, ?, ?, ?, ?)",
            productId, "Gadget", "Full flow test product", new BigDecimal("29.00"),
            "GADGET-" + productId);

        var command = new PlaceOrderCommand(UUID.randomUUID(),
            List.of(new PlaceOrderCommand.Item(productId, 1)));

        // stimulate() wraps the action in a transaction, then waits for the event
        scenario.stimulate(() -> orders.placeOrder(command))
            .andWaitForEventOfType(PaymentCompletedEvent.class)
            .toArriveAndVerify((event, order) ->
                assertThat(event.orderId()).isEqualTo(order.getId())
            );
    }

    @Test
    void orderStatusBecomesConfirmedAfterSuccessfulPayment(Scenario scenario) {
        var placed = new AtomicReference<Order>();
        var command = buildCommand(/* ... */);

        scenario.stimulate(() -> { var o = orders.placeOrder(command); placed.set(o); return o; })
            .andWaitForStateChange(
                () -> orders.findById(placed.get().getId()).map(Order::getStatus).orElse(PENDING),
                status -> status == OrderStatus.CONFIRMED
            )
            .andVerify(finalStatus -> assertThat(finalStatus).isEqualTo(OrderStatus.CONFIRMED));
    }
}
```

The two-argument `toArriveAndVerify((event, result) -> ...)` form gives you both the event and the return value from `stimulate()` — useful for correlating IDs without storing them separately.

### Test Configuration Tips

Keep a `src/test/resources/application.yml` that overrides production settings for module tests:

```yaml
# src/test/resources/application.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1
  jpa:
    hibernate:
      ddl-auto: create-drop
  sql:
    init:
      mode: never          # prevents data.sql from running in module-isolated tests
  modulith:
    moments:
      enable-time-machine: true
```

`sql.init.mode: never` is important. If you have a `data.sql` seed file for the full application, it will fail in `STANDALONE` module tests where only one module's tables exist.

## Observability

### The Actuator Endpoint

With `spring-modulith-actuator` on the classpath and `management.endpoints.web.exposure.include=modulith` in your config, the `/actuator/modulith` endpoint returns your module graph as JSON:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, modulith
```

```
GET /actuator/modulith
```

```json
{
  "catalog": {
    "displayName": "Catalog",
    "basePackage": "com.stevenpg.ecommerce.catalog",
    "nested": [],
    "type": "closed",
    "shared": false,
    "namedInterfaces": {
      "<<UNNAMED>>": [
        "com.stevenpg.ecommerce.catalog.Product",
        "com.stevenpg.ecommerce.catalog.CatalogService"
      ]
    },
    "initializers": [
      "com.stevenpg.ecommerce.catalog.internal.CatalogInitializer"
    ],
    "dependencies": []
  },
  "orders": {
    "displayName": "Orders",
    "basePackage": "com.stevenpg.ecommerce.orders",
    "nested": [],
    "type": "closed",
    "shared": false,
    "namedInterfaces": {
      "<<UNNAMED>>": [
        "com.stevenpg.ecommerce.orders.Order",
        "com.stevenpg.ecommerce.orders.OrderStatus",
        "com.stevenpg.ecommerce.orders.OrderPlacedEvent",
        "com.stevenpg.ecommerce.orders.OrderManagement",
...
```

This is useful for debugging which modules depend on which, and for validating that your intended architecture matches what Modulith has discovered.

### Distributed Tracing for Events

`spring-modulith-observability` instruments every event publication and listener invocation as a Micrometer span. Each `@ApplicationModuleListener` hop becomes a child span of the originating request, giving you end-to-end traces through the entire event saga without any manual instrumentation.

The demo includes a Prometheus + Grafana stack via Docker Compose:

```yaml
# compose.yml excerpt
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./docker/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning
```

Start the stack with `docker compose up -d`, run the app, trigger some orders, and you'll see trace data flowing in Grafana.

### Event Publication Registry Visibility

The Registry also exposes metrics. Any events stuck in `STARTED` state (listener never completed) show up as incomplete publications. You can query the state directly:

```java
// If you need programmatic access to incomplete publications
@Autowired
IncompleteEventPublications incompletePublications;

void checkForStuckEvents() {
    incompletePublications.resubmitIncompletePublicationsOlderThan(Duration.ofMinutes(5));
}
```

This is useful if you want a scheduled job that proactively retries stuck events rather than waiting for app restart.

## Documenting Your Modules

Spring Modulith can generate documentation (including PlantUML component diagrams) directly from your code. Add this to your `ModularityTests` class:

```java
@Test
void writeDocumentationSnippets() {
    new Documenter(ApplicationModules.of(EcommerceApplication.class))
        .writeModulesAsPlantUml()           // overview diagram showing all modules
        .writeIndividualModulesAsPlantUml() // one diagram per module
        .writeModuleCanvases()              // module canvas: beans, events, listeners
        .writeAggregatingDocument();        // all-docs.adoc combining everything
}
```

Output lands in `build/spring-modulith-docs/` (Gradle) or `target/spring-modulith-docs/` (Maven). The `.puml` files render in any PlantUML viewer or can be embedded in Asciidoctor docs.

Customize the diagram style:

```java
new Documenter(modules)
    .writeModulesAsPlantUml(
        DiagramOptions.defaults()
            .withStyle(DiagramStyle.C4)           // C4 model instead of UML (default)
            .withDependencyDepth(DependencyDepth.IMMEDIATE)
            .withColorSelector(module -> Optional.of("#E8F4F8"))
    )
    .writeIndividualModulesAsPlantUml();
```

The component diagram shows:
- Each module as a box
- Public interfaces visible on the boundary
- Internal components hidden
- Dependency arrows between modules
- Event publications as dashed arrows

`writeAggregatingDocument()` produces an `all-docs.adoc` with `include::` directives — suitable for embedding in your project's Asciidoctor documentation pipeline.

For teams maintaining architecture decision records, this is a living diagram that can't drift from the actual code.

## Architectural Patterns and Gotchas

### Don't Reach Into `internal/` — Ever

This sounds obvious but it's worth emphasizing: the whole value of Spring Modulith is that violations are caught automatically. If you start using `@SuppressWarnings` or reflective access to bypass the boundary checker, you lose the primary guarantee. Keep the rule absolute.

### Events Don't Roll Back Across Module Boundaries

This is the hardest conceptual shift from synchronous service calls. When `OrderPlacedListener` runs and then `StockReservedListener` fails, the inventory reservation is **not rolled back**. Each listener owns its transaction. You must design compensating events — a `StockReservationFailedEvent` that tells the orders module to cancel the order.

```java
@ApplicationModuleListener
class OrderPlacedListener {

    @Transactional
    void on(OrderPlacedEvent event) {
        try {
            inventoryService.reserveStock(event.orderId(), event.items());
            events.publishEvent(new StockReservedEvent(event.orderId(), event.totalAmount()));
        } catch (InsufficientStockException ex) {
            // Compensating event — orders module will handle cancellation
            events.publishEvent(new StockShortageEvent(event.orderId(), ex.getProductId()));
        }
    }
}
```

### Module Cycles Are Forbidden

If `catalog` depends on `orders` and `orders` depends on `catalog`, `verify()` fails. This is a feature — cycles in a modular system collapse the boundary enforcement entirely. When you hit a cycle, the solution is almost always to extract the shared concept into a third module (often called `shared` or a domain-specific name like `pricing`).

### Don't Share JPA Entities Across Modules

Each module should own its own data. If two modules need information from the same database row, they should each have their own entity mapping to that row (or to a view), or they should communicate via events rather than sharing a JPA entity class. Sharing JPA entities couples modules at the persistence layer, which is the hardest coupling to untangle later.

### Keep Events Stable

Event types are part of your module's public API. Adding fields is backwards-compatible. Removing or renaming fields breaks consumers. Treat events with the same stability discipline you'd apply to a REST API contract.

## The Path to Microservices

A well-structured Spring Modulith is one refactoring away from being microservices. When a module needs to scale independently or be deployed separately, the migration path is:

1. The module's public service methods become REST or gRPC endpoints
2. The module's `@ApplicationModuleListener` implementations become message broker consumers
3. `@Externalized` on event types already handles publishing to Kafka/RabbitMQ
4. Move the module's package to a new Spring Boot project
5. Update the original application to call the new service's API instead of the in-process service

Because you've maintained clean boundaries throughout, there's no "untangling" phase. The module is already an isolated unit — you're just giving it its own process.

## Quick Reference

### Annotations

| Annotation | Purpose |
|---|---|
| `@ApplicationModule` | Explicit module declaration with allowed dependency constraints; `type = OPEN` for shared utility modules |
| `@ApplicationModuleListener` | Registers listener with `AFTER_COMMIT` semantics and new transaction |
| `@Externalized("topic-name")` | Also publishes event to external broker |
| `@ApplicationModuleTest` | Bootstraps Spring context limited to one module (+ optional deps) |

### Key Classes

| Class / Interface | Purpose |
|---|---|
| `ApplicationModules` | Programmatic access to module graph; call `.verify()` |
| `ApplicationEventPublisher` | Standard Spring publisher — no Modulith-specific class needed |
| `AssertablePublishedEvents` | Test method parameter — captures published events |
| `Scenario` | Test method parameter — async event workflow testing |
| `TimeMachine` | Test-only clock manipulation for Moments |
| `IncompleteEventPublications` | Programmatic access to the Event Publication Registry |
| `Documenter` | Generates PlantUML diagrams from module graph |

### Bootstrap Modes

| Mode | Context contents | Use when |
|---|---|---|
| `STANDALONE` | Module only | Testing module in isolation with mocked dependencies |
| `DIRECT_DEPENDENCIES` | Module + direct deps | Module genuinely needs its direct neighbors |
| `ALL_DEPENDENCIES` | Entire transitive dep chain | Testing cross-module event flows end-to-end |

### Event Publication Registry Config

```yaml
spring:
  modulith:
    events:
      republish-outstanding-events-on-restart: true
      completion-mode: delete   # or "update" to keep completed records for audit
      staleness:
        processing: 10m         # events stuck in STARTED longer than this → FAILED
```

### Moments Config

```yaml
spring:
  modulith:
    moments:
      zone-id: UTC
      granularity: hours
      # Test only:
      enable-time-machine: true
```

## Wrapping Up

Spring Modulith provides the structure that makes a monolith maintainable at scale, without requiring you to solve distributed systems problems before your product is ready for them. The package conventions are simple enough to adopt in an afternoon. The boundary verifier catches drift automatically. The Event Publication Registry gives you at-least-once delivery with zero additional infrastructure. And the testing tools — `@ApplicationModuleTest`, `AssertablePublishedEvents`, `Scenario`, `TimeMachine` — make testing event-driven code actually pleasant.

The demo repository used throughout this post is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-modulith) on the `modulith-demo` branch. All four modules are there with full tests covering every scenario described in this guide.

If you found this useful, the [Spring Cloud Streams guide](/posts/ultimate-guide-spring-cloud-streams/) and [Spring Batch 6 guide](/posts/ultimate-guide-spring-batch-6/) follow the same format for those topics.
