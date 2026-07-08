---
author: StevenPG
pubDatetime: 2026-07-08T00:00:00.000Z
title: "The Ultimate Guide to gRPC with Spring Boot 4.1"
slug: ultimate-guide-spring-grpc
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - grpc
  - protobuf
  - microservices
description: A deep-dive guide to gRPC on Spring Boot 4.1's new first-party gRPC support — how gRPC works, when to use it over REST, and building a full server and client with all four RPC types, error mapping, interceptors, metadata, deadlines, TLS, and testing.
---

# The Ultimate Guide to gRPC with Spring Boot 4.1

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. gRPC has had a rocky history in the Spring world: for years the answer was a well-loved but third-party project (`grpc-spring-boot-starter` by yidongnan/LogNet), and the "official" Spring gRPC project spent a long time as an experimental incubator. Spring Boot **4.1**, released in mid-2026, changed that — gRPC is now a **first-party Spring Boot feature** with starters that live under `org.springframework.boot`, versions managed by Boot's own BOM, and the same autoconfiguration ergonomics you expect from every other starter.

Most gRPC tutorials you'll find are either language-agnostic (all `ManagedChannelBuilder` and `Server.builder()`, none of the Spring wiring) or built on the older third-party starters with different annotations and property names. This guide is the up-to-date, Spring-Boot-4.1-native version.

We're going to cover the full breadth of gRPC: what it is, how HTTP/2 and Protocol Buffers make it work, all four RPC types, when to reach for it over REST — and then build a **complete two-service system**: a pure gRPC `inventory-server` and a `storefront-client` that bridges gRPC to REST/JSON for browsers. Along the way we'll cover error mapping, interceptors, metadata, deadlines, TLS, the Netty server, and testing without opening a port. Every snippet reflects the Spring Boot 4.1 API.

If you already know gRPC, skip to [Project Setup](#project-setup). If you're starting fresh, read straight through.

The full demo repository is linked at the end and referenced throughout.

## What gRPC Actually Is

gRPC is a **contract-first, binary RPC framework**. You describe your service — its methods, their inputs and outputs — in a language-neutral `.proto` file, and a code generator produces strongly-typed client and server code in whatever language you're using. A Java server and a Go client generated from the same `.proto` file are guaranteed to agree on the wire format.

That's the whole pitch, and it's worth internalizing the three pillars:

1. **Protocol Buffers** — the interface definition language (IDL) *and* the binary serialization format.
2. **HTTP/2** — the transport, which gives gRPC multiplexing, streaming, and header compression for free.
3. **Code generation** — you never hand-write serialization or HTTP plumbing; `protoc` does it.

Compared to REST, where the "contract" is usually an OpenAPI document that may or may not match the code, gRPC's contract *is* the code. You cannot accidentally send a field the other side doesn't expect, because both sides are generated from the same source of truth.

### The HTTP/2 Foundation

gRPC runs over HTTP/2, and almost every advantage over classic REST-over-HTTP/1.1 traces back to that choice:

- **Multiplexing** — many concurrent RPCs share a single TCP connection, with no head-of-line blocking at the HTTP layer. HTTP/1.1 needs a connection per in-flight request (hence connection pools).
- **Bidirectional streaming** — HTTP/2 frames let both sides send a sequence of messages on one call, which is what makes gRPC streaming possible at all.
- **Binary framing** — HTTP/2 is binary on the wire, and gRPC layers length-prefixed protobuf messages on top. No text parsing, no chunked-encoding gymnastics.
- **Header compression (HPACK)** — repeated metadata (auth tokens, tracing headers) is compressed across requests on a connection.

The practical consequence: a gRPC **channel** is a long-lived, expensive thing that owns HTTP/2 connections, and a **call** is cheap. This is the inverse of the mental model many REST developers have, and getting it right is most of what "using gRPC well" means. More on that when we build the client.

### Protocol Buffers in 90 Seconds

Protocol Buffers ("protobuf") is how gRPC serializes data. A message is defined as a set of numbered fields:

```protobuf
message Product {
  string sku = 1;
  string name = 2;
  int64 price_cents = 4;
  int32 quantity_available = 6;
}
```

Those **field numbers** — not the field names — are what's written on the wire. This is the source of protobuf's famous forward/backward compatibility: you can rename `name` to `title` and old and new code still interoperate, because both serialize field `2`. You can add new fields freely (old readers ignore unknown field numbers), and you can stop using a field as long as you never reuse its number (use `reserved` to enforce that).

A few rules that trip up newcomers:

- **Everything has a default.** In proto3 there are no "required" fields and, for scalars, no concept of "absent" — an unset `int32` reads back as `0`, an unset `string` as `""`. If you need true optionality, use the `optional` keyword (which adds presence tracking) or a wrapper message.
- **Enums must have a zero value.** The first enum value is the default and must be `0`, which is why you'll see `PRODUCT_CATEGORY_UNSPECIFIED = 0` everywhere — it's the "I didn't set this" sentinel.
- **Generated messages are immutable.** You build them with a builder and read them with getters. There is no setter on a finished message.

The binary encoding is compact (field numbers + varint-encoded values, no field names transmitted) and fast to parse, which is the other half of gRPC's performance story.

### The Four RPC Types

This is the part that genuinely has no REST equivalent, and it's why gRPC exists. A single service can mix all four:

| Type | Shape | Analogy | Our example |
|---|---|---|---|
| **Unary** | 1 request → 1 response | A normal function call | `GetProduct`, `ListProducts` |
| **Server streaming** | 1 request → *N* responses | A subscription / live feed | `WatchStock` |
| **Client streaming** | *N* requests → 1 response | A batch upload | `RecordShipments` |
| **Bidirectional streaming** | *N* requests ↔ *N* responses | A phone call | `ProcessOrders` |

Unary is what you'd do with REST anyway. The three streaming variants are where gRPC shines — a live stock feed, a bulk ingest that processes items as they arrive, or a fully duplex pipeline where responses come back while you're still sending requests. We'll implement all four.

## gRPC vs REST vs GraphQL vs Messaging

The most common question I get is "when do I actually use this?" Here's my honest framing.

**Reach for gRPC when:**

- **Service-to-service, inside your own network.** This is the sweet spot. Internal microservices calling each other benefit from the performance, the strict contract, and the multiplexing. The generated clients mean no hand-written HTTP glue between teams.
- **You need streaming.** Live feeds, telemetry, chat, progress updates, bulk pipelines. Server-Sent Events and WebSockets can approximate some of this over REST, but nothing is as clean as a typed bidirectional stream.
- **Polyglot systems.** One `.proto` file generates matching clients for Java, Go, Python, Rust, TypeScript, etc. The contract is enforced mechanically across languages.
- **High call volume / low latency budgets.** Binary protobuf over multiplexed HTTP/2 is meaningfully cheaper than JSON over HTTP/1.1 at scale.

**Stick with REST when:**

- **Browsers or third parties are the primary consumers.** Browsers can't speak raw gRPC (they can't control HTTP/2 framing from JS) — you need gRPC-Web plus a proxy. Public APIs consumed by unknown clients are almost always better as REST/JSON. That's exactly why our demo puts a REST facade in front of the gRPC service.
- **Human-debuggability matters more than performance.** `curl` and a browser dev-tools tab beat `grpcurl` for casual inspection, even though gRPC's reflection makes tooling surprisingly good (we'll see).
- **You're doing simple CRUD** and don't need streaming or cross-language codegen. The ceremony isn't worth it.

**GraphQL** solves a different problem — flexible client-driven queries over a graph of data, typically for frontends that want to avoid over/under-fetching. It's not competing with gRPC for internal RPC; if anything they coexist (GraphQL gateway out front, gRPC to backend services).

**Async messaging (Kafka, RabbitMQ, Spring Cloud Stream)** is the right tool when you want *decoupling* and *durability* — fire-and-forget events, work queues, event sourcing. gRPC is synchronous request/response (even its streams are within a single call). If the caller shouldn't wait and the message should survive a consumer being down, use a broker, not gRPC. I have a [whole guide on Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams) for that world.

A mature system uses all of these. The demo in this guide is deliberately the most common gRPC topology: **REST at the edge, gRPC between services.**

## The Contract: Our `.proto` File

Everything starts with the contract. Here's the full service definition for our inventory system — one service exercising all four RPC types:

```protobuf
syntax = "proto3";

package inventory.v1;

option java_multiple_files = true;
option java_package = "com.stevenpg.grpc.inventory.proto";
option java_outer_classname = "InventoryProto";

import "google/protobuf/timestamp.proto";

service InventoryService {
  rpc GetProduct(GetProductRequest) returns (Product);                     // unary
  rpc ListProducts(ListProductsRequest) returns (ListProductsResponse);    // unary
  rpc WatchStock(WatchStockRequest) returns (stream StockUpdate);          // server streaming
  rpc RecordShipments(stream Shipment) returns (ShipmentSummary);          // client streaming
  rpc ProcessOrders(stream OrderRequest) returns (stream OrderStatus);     // bidirectional
}
```

The `stream` keyword on either side of `returns` is the *only* thing that distinguishes the four RPC types. Read it left to right: `WatchStock` takes one request and returns a `stream` of `StockUpdate`; `ProcessOrders` streams in both directions.

The messages are ordinary protobuf. A couple of features worth pointing out because they show up later:

```protobuf
message Product {
  string sku = 1;
  string name = 2;
  string description = 3;
  int64 price_cents = 4;
  string currency = 5;
  int32 quantity_available = 6;
  ProductCategory category = 7;
  google.protobuf.Timestamp updated_at = 8;   // a "well-known type"
}

enum ProductCategory {
  PRODUCT_CATEGORY_UNSPECIFIED = 0;   // required zero value = default
  PRODUCT_CATEGORY_ELECTRONICS = 1;
  PRODUCT_CATEGORY_BOOKS = 2;
  PRODUCT_CATEGORY_APPAREL = 3;
  PRODUCT_CATEGORY_GROCERY = 4;
}

message StockUpdate {
  string sku = 1;
  int32 quantity_available = 2;
  oneof reason {                 // exactly one of these is set
    Sale sale = 3;
    Restock restock = 4;
  }
  google.protobuf.Timestamp occurred_at = 5;

  message Sale { int32 units_sold = 1; }
  message Restock { int32 units_added = 1; string supplier = 2; }
}
```

Two things to notice:

- **Well-known types** like `google.protobuf.Timestamp` ship with protobuf; you `import` them and they map to a `{seconds, nanos}` pair (which we'll convert to/from `java.time.Instant`).
- **`oneof`** models "exactly one of these fields is set." On the Java side it generates a `getReasonCase()` enum you `switch` over — the compiler-enforced version of a tagged union.

Notice the package is `inventory.v1`. **Versioning your package** (`v1`, `v2`) from day one is a gRPC best practice — it lets you run two major versions side by side during a migration.

## Code Generation: What `protoc` Gives You

You never hand-write the Java for these messages. At build time, `protoc` (the protobuf compiler) plus the gRPC Java plugin generate:

- **Message classes** — `Product`, `StockUpdate`, `Shipment`, … each immutable with a `Builder`.
- **A service base class** — `InventoryServiceGrpc.InventoryServiceImplBase`. You **extend** this on the server and override one method per RPC.
- **Client stubs** — three flavors:
  - `InventoryServiceBlockingStub` — synchronous; unary calls look like local method calls, server streams come back as an `Iterator`.
  - `InventoryServiceStub` — asynchronous, callback-based via `StreamObserver`. Required for client-streaming and bidirectional RPCs.
  - `InventoryServiceFutureStub` — returns `ListenableFuture` for unary calls.

Generated code is **never committed to git** — it's regenerated on every build so it can never drift from the `.proto`. That's why the shared contract lives in its own module that both the server and client depend on.

## Project Setup

A real gRPC system is almost always a **multi-module build**: one module owns the `.proto` files and the generated code, and every service depends on it. That guarantees the server and client can never disagree about the wire format.

```
grpc-spring-boot-ultimate-guide/
├── inventory-proto/       # .proto files + generated code (the contract)
├── inventory-server/      # pure gRPC service on :9090 (no HTTP)
└── storefront-client/     # Spring MVC app on :8080, gRPC client of the above
```

In large organizations the proto module is often its own repository (or published to a [Buf](https://buf.build) registry) so services in *any* language generate matching stubs from it.

### Version Matrix

Everything here is managed by Spring Boot 4.1's BOM, so you state versions once:

| Component | Version |
|---|---|
| Java | 21 |
| Spring Boot | 4.1.0 |
| `spring-grpc-core` (Spring gRPC) | 1.1.0 (via Boot BOM) |
| `grpc-java` | 1.80.0 (via Boot BOM) |
| protobuf | 4.34.2 (via Boot BOM) |
| protobuf Gradle plugin | 0.9.5 |

### The Proto Module (Gradle)

This module contains **no hand-written Java** — just `.proto` files and the codegen configuration:

```kotlin
// inventory-proto/build.gradle.kts
import com.google.protobuf.gradle.id

plugins {
    `java-library`
    id("com.google.protobuf")   // wires protoc into the Gradle build
}

java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}

// These match the versions Spring Boot 4.1's BOM manages, so generated
// code lines up exactly with the runtime libraries the services resolve.
val protobufVersion = "4.34.2"
val grpcVersion = "1.80.0"

dependencies {
    // Pin the gRPC/protobuf runtime and export it to dependents.
    api(platform("io.grpc:grpc-bom:$grpcVersion"))
    api(platform("com.google.protobuf:protobuf-bom:$protobufVersion"))

    api("io.grpc:grpc-protobuf")             // marshals protobuf over gRPC
    api("io.grpc:grpc-stub")                 // base classes for stubs
    api("com.google.protobuf:protobuf-java") // core protobuf runtime
}

protobuf {
    protoc {
        // Gradle downloads protoc from Maven Central — nobody installs it by hand.
        artifact = "com.google.protobuf:protoc:$protobufVersion"
    }
    plugins {
        // protoc alone only generates messages; this plugin adds the
        // service base class and the client stubs.
        id("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:$grpcVersion" }
    }
    generateProtoTasks {
        all().forEach { task -> task.plugins { id("grpc") } }
    }
}
```

`./gradlew build` runs `protoc`, drops the generated sources under `build/generated/`, and compiles them. Put your `.proto` files under `src/main/proto/` (we use `src/main/proto/inventory/v1/inventory.proto`).

### The Proto Module (Maven)

If you're on Maven, the equivalent uses the `os-maven-plugin` extension (to pick the right native `protoc`) and the `protobuf-maven-plugin`:

```xml
<build>
  <extensions>
    <extension>
      <groupId>kr.motd.maven</groupId>
      <artifactId>os-maven-plugin</artifactId>
      <version>1.7.1</version>
    </extension>
  </extensions>
  <plugins>
    <plugin>
      <groupId>org.xolstice.maven.plugins</groupId>
      <artifactId>protobuf-maven-plugin</artifactId>
      <version>0.6.1</version>
      <configuration>
        <protocArtifact>com.google.protobuf:protoc:4.34.2:exe:${os.detected.classifier}</protocArtifact>
        <pluginId>grpc-java</pluginId>
        <pluginArtifact>io.grpc:protoc-gen-grpc-java:1.80.0:exe:${os.detected.classifier}</pluginArtifact>
      </configuration>
      <executions>
        <execution>
          <goals>
            <goal>compile</goal>        <!-- message classes -->
            <goal>compile-custom</goal> <!-- gRPC service + stubs -->
          </goals>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

With Spring Boot's parent POM (`spring-boot-starter-parent` 4.1.0) managing the BOM, you don't specify versions on the `io.grpc`/`protobuf` runtime dependencies themselves — just the plugin/extension versions above. The rest of this guide uses Gradle for brevity; the Java and configuration are identical either way.

### Server and Client Starters

The two new first-party starters are the whole story:

```kotlin
// inventory-server/build.gradle.kts
dependencies {
    implementation(project(":inventory-proto"))  // the shared contract

    // Discovers every BindableService bean, builds the Netty gRPC server,
    // applies interceptors + exception handlers, registers reflection and
    // health services. All io.grpc/protobuf versions managed by Boot's BOM.
    implementation("org.springframework.boot:spring-boot-starter-grpc-server")

    // @AutoConfigureTestGrpcTransport: in-process transport for tests.
    testImplementation("org.springframework.boot:spring-boot-starter-grpc-server-test")
}
```

```kotlin
// storefront-client/build.gradle.kts
dependencies {
    implementation(project(":inventory-proto"))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")   // REST edge
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-grpc-client")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}
```

Note the server module pulls in **no web starter at all** — it speaks only gRPC.

## Building the Server

### The Application Class — Nothing gRPC-Specific

```java
@SpringBootApplication
public class InventoryServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(InventoryServerApplication.class, args);
    }
}
```

That's it — and that's the point. `spring-boot-starter-grpc-server` autoconfigures a **Netty-based gRPC server** and registers every Spring bean that implements `io.grpc.BindableService` (which every generated `*ImplBase` class does). No `Server.builder()`, no manual `addService()`, no port juggling.

On startup you'll see Spring wire it together:

```
o.s.grpc.server.NettyGrpcServerFactory : Registered gRPC service: inventory.v1.InventoryService
o.s.grpc.server.NettyGrpcServerFactory : Registered gRPC service: grpc.reflection.v1.ServerReflection
o.s.grpc.server.NettyGrpcServerFactory : Registered gRPC service: grpc.health.v1.Health
```

The reflection and health services come for free (more on those under [production concerns](#production-concerns)).

### The Service Implementation

Here's where the RPCs get implemented. We extend the generated `InventoryServiceImplBase`, annotate the class `@Service`, and Spring gRPC binds it to the Netty server automatically.

The mental model for every method: you receive a **`StreamObserver` for the *response* side**, with three methods — `onNext(msg)` sends a message, `onCompleted()` closes the stream successfully, `onError(t)` closes it with a gRPC status.

#### Unary

One request in, one response out. Call `onNext` exactly once, then `onCompleted`:

```java
@Service
public class InventoryGrpcService extends InventoryServiceGrpc.InventoryServiceImplBase {

    private final InventoryRepository repository;

    public InventoryGrpcService(InventoryRepository repository) {
        this.repository = repository; // plain constructor injection — it's a normal bean
    }

    @Override
    public void getProduct(GetProductRequest request, StreamObserver<Product> responseObserver) {
        ProductRecord record = repository.findBySku(request.getSku())
                // We don't handle this here — a GrpcExceptionHandler maps it to
                // NOT_FOUND centrally, keeping business code free of transport concerns.
                .orElseThrow(() -> new ProductNotFoundException(request.getSku()));

        responseObserver.onNext(toProto(record));
        responseObserver.onCompleted();
    }
}
```

Because the service is a normal Spring bean, it can inject repositories, clients, metrics — anything. Notice we throw a plain business exception and let a central handler translate it; that's the gRPC equivalent of `@RestControllerAdvice`, covered [below](#error-handling-and-status-codes).

I keep a separate **domain model** (`ProductRecord`, a Java record) distinct from the generated `Product` protobuf, and map between them at the service boundary. Same discipline as not exposing JPA entities from a REST controller: the wire contract evolves for API reasons, the domain evolves for business reasons.

```java
private static Product toProto(ProductRecord record) {
    return Product.newBuilder()   // protobuf messages are immutable — always built
            .setSku(record.sku())
            .setName(record.name())
            .setPriceCents(record.priceCents())
            .setCurrency(record.currency())
            .setQuantityAvailable(record.quantityAvailable())
            .setCategory(record.category())
            .setUpdatedAt(toTimestamp(record.updatedAt()))
            .build();
}
```

#### Server Streaming

One request, many responses. Call `onNext` as many times as you like, then `onCompleted`. The critical discipline here is **checking for client cancellation** — a long-lived stream that keeps writing after the client hung up is the classic gRPC resource leak:

```java
@Override
public void watchStock(WatchStockRequest request, StreamObserver<StockUpdate> responseObserver) {
    ProductRecord product = repository.findBySku(request.getSku())
            .orElseThrow(() -> new ProductNotFoundException(request.getSku()));

    int updates = request.getMaxUpdates() > 0 ? request.getMaxUpdates() : DEFAULT_WATCH_UPDATES;
    int quantity = product.quantityAvailable();

    for (int i = 0; i < updates; i++) {
        // If the client hangs up (or its deadline expires) and we keep writing,
        // we waste server resources. ALWAYS check on long-lived streams.
        if (Context.current().isCancelled()) {
            log.info("watchStock({}) cancelled by client after {} updates", request.getSku(), i);
            return; // no onCompleted — the call is already dead
        }

        StockUpdate.Builder update = StockUpdate.newBuilder()
                .setSku(request.getSku())
                .setOccurredAt(toTimestamp(Instant.now()));
        // ... simulate a sale or a restock, set the oneof branch ...
        update.setQuantityAvailable(quantity);

        responseObserver.onNext(update.build()); // pushed to the client immediately
        sleep(400);                              // pace the demo so streaming is visible
    }
    responseObserver.onCompleted(); // "no more updates, clean shutdown"
}
```

Each `onNext` is a message pushed to the client *right now* — this is a live feed, not a buffered list returned at the end.

#### Client Streaming

Now the control inverts. For client-streaming and bidirectional RPCs, *you* **return** a `StreamObserver`, and gRPC feeds the client's incoming messages into it. State accumulated across messages lives in the observer instance — one per call, so no cross-request leakage:

```java
@Override
public StreamObserver<Shipment> recordShipments(StreamObserver<ShipmentSummary> responseObserver) {
    return new StreamObserver<>() {
        private final AtomicInteger shipmentCount = new AtomicInteger();
        private final AtomicInteger totalUnits = new AtomicInteger();
        private final Map<String, Integer> updatedQuantities = new LinkedHashMap<>();

        @Override
        public void onNext(Shipment shipment) {   // once per message the client streams up
            repository.restock(shipment.getSku(), shipment.getQuantity())
                    .ifPresent(updated -> {
                        shipmentCount.incrementAndGet();
                        totalUnits.addAndGet(shipment.getQuantity());
                        updatedQuantities.put(updated.sku(), updated.quantityAvailable());
                    });
        }

        @Override
        public void onError(Throwable t) {   // client aborted mid-stream — release resources
            log.warn("recordShipments stream aborted by client", t);
        }

        @Override
        public void onCompleted() {   // client finished — NOW send our single aggregated response
            responseObserver.onNext(ShipmentSummary.newBuilder()
                    .setShipmentsReceived(shipmentCount.get())
                    .setTotalUnitsAdded(totalUnits.get())
                    .putAllUpdatedQuantities(updatedQuantities)
                    .build());
            responseObserver.onCompleted();
        }
    };
}
```

The response goes out in `onCompleted()`, after the client has sent everything.

#### Bidirectional Streaming

Both sides stream independently. This implementation answers each order as it arrives (a pipelined request/response), but nothing *requires* that shape — the server could batch, reorder, or push unsolicited messages. The two directions are fully independent:

```java
@Override
public StreamObserver<OrderRequest> processOrders(StreamObserver<OrderStatus> responseObserver) {
    return new StreamObserver<>() {
        @Override
        public void onNext(OrderRequest order) {
            OrderStatus.Builder status = OrderStatus.newBuilder().setOrderId(order.getOrderId());
            // ... look up SKU, try to sell, set CONFIRMED / OUT_OF_STOCK / UNKNOWN_SKU ...

            // Respond immediately, while the client may still be sending more orders —
            // both streams are live at the same time.
            responseObserver.onNext(status.build());
        }

        @Override public void onError(Throwable t) { log.warn("processOrders aborted", t); }
        @Override public void onCompleted() { responseObserver.onCompleted(); }
    };
}
```

Always echo a correlation ID (here `order_id`) on the response — because responses can arrive in any order relative to requests, the caller needs it to match them up.

### Server Configuration

The server's `application.yml` controls the port and the standard services:

```yaml
spring:
  application:
    name: inventory-server
  grpc:
    server:
      port: 9090            # 9090 is the default; set it explicitly for clarity
      reflection:
        enabled: true       # lets grpcurl/Postman discover the API at runtime
      health:
        enabled: true       # grpc.health.v1.Health — k8s/LB probes use this
      shutdown:
        grace-period: 10s   # wait for in-flight RPCs on shutdown

logging:
  level:
    org.springframework.grpc: info
```

## Building the Client

### Channels and Stubs: The Core Concepts

Before any code, internalize these two objects — misunderstanding them is the #1 source of gRPC performance problems:

- **Channel** — a managed, long-lived virtual connection to a target. It owns the HTTP/2 connections, reconnection/backoff, load balancing, and TLS. Channels are **expensive**: create **one per target service** and share it for the whole application's lifetime. Creating a channel per request is the classic mistake — it throws away connection reuse and multiplexing entirely.
- **Stub** — a lightweight, immutable, thread-safe view over a channel, generated by `protoc`. Stubs are **cheap**. The `with*` methods (`withDeadlineAfter`, `withCallCredentials`, …) return *new* stubs, which is why per-call settings like deadlines are applied at the call site, not baked into a bean.

Spring Boot 4.1 gives you the `GrpcChannelFactory`, which builds channels from **named configuration** so target, TLS, and keep-alive live in `application.yml` instead of code.

### Configuring the Channel

```yaml
spring:
  grpc:
    client:
      channel:
        inventory:                       # a NAMED channel
          target: "static://localhost:9090"
          keepalive:                     # HTTP/2 pings detect half-dead connections
            time: 30s                    # far faster than TCP timeouts on NAT/LB drops
            timeout: 5s
```

The `inventory` key names a channel that `GrpcChannelFactory.createChannel("inventory")` resolves. The `target` scheme matters:

- `static://host:port` — a fixed host list, no discovery.
- `dns:///inventory.svc:9090` — DNS-based resolution with round-robin across the returned addresses.
- A custom `NameResolver` — for service meshes / custom discovery.

Because it's just configuration, every value is overridable per environment (e.g. `SPRING_GRPC_CLIENT_CHANNEL_INVENTORY_TARGET` in Kubernetes).

### Declaring the Stubs

```java
@Configuration(proxyBeanMethods = false)
public class GrpcClientConfig {

    @Bean
    InventoryServiceGrpc.InventoryServiceBlockingStub inventoryBlockingStub(GrpcChannelFactory channels) {
        ManagedChannel channel = channels.createChannel("inventory"); // resolves the named config
        return InventoryServiceGrpc.newBlockingStub(channel);
    }

    @Bean
    InventoryServiceGrpc.InventoryServiceStub inventoryAsyncStub(GrpcChannelFactory channels) {
        // Same channel name -> Spring gRPC reuses the same underlying channel.
        // We are NOT opening a second connection.
        ManagedChannel channel = channels.createChannel("inventory");
        return InventoryServiceGrpc.newStub(channel);
    }
}
```

We expose two stubs because they serve different jobs:

- **Blocking stub** — one call at a time, synchronous. Perfect inside a servlet MVC app for unary calls; it exposes server streams as a plain `Iterator`.
- **Async stub** — callback-based via `StreamObserver`. **Required** for client-streaming and bidirectional RPCs (a blocking API can't express "send while receiving"), and the right tool for fanning a server stream out to SSE.

> There's a shortcut: `@ImportGrpcClients(target = "inventory", types = { ... })` registers stub beans for you. The explicit version above shows what actually happens under the hood — pick whichever you prefer.

### The REST Facade

The controller is where the two worlds meet. One endpoint per RPC shape:

```
GET  /api/products                     -> unary            (blocking stub)
GET  /api/products/{sku}               -> unary + deadline  (blocking stub)
GET  /api/products/{sku}/stock/stream  -> server streaming  (async stub -> SSE)
POST /api/shipments                    -> client streaming  (async stub)
POST /api/orders                       -> bidi streaming    (async stub)
```

**Unary looks like a local method call:**

```java
@GetMapping("/products")
public List<ProductDto> listProducts() {
    return blockingStub
            .listProducts(ListProductsRequest.getDefaultInstance())
            .getProductsList().stream()
            .map(ProductDto::from)
            .toList();
}
```

**Unary with a deadline** — the single most important gRPC production habit:

```java
@GetMapping("/products/{sku}")
public ProductDto getProduct(@PathVariable String sku) {
    // A deadline is an ABSOLUTE point in time after which the call is abandoned.
    // It PROPAGATES over the wire, so the server (and anything IT calls) can stop
    // wasted work. Without one, a hung downstream holds your threads forever.
    // withDeadlineAfter returns a NEW stub, so this is per-call.
    return ProductDto.from(blockingStub
            .withDeadlineAfter(2, TimeUnit.SECONDS)
            .getProduct(GetProductRequest.newBuilder().setSku(sku).build()));
    // Miss the deadline -> client gets DEADLINE_EXCEEDED -> mapped to HTTP 504.
}
```

Deadlines deserve emphasis. Unlike a client-side socket timeout, a gRPC **deadline propagates**: it's carried in call metadata, so a chain of services all share the same "give up at time T" budget. Set one on every call. Always.

**Server streaming, fanned out to Server-Sent Events** — the async stub's callbacks run on gRPC threads and push each message to the browser as it arrives:

```java
@GetMapping(value = "/products/{sku}/stock/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter streamStock(@PathVariable String sku, @RequestParam(defaultValue = "5") int updates) {
    SseEmitter emitter = new SseEmitter(0L); // no servlet timeout; the gRPC deadline bounds it

    asyncStub.withDeadlineAfter(30, TimeUnit.SECONDS)
        .watchStock(WatchStockRequest.newBuilder().setSku(sku).setMaxUpdates(updates).build(),
            new StreamObserver<>() {
                @Override public void onNext(StockUpdate update) {
                    try {
                        emitter.send(SseEmitter.event().name("stock-update").data(StockUpdateDto.from(update)));
                    } catch (Exception ex) {
                        log.debug("SSE client went away", ex); // deadline will reap the gRPC call
                    }
                }
                @Override public void onError(Throwable t) { emitter.completeWithError(t); }
                @Override public void onCompleted() { emitter.complete(); }
            });

    return emitter; // returned long before the stream finishes — this is push, not polling
}
```

**Client and bidirectional streaming** both use the async stub and, because MVC endpoints are synchronous, bridge back to blocking with a `CountDownLatch`:

```java
@PostMapping("/orders")
public OrderBatchResultDto processOrders(@RequestBody List<OrderDto> orders) throws InterruptedException {
    CountDownLatch done = new CountDownLatch(1);
    List<OrderStatusDto> statuses = new CopyOnWriteArrayList<>();

    // For streaming, the stub hands US an observer to write into, and we hand IT
    // an observer for the responses.
    StreamObserver<OrderRequest> orderStream = asyncStub.processOrders(new StreamObserver<>() {
        @Override public void onNext(OrderStatus status) {
            log.info("<- order {} : {}", status.getOrderId(), status.getResult()); // arrives while we send below
            statuses.add(OrderStatusDto.from(status));
        }
        @Override public void onError(Throwable t) { done.countDown(); }
        @Override public void onCompleted() { done.countDown(); }
    });

    for (OrderDto dto : orders) {
        log.info("-> order {} ({} x {})", dto.orderId(), dto.quantity(), dto.sku());
        orderStream.onNext(OrderRequest.newBuilder()
                .setOrderId(dto.orderId()).setSku(dto.sku()).setQuantity(dto.quantity()).build());
    }
    orderStream.onCompleted(); // half-close our side

    if (!done.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("timed out");
    return new OrderBatchResultDto(statuses);
}
```

Run it and watch the logs — `<- order-001` confirmations arrive *between* the `-> order-00X` sends. That interleaving is the signature of bidirectional streaming, and it's impossible with plain REST.

One more edge detail: I map protobuf messages to hand-written **DTOs** for the JSON layer rather than serializing protobuf directly. Generated protobuf classes aren't JavaBean-friendly (Jackson trips over their internals), and the REST contract should be free to differ from the gRPC one. If you *do* want mechanical proto↔JSON, protobuf ships `JsonFormat` in `protobuf-java-util` implementing the official proto3 JSON mapping.

## Error Handling and Status Codes

gRPC has no HTTP status codes. It has its own smaller set — `OK`, `NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `RESOURCE_EXHAUSTED`, and a handful more — carried in the call's trailing metadata.

The trap: an **uncaught server exception surfaces to clients as `UNKNOWN`**, which tells them nothing. Mapping business exceptions to meaningful codes is as important as `@RestControllerAdvice` is in a REST API.

### On the Server: Exception → Status

Spring gRPC applies every `GrpcExceptionHandler` bean to every service automatically. A handler returns a `StatusException` for exceptions it understands, or `null` to pass the exception along:

```java
@Configuration(proxyBeanMethods = false)
public class GrpcExceptionConfig {

    @Bean
    GrpcExceptionHandler productNotFoundHandler() {
        return exception -> {
            if (exception instanceof ProductNotFoundException notFound) {
                // The description travels to the client — keep it helpful,
                // but never leak internals (stack traces, SQL, ...).
                return Status.NOT_FOUND.withDescription(notFound.getMessage()).asException();
            }
            return null; // not ours — let the next handler (or UNKNOWN) apply
        };
    }

    @Bean
    GrpcExceptionHandler validationHandler() {
        return exception -> exception instanceof IllegalArgumentException bad
                ? Status.INVALID_ARGUMENT.withDescription(bad.getMessage()).asException()
                : null;
    }
}
```

This keeps `ProductNotFoundException` a plain business exception that knows nothing about gRPC — the transport concern lives entirely in one config class.

### On the Client: Status → HTTP

Blocking stubs throw `StatusRuntimeException` carrying the gRPC status. At the REST edge we map it back to HTTP — the mirror image of the server's handler:

```java
@RestControllerAdvice
public class GrpcStatusRestAdvice {

    @ExceptionHandler(StatusRuntimeException.class)
    ResponseEntity<GrpcErrorBody> handleGrpcStatus(StatusRuntimeException ex) {
        HttpStatus http = switch (ex.getStatus().getCode()) {
            case NOT_FOUND -> HttpStatus.NOT_FOUND;                         // 404
            case INVALID_ARGUMENT, OUT_OF_RANGE -> HttpStatus.BAD_REQUEST;  // 400
            case ALREADY_EXISTS, ABORTED -> HttpStatus.CONFLICT;            // 409
            case PERMISSION_DENIED -> HttpStatus.FORBIDDEN;                 // 403
            case UNAUTHENTICATED -> HttpStatus.UNAUTHORIZED;               // 401
            case RESOURCE_EXHAUSTED -> HttpStatus.TOO_MANY_REQUESTS;       // 429
            case FAILED_PRECONDITION -> HttpStatus.PRECONDITION_FAILED;    // 412
            case UNIMPLEMENTED -> HttpStatus.NOT_IMPLEMENTED;              // 501
            case UNAVAILABLE -> HttpStatus.SERVICE_UNAVAILABLE;            // 503
            case DEADLINE_EXCEEDED -> HttpStatus.GATEWAY_TIMEOUT;          // 504
            default -> HttpStatus.INTERNAL_SERVER_ERROR;                   // 500
        };
        return ResponseEntity.status(http).body(new GrpcErrorBody(
                ex.getStatus().getCode().name(), ex.getStatus().getDescription()));
    }

    record GrpcErrorBody(String grpcStatus, String message) {}
}
```

That mapping follows the conventions of the official [grpc-gateway](https://github.com/grpc-ecosystem/grpc-gateway) project. End to end: a bad SKU throws `ProductNotFoundException` → server maps it to `NOT_FOUND` → client throws `StatusRuntimeException` → edge returns HTTP 404 with a clean JSON body. No stack traces leak, and every layer speaks its native error vocabulary.

## Interceptors and Metadata

Interceptors are gRPC's equivalent of servlet filters — they see every call before the handler runs and can read/write **metadata** (gRPC's name for headers/trailers), add auth, metrics, tracing, or short-circuit the call.

### Server-Side Interceptor

`@GlobalServerInterceptor` applies the bean to every service on the server (without it you'd list interceptors per-service):

```java
@Configuration(proxyBeanMethods = false)
public class GrpcInterceptorConfig {

    // Metadata keys are declared once; the key carries the header name and how
    // to (de)serialize it. Binary headers are allowed — their names must end in "-bin".
    static final Metadata.Key<String> CLIENT_ID_KEY =
            Metadata.Key.of("x-client-id", Metadata.ASCII_STRING_MARSHALLER);

    @Bean
    @GlobalServerInterceptor
    ServerInterceptor requestLoggingInterceptor() {
        return new ServerInterceptor() {
            @Override
            public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                    ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {

                String method = call.getMethodDescriptor().getFullMethodName(); // e.g. inventory.v1.InventoryService/GetProduct
                String clientId = headers.get(CLIENT_ID_KEY);                   // read a header the client attached
                long startNanos = System.nanoTime();

                // Wrap the call to observe its completion status + timing.
                ServerCall<ReqT, RespT> timed = new SimpleForwardingServerCall<>(call) {
                    @Override public void close(Status status, Metadata trailers) {
                        long ms = (System.nanoTime() - startNanos) / 1_000_000;
                        log.info("gRPC {} from client [{}] -> {} in {} ms",
                                method, clientId != null ? clientId : "anonymous", status.getCode(), ms);
                        super.close(status, trailers);
                    }
                };
                return next.startCall(timed, headers);
            }
        };
    }
}
```

### Client-Side Interceptor

The other half of the same feature: `@GlobalClientInterceptor` attaches metadata to every outbound call. This is exactly where an **auth token** goes — swap the static ID below for a real token supplier and this becomes your auth plumbing:

```java
@Configuration(proxyBeanMethods = false)
public class GrpcClientInterceptorConfig {

    private static final Metadata.Key<String> CLIENT_ID_KEY =
            Metadata.Key.of("x-client-id", Metadata.ASCII_STRING_MARSHALLER);

    @Bean
    @GlobalClientInterceptor
    ClientInterceptor clientIdInterceptor() {
        return new ClientInterceptor() {
            @Override
            public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions opts, Channel next) {
                return new SimpleForwardingClientCall<>(next.newCall(method, opts)) {
                    @Override public void start(Listener<RespT> listener, Metadata headers) {
                        headers.put(CLIENT_ID_KEY, "storefront-client"); // authorization: Bearer ... goes here IRL
                        super.start(listener, headers);
                    }
                };
            }
        };
    }
}
```

The client attaches `x-client-id`; the server's interceptor reads it back out and logs it. That round-trip — the two ends of one feature — is the metadata pattern you'll use for auth, correlation IDs, and tenant routing. The conventional key for auth is `authorization` with a `Bearer <token>` value, exactly like HTTP.

## Testing

Spring Boot 4.1's gRPC test starter gives you `@AutoConfigureTestGrpcTransport`, which swaps the Netty server for gRPC's **in-process transport**. Requests still flow through the *complete* server pipeline — interceptors, exception handlers, marshalling — so you test exactly what production runs, minus TCP. No ports, no flakiness, fast.

```java
@SpringBootTest
@AutoConfigureTestGrpcTransport
class InventoryGrpcServiceIntegrationTest {

    @Autowired
    private GrpcChannelFactory channels; // hands back an in-process channel regardless of address

    private InventoryServiceGrpc.InventoryServiceBlockingStub blockingStub() {
        return InventoryServiceGrpc.newBlockingStub(channels.createChannel("0.0.0.0:0"));
    }

    @Test
    void getProductMapsUnknownSkuToNotFoundStatus() {
        // Verifies the GrpcExceptionHandler: the business exception must surface
        // to clients as NOT_FOUND, not UNKNOWN.
        StatusRuntimeException ex = catchThrowableOfType(StatusRuntimeException.class,
                () -> blockingStub().getProduct(GetProductRequest.newBuilder().setSku("NOPE").build()));

        assertThat(ex.getStatus().getCode()).isEqualTo(Status.Code.NOT_FOUND);
        assertThat(ex.getStatus().getDescription()).contains("NOPE");
    }

    @Test
    void watchStockStreamsRequestedNumberOfUpdates() {
        // Blocking stubs expose server streams as an Iterator — each next() blocks
        // until the server pushes another message.
        var updates = blockingStub().watchStock(WatchStockRequest.newBuilder()
                .setSku("SKU-0004").setMaxUpdates(3).build());

        List<StockUpdate> received = new ArrayList<>();
        updates.forEachRemaining(received::add);
        assertThat(received).hasSize(3);
    }
}
```

Streaming tests use the async stub with a `CountDownLatch`, exactly like the controller. The demo covers all four RPC types this way, including asserting that bidirectional responses come back with the right correlation IDs.

On the **client** side, a lighter test just verifies the context wires up — channels connect lazily, so it passes without a running server:

```java
@SpringBootTest
class StorefrontClientApplicationTest {
    @Autowired InventoryServiceGrpc.InventoryServiceBlockingStub blockingStub;
    @Autowired InventoryServiceGrpc.InventoryServiceStub asyncStub;

    @Test
    void grpcStubBeansAreConfigured() {
        assertThat(blockingStub).isNotNull();
        assertThat(asyncStub).isNotNull();
    }
}
```

## Production Concerns

### The Netty Server and Where gRPC Runs

Spring Boot's gRPC server is **Netty-based** and, in our setup, runs entirely separately from any servlet container — the inventory server has no Tomcat at all, just a gRPC listener on `:9090`. That's the common production topology: gRPC and HTTP on different ports, scaled and secured independently.

If you *do* add a web starter alongside the gRPC server, you have a choice. Set `spring.grpc.server.servlet.enabled` and the gRPC services mount on the servlet container so **HTTP and gRPC share one port**. Keeping them separate (the default when there's no web starter) is usually cleaner for internal services, but single-port can simplify ingress in some environments.

### TLS via SSL Bundles

Everything so far has been plaintext (`static://`, no TLS) — fine for a demo behind a mesh, not for the open internet. Spring Boot 4.1 wires gRPC into its standard **SSL bundle** mechanism, so you configure certificates the same way you do for the web server. On the client, point the channel at a bundle:

```yaml
spring:
  ssl:
    bundle:
      pem:
        inventory-tls:
          truststore:
            certificate: "classpath:inventory-ca.pem"
  grpc:
    client:
      channel:
        inventory:
          target: "static://inventory.internal:9090"
          ssl:
            enabled: true
            bundle: inventory-tls
```

The server references a bundle with a keystore under `spring.grpc.server.ssl.*` the same way. Because it's the shared SSL bundle system, certificate rotation and the Actuator SSL health indicator work uniformly across HTTP and gRPC.

### Keep-Alive and Message Size

Two settings you'll almost always tune for production:

- **Keep-alive** (shown earlier): HTTP/2 pings detect connections that a NAT or load balancer silently dropped, far faster than TCP timeouts. `time: 30s, timeout: 5s` is a sane starting point on the client; servers can enforce a minimum to prevent abusive pinging.
- **Max message size**: gRPC defaults to a 4 MB inbound limit per message. If you legitimately send larger payloads, raise it — but first ask whether that data should be *streamed* instead. Large unary messages are an anti-pattern; streaming exists precisely so you don't buffer everything at once.

### Reflection and Health — Built-In

Two standard services register automatically (you saw them in the startup log):

- **`grpc.reflection.v1.ServerReflection`** lets tools like `grpcurl` and Postman discover your services and message schemas *at runtime* with no `.proto` files on hand. Convenient in dev; consider disabling it in locked-down production.
- **`grpc.health.v1.Health`** is the standard health protocol. Kubernetes gRPC probes (`grpc_health_probe`, or native gRPC liveness/readiness probes) call it to decide whether to route traffic. This is the gRPC-native alternative to hitting an HTTP `/actuator/health`.

### Observability

Because Spring gRPC integrates with Micrometer, gRPC calls participate in the same **metrics and distributed tracing** as the rest of a Boot app — trace IDs propagate through gRPC metadata, so a request that enters as REST and fans out over gRPC shows up as one trace. Add `micrometer-tracing-bridge-otel` (or brave) and your gRPC hops appear in the same waterfall as your HTTP and database spans, no gRPC-specific instrumentation required.

### Deadlines Everywhere

Worth repeating because it's the difference between a resilient system and a fragile one: **set a deadline on every call**, and on the server, **check `Context.current().isCancelled()`** in any loop that could outlive the caller. Deadlines propagate down the call chain, so a well-behaved gRPC system fails fast and stops doing work nobody is waiting for. This single discipline prevents most cascading-failure scenarios.

## Tooling: `grpcurl`

You don't need a client app to poke a gRPC server. `grpcurl` is "curl for gRPC," and thanks to the reflection service it works with **no `.proto` files on your machine** — the server describes its own API:

```bash
# What services does the server expose?
grpcurl -plaintext localhost:9090 list

# What methods does InventoryService have? Full schema of one?
grpcurl -plaintext localhost:9090 list inventory.v1.InventoryService
grpcurl -plaintext localhost:9090 describe inventory.v1.InventoryService.GetProduct

# A unary call — JSON in, JSON out (grpcurl transcodes to protobuf for you)
grpcurl -plaintext -d '{"sku": "SKU-0001"}' \
    localhost:9090 inventory.v1.InventoryService/GetProduct

# Server streaming — watch each message arrive live
grpcurl -plaintext -d '{"sku": "SKU-0004", "max_updates": 3}' \
    localhost:9090 inventory.v1.InventoryService/WatchStock

# Client streaming — multiple JSON objects on stdin become the stream
grpcurl -plaintext -d @ localhost:9090 inventory.v1.InventoryService/RecordShipments <<'EOF'
{"sku": "SKU-0002", "quantity": 7, "supplier": "grpcurl demo"}
{"sku": "SKU-0003", "quantity": 2, "supplier": "grpcurl demo"}
EOF

# The standard health check (what k8s probes call)
grpcurl -plaintext localhost:9090 grpc.health.v1.Health/Check
```

That reflection-powered discovery is exactly how Postman's gRPC mode works too. It removes most of the "gRPC is hard to debug" objection.

## Running It End to End

With both services up (`inventory-server` on `:9090`, `storefront-client` on `:8080`), every RPC type is reachable through friendly REST:

**Unary** — `GET /api/products/SKU-0001`:

```json
{ "sku": "SKU-0001", "name": "Mechanical Keyboard", "price": "129.99 USD",
  "quantityAvailable": 42, "category": "ELECTRONICS", "updatedAt": "..." }
```

**Error mapping** — `GET /api/products/SKU-9999` returns HTTP **404**:

```json
{ "grpcStatus": "NOT_FOUND", "message": "No product with SKU 'SKU-9999'" }
```

**Server streaming** — `curl -N /api/products/SKU-0001/stock/stream?updates=4` emits SSE events ~400 ms apart:

```
event:stock-update
data:{"sku":"SKU-0001","quantityAvailable":40,"reason":"SALE","detail":"2 units sold", ...}

event:stock-update
data:{"sku":"SKU-0001","quantityAvailable":43,"reason":"RESTOCK","detail":"3 units from Acme Wholesale", ...}
```

**Client streaming** — `POST /api/shipments` with a JSON array returns one aggregated summary:

```json
{ "shipmentsReceived": 3, "totalUnitsAdded": 88,
  "updatedQuantities": { "SKU-0001": 67, "SKU-0005": 60, "SKU-0002": 20 } }
```

**Bidirectional** — `POST /api/orders` streams orders and gets per-order results, and the server-side interceptor log ties it together:

```
gRPC inventory.v1.InventoryService/ListProducts   from client [storefront-client] -> OK in 15 ms
gRPC inventory.v1.InventoryService/WatchStock      from client [storefront-client] -> OK in 1607 ms
gRPC inventory.v1.InventoryService/ProcessOrders   from client [storefront-client] -> OK in 9 ms
```

The full captured output — build logs, startup logs, every RPC, the interleaved bidirectional log proving both stream directions are live — is in `reference-output.md` in the demo repo.

## Best-Practices Checklist

A quick reference for shipping gRPC on Spring Boot 4.1:

- **One channel per target, shared app-wide.** Never a channel per request. Stubs are cheap; reuse the channel.
- **Set a deadline on every call.** They propagate; they're your primary defense against cascading failures.
- **Check for cancellation** in server-streaming loops (`Context.current().isCancelled()`).
- **Map exceptions to real status codes** with `GrpcExceptionHandler` — never let clients see `UNKNOWN`.
- **Version your proto package** (`inventory.v1`) from the start.
- **Keep a domain model separate** from generated protobuf; map at the boundary.
- **Never reuse a field number.** Add freely, `reserved` when removing.
- **Put the contract in its own module/repo** so server and client can't drift.
- **Use metadata for cross-cutting concerns** (auth, correlation IDs) via global interceptors.
- **Test with the in-process transport** (`@AutoConfigureTestGrpcTransport`) — full pipeline, no ports.
- **Turn on keep-alive and TLS** for anything crossing a network boundary.
- **REST at the edge, gRPC between services** — the topology this whole demo demonstrates.

## Wrapping Up

Spring Boot 4.1 finally makes gRPC a first-class citizen. The starters handle the Netty server, bean discovery, channel management, interceptors, exception handling, reflection, health, TLS, and testing — leaving you to write the parts that are actually yours: the `.proto` contract and the service logic. The result is remarkably little ceremony for what gRPC gives you: a strict cross-language contract, four RPC shapes including real bidirectional streaming, propagating deadlines, and binary performance over multiplexed HTTP/2.

gRPC isn't a REST replacement — it's the right tool for **service-to-service communication inside your network**, especially when you need streaming or polyglot clients. Keep REST (or GraphQL) at the edge for browsers and third parties, keep messaging for decoupled async work, and reach for gRPC for the fast, typed, synchronous calls between your own services. The demo's REST-in-front, gRPC-in-back shape is the pattern you'll reach for most often.

The demo repository used throughout this post — the full `inventory-proto`, `inventory-server`, and `storefront-client` modules with tests covering every RPC type — is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/grpc-spring-boot-ultimate-guide). The `scripts/` directory has `run-demo.sh`, `demo-requests.sh`, and `grpcurl-examples.sh` so you can see all four RPC types run end to end in a couple of commands.

If you found this useful, the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration), the [Spring Cloud Streams guide](/posts/ultimate-guide-spring-cloud-streams), and the [Spring Batch 6 guide](/posts/ultimate-guide-spring-batch-6) follow the same format for those topics.
