---
author: StevenPG
pubDatetime: 2026-07-21T12:00:00.000Z
title: "The Ultimate Guide to Schema Registry with Java and Spring Boot"
slug: ultimate-guide-schema-registry-spring-boot
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - spring boot
  - java
  - kafka
  - avro
  - schema-registry
description: A comprehensive guide to running a Schema Registry with Spring Boot and Kafka - Avro, Protobuf, and JSON Schema; Confluent, Apicurio, and AWS Glue; compatibility modes, evolution, testing, and the CI workflow that stops the 2am page.
---

# The Ultimate Guide to Schema Registry with Java and Spring Boot

## Table of Contents

[[toc]]

## Introduction

Kafka doesn't care what you put in a message. To a broker, a record value is just bytes. That's wonderful for throughput and awful for the person on the consuming team who finds out at 2am that a producer quietly renamed a field.

A **Schema Registry** fixes that. It turns "just bytes" into a versioned, enforceable contract, and - this is the part people underuse - it can *reject a breaking change before it ever reaches production*.

This guide is the reference I wish I'd had. It builds a small Spring Boot 4 service around Confluent Schema Registry and Avro, then widens out to everything you actually have to decide in the real world: **Avro vs Protobuf vs JSON Schema**, **Confluent vs Apicurio vs AWS Glue**, plain `spring-kafka` vs **Spring Cloud Stream**, and the compatibility rules that decide whether your next schema change is safe. Every core snippet comes from a runnable demo project - link at the bottom.

The whole thing is in service of one question that matters day to day: **how do you change a schema without breaking everyone downstream?**

### The problem, concretely

Two teams share an `orders` topic. The orders team produces `OrderEvent` records; the fulfillment team consumes them. They deploy on their own schedules and never talk to each other except through this topic.

One day the orders team decides `amount` should be a `string` ("to support currencies with weird precision"). They deploy. Every fulfillment consumer that expects a `double` starts throwing deserialization errors on the next message. Nobody changed the fulfillment code. Nobody *could* have - they didn't know.

The registry's whole job is to make that deploy fail on the orders team's side, **at build time, with a clear message**, instead of failing silently on the fulfillment team's side at runtime.

## How a Schema Registry Actually Works

The trick that makes this cheap: the message on the wire is **not** the schema.

Confluent's serializer writes a **1-byte magic marker** (`0x0`), a **4-byte schema id** (big-endian), and then the payload. The schema itself is stored once in the registry. The consumer reads the id, fetches the schema (and caches it forever), and decodes. You pay the schema-transfer cost once per schema, not per message.

```
 byte 0        bytes 1-4              bytes 5..n
┌────────┬──────────────────┬─────────────────────────┐
│ 0x00   │   schema id (4)  │   serialized payload     │
│ magic  │   (big-endian)   │   (Avro / Protobuf/JSON) │
└────────┴──────────────────┴─────────────────────────┘
```

The end-to-end flow looks like this:

```
  POST /orders
        │
        ▼
  OrderProducer ──serialize──►  Schema Registry   (schema id ⇄ schema)
        │                             ▲
        │  <id + bytes>               │ "here's my writer schema"
        ▼                             │
     Kafka topic  ──────────►  OrderEventListener ──deserialize──► store
```

The registry is a separate service with a REST API. It stores schemas, assigns them ids, groups them into **subjects**, and enforces a **compatibility mode** per subject. That last part is the whole point - everything else is plumbing.

### Subjects and naming strategies

A **subject** is the unit of versioning and compatibility. By default Confluent uses `TopicNameStrategy`: the subject for a topic's values is `<topic>-value` (and `<topic>-key` for keys). Our `orders` topic gets an `orders-value` subject.

There are three strategies, and they change how much a single topic can carry:

| Strategy | Subject name | Use when |
|---|---|---|
| `TopicNameStrategy` (default) | `orders-value` | One record type per topic. The common, sane default. |
| `RecordNameStrategy` | `com.example.OrderEvent` | The same record type across many topics; compatibility tracked per type. |
| `TopicRecordNameStrategy` | `orders-com.example.OrderEvent` | Multiple event types on one topic, each versioned independently. |

You set it with `value.subject.name.strategy`. Stick with the default unless you have a deliberate reason - multi-type topics complicate every consumer.

## Choosing a Schema Format: Avro vs Protobuf vs JSON Schema

Confluent Schema Registry supports three serialization formats. They're not interchangeable, and the choice shapes your tooling for years.

| | **Avro** | **Protobuf** | **JSON Schema** |
|---|---|---|---|
| Wire size | Smallest (binary, no field names) | Small (binary, tag numbers) | Largest (text JSON) |
| Human-readable on the wire | No | No | Yes |
| Code generation | Yes (`.avsc` → class) | Yes (`.proto` → class) | Optional |
| Schema evolution model | Defaults + reader/writer resolution | Field numbers + reserved | JSON Schema keywords |
| Cross-language story | Excellent (JVM-centric heritage) | Excellent (Google's lingua franca) | Excellent (everything speaks JSON) |
| Native to Kafka ecosystem | Yes - the original | Yes | Yes |
| Best for | Kafka-first data pipelines | Polyglot orgs, shared with gRPC | Interop with REST/JS consumers |

**The short version:**

- **Avro** is the default choice for Kafka. It's the most compact, evolution is well understood, and the tooling is the most mature in the registry. If you have no other constraint, use Avro. This guide's demo does.
- **Protobuf** shines when you already use it elsewhere - gRPC services, mobile clients, anything Google-adjacent. Sharing one `.proto` between your gRPC API and your Kafka events is genuinely nice. (If gRPC is on your radar, see my [Ultimate Guide to gRPC with Spring Boot](/posts/ultimate-guide-spring-grpc/).)
- **JSON Schema** is for when readability and REST interop win. Being able to `cat` a message off the topic and read it is worth something, and JavaScript/TypeScript consumers get a first-class experience. You pay for it in bytes.

We'll build the whole thing in Avro, then show exactly what changes to switch to Protobuf or JSON Schema near the end. The *concepts* - subjects, compatibility, evolution - are identical across all three.

## Choosing a Registry: Confluent vs Apicurio vs AWS Glue

The format is one axis; the registry implementation is another. All three below speak enough of a common protocol that your Spring code barely changes.

| | **Confluent Schema Registry** | **Apicurio Registry** | **AWS Glue Schema Registry** |
|---|---|---|---|
| Vendor | Confluent | Red Hat (open source) | AWS |
| License | Community License | Apache 2.0 | Managed AWS service |
| Formats | Avro, Protobuf, JSON Schema | Avro, Protobuf, JSON Schema, more | Avro, Protobuf, JSON Schema |
| API compatibility | The de-facto standard API | Native API **+ Confluent-compatible** endpoint | AWS SDK (not the Confluent API) |
| Hosting | Self-host / Confluent Cloud | Self-host / OpenShift | Fully managed |
| Best fit | Confluent Platform / Cloud users | Kubernetes / Red Hat shops, or anyone wanting Apache-licensed | AWS MSK users who want zero ops |

**How to pick:**

- On **Confluent Platform or Confluent Cloud**? Use their registry. It's the reference implementation and everything else emulates it.
- Want **Apache-licensed and self-hosted**, or you're on OpenShift? **Apicurio** is excellent and exposes a Confluent-compatible API, so the Confluent serdes work against it with a URL change.
- Living in **AWS with MSK** and allergic to running another service? **AWS Glue Schema Registry** is managed, but it uses the AWS SDK rather than the Confluent REST API, so the serde libraries differ.

Most of this guide targets Confluent because it's the common denominator. I'll show the Apicurio and Glue deltas in their own section - they're smaller than you'd expect.

## Building the Service with Spring Boot 4

Spring Boot 4 ships a first-class `spring-boot-starter-kafka`, so the build is short. The only non-obvious bits are the Confluent Maven repo and the Avro codegen plugin.

```kotlin
// build.gradle.kts
plugins {
    java
    id("org.springframework.boot") version "4.0.6"
    id("io.spring.dependency-management") version "1.1.7"
    // Generates Java classes from .avsc files at build time
    id("com.github.davidmc24.gradle.plugin.avro") version "1.9.1"
}

repositories {
    mavenCentral()
    // Confluent's serializers live here, not Maven Central
    maven { url = uri("https://packages.confluent.io/maven/") }
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-kafka")
    implementation("org.apache.avro:avro:1.12.0")
    implementation("io.confluent:kafka-avro-serializer:8.0.0")
    implementation("io.confluent:kafka-schema-registry-client:8.0.0")
}
```

### The schema is the source of truth

We define the contract as an `.avsc` file and let the build generate the Java class. That ordering matters: **the schema is the artifact you review, version, and enforce** - the Java class is a byproduct.

```json
// src/main/avro/OrderEvent.avsc
{
  "type": "record",
  "name": "OrderEvent",
  "namespace": "com.example.schemaregistry.avro",
  "doc": "Emitted when an order changes state. Schema version 1.",
  "fields": [
    { "name": "orderId",    "type": "string", "doc": "Unique order identifier." },
    { "name": "customerId", "type": "string", "doc": "Customer who placed the order." },
    { "name": "amount",     "type": "double", "doc": "Order total in the given currency." },
    { "name": "currency",   "type": "string", "default": "USD", "doc": "ISO-4217 currency code." },
    {
      "name": "status",
      "type": {
        "type": "enum",
        "name": "OrderStatus",
        "symbols": ["PLACED", "PAID", "SHIPPED", "CANCELLED"],
        "default": "PLACED"
      },
      "default": "PLACED",
      "doc": "Current order status."
    },
    {
      "name": "createdAt",
      "type": { "type": "long", "logicalType": "timestamp-millis" },
      "doc": "Event creation time (epoch millis)."
    }
  ]
}
```

Notice the `default`s. They aren't decoration - they're what makes this schema *evolvable*. We'll come back to that in the compatibility section, because it's the single most important habit in the whole guide.

The Avro Gradle plugin turns this into a `com.example.schemaregistry.avro.OrderEvent` class (with a builder) on every build. You never hand-write or hand-edit it.

### The producer and consumer are boring - that's the point

Once the serializers are configured, your application code never mentions the registry. The producer just sends a generated object:

```java
@Component
public class OrderProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;
    private final String topic;

    OrderProducer(KafkaTemplate<String, OrderEvent> kafkaTemplate,
                  @Value("${app.topic}") String topic) {
        this.kafkaTemplate = kafkaTemplate;
        this.topic = topic;
    }

    public CompletableFuture<SendResult<String, OrderEvent>> send(OrderEvent event) {
        // Key by orderId so all events for one order land on the same partition.
        return kafkaTemplate.send(topic, event.getOrderId(), event);
    }
}
```

The `KafkaAvroSerializer` (configured in YAML) registers the schema with the registry on first use and prefixes each payload with the returned schema id. The consumer just receives a fully-typed object:

```java
@KafkaListener(topics = "${app.topic}", groupId = "${spring.kafka.consumer.group-id}")
void onOrderEvent(OrderEvent event) {
    log.info("Consumed order {} for {}", event.getOrderId(), event.getCustomerId());
    store.add(event);
}
```

No registry client in sight. No `GenericRecord` to cast. The deserializer looks up the schema by id, resolves it against the reader schema your consumer was built with, and hands you an `OrderEvent`.

A thin REST controller lets us drive the whole thing with `curl`:

```java
@RestController
@RequestMapping("/orders")
class OrderController {

    private final OrderProducer producer;
    private final OrderEventStore store;

    // constructor omitted

    @PostMapping
    ResponseEntity<Map<String, Object>> place(@RequestBody PlaceOrderRequest request) {
        OrderEvent event = OrderEvent.newBuilder()
                .setOrderId(UUID.randomUUID().toString())
                .setCustomerId(request.customerId())
                .setAmount(request.amount())
                .setCurrency(request.currency() == null ? "USD" : request.currency())
                .setStatus(OrderStatus.PLACED)
                .setCreatedAt(Instant.now())
                .build();

        producer.send(event);
        return ResponseEntity.accepted().body(Map.of(
                "orderId", event.getOrderId(),
                "status", event.getStatus().toString()));
    }

    record PlaceOrderRequest(String customerId, double amount, String currency) {}
}
```

### All the registry lives in configuration

The magic is entirely in `application.yml`. This is where you point at the registry and choose serializers:

```yaml
spring:
  application:
    name: spring-boot-kafka-schema-registry
  kafka:
    bootstrap-servers: localhost:9092
    properties:
      # The one line that connects the serializers to the registry
      schema.registry.url: http://localhost:8081
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: io.confluent.kafka.serializers.KafkaAvroSerializer
      properties:
        auto.register.schemas: true   # convenient for the demo; turn OFF in prod
        use.latest.version: false
    consumer:
      group-id: order-consumer
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: io.confluent.kafka.serializers.KafkaAvroDeserializer
      properties:
        specific.avro.reader: true    # decode into OrderEvent, not GenericRecord

app:
  topic: orders
```

Two properties deserve a call-out now, and we'll return to both:

- **`specific.avro.reader: true`** - without it, the deserializer gives you a generic `GenericRecord` (a glorified map). With it, you get your generated `OrderEvent`. Almost always what you want in a typed Java service.
- **`auto.register.schemas: true`** - lets any producer register a brand-new schema at runtime. Great for a 30-second demo, dangerous in production. More on that in the workflow section.

## Compatibility Modes: The Heart of the Registry

Here's the core idea, and it's worth stating precisely because people get it backwards. Each subject has a **compatibility mode** that governs which schema changes the registry will accept.

The default - and the one you should usually keep - is `BACKWARD`:

> **BACKWARD compatibility:** a consumer using the *new* schema can read data that was written with the *old* schema.

That's the guarantee that lets you **upgrade consumers to a new schema while old producers are still writing old data**. It leads directly to a table you should memorize:

| Change | Allowed under BACKWARD? | Why |
|---|---|---|
| Add a field **with a default** | ✅ | Reading old data, the new field falls back to its default |
| Remove a field | ✅ | The new reader simply ignores it |
| Add a field **without a default** | ❌ | Old data has no value and there's no fallback |
| Change a field's type | ❌ | Old `double` bytes can't be read as a `string` |
| Rename a field (no alias) | ❌ | Reads as "old field removed, new field added-without-default" |

### The full set of modes

There are seven modes. They're all variations on "which direction must reads survive," plus whether the check is **transitive** (against *all* previous versions, not just the latest).

| Mode | Guarantee | You can safely... | Deploy order |
|---|---|---|---|
| `BACKWARD` (default) | New schema reads old data | Delete fields, add optional (defaulted) fields | **Consumers first** |
| `BACKWARD_TRANSITIVE` | New schema reads **all** older data | Same, checked against every version | Consumers first |
| `FORWARD` | Old schema reads new data | Add fields, delete optional fields | **Producers first** |
| `FORWARD_TRANSITIVE` | **All** older schemas read new data | Same, checked against every version | Producers first |
| `FULL` | Both backward and forward | Add/remove **optional** fields only | Either order |
| `FULL_TRANSITIVE` | Both, against every version | Same, strictest safe mode | Either order |
| `NONE` | No checks | Anything - the registry is just a store | You're on your own |

**How to choose:**

- **`BACKWARD`** is the pragmatic default and where most teams live. Upgrade the consumer to understand the new schema, then upgrade producers to emit it.
- **`FULL`** (or `FULL_TRANSITIVE`) is the honest choice when producers and consumers deploy independently and you want the strongest safety net that still allows evolution. You give up the ability to add/remove *required* fields, which is a small price.
- **`FORWARD`** matters when old consumers must keep working against new data - e.g. a widely-deployed reader you can't upgrade quickly.
- **`NONE`** is for when you genuinely have out-of-band coordination. Rare, and usually a mistake.

Set the mode per subject via the REST API:

```bash
curl -X PUT http://localhost:8081/config/orders-value \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"compatibility": "FULL_TRANSITIVE"}'
```

## Schema Evolution in Practice

Compatibility modes are the rules; evolution is playing the game well. Here's what safe changes actually look like.

### The one change you'll make 90% of the time

Add an optional, defaulted field:

```json
{ "name": "loyaltyTier", "type": ["null", "string"], "default": null }
```

Nullable, with a default. Old data that never had a `loyaltyTier` reads back as `null`. That's why it's safe, and it's the shape of *almost every* schema change you'll ever make: **additive, optional, defaulted**. Burn that phrase into your team's habits and most compatibility problems never happen.

### Renaming with aliases

You can't rename a field for free, but Avro's `aliases` let a new field claim an old one's data:

```json
{ "name": "customerRef", "type": "string", "aliases": ["customerId"] }
```

The reader schema knows `customerRef` used to be `customerId`, so old data resolves cleanly. Without the alias, a rename reads as "removed `customerId`, added `customerRef` with no default" - which fails backward compatibility.

### Changes that need a new topic (or a migration)

Some changes simply aren't compatible in any mode:

- Changing a field's type (`double` → `string`).
- Adding a required field to a subject producers still write the old way.
- Narrowing an enum (removing symbols) when old data uses them.

When you truly need one of these, the answer isn't to fight the registry - it's a **v2 topic** and a migration path, or a dual-write window while consumers move over. The registry telling you "no" is it doing its job.

### Type promotion is allowed

Avro permits a set of safe widening promotions during read resolution - `int` → `long` → `float` → `double`, and `string` ↔ `bytes`. So promoting `int` to `long` on a numeric field can be backward compatible even though it's a type change. The registry knows the rules; when in doubt, run the compatibility check (next section) rather than guessing.

## Proving It, Not Just Claiming It

This is where a demo earns its keep. Anyone can write a post that *says* "the registry rejects breaking changes." Standing up a real Kafka broker and a real Schema Registry with Testcontainers and making the registry answer is how you *know*.

The base test class starts the real infrastructure once for the run:

```java
static final Network NETWORK = Network.newNetwork();

static final ConfluentKafkaContainer KAFKA =
        new ConfluentKafkaContainer("confluentinc/cp-kafka:8.0.0")
                .withListener("kafka:19092")
                .withNetwork(NETWORK);

static final GenericContainer<?> SCHEMA_REGISTRY =
        new GenericContainer<>(DockerImageName.parse("confluentinc/cp-schema-registry:8.0.0"))
                .withNetwork(NETWORK)
                .withExposedPorts(8081)
                .withEnv("SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS", "PLAINTEXT://kafka:19092")
                .waitingFor(Wait.forHttp("/subjects").forStatusCode(200));
```

No mock pretending to be a registry - the real thing, once per run. (If Testcontainers is new to you, I have a whole [Ultimate Guide to Testcontainers with Spring Boot](/posts/ultimate-guide-testcontainers-spring-boot/).)

The evolution test registers v1 under a fresh subject, then tries two changes. The compatible one - adding an optional `loyaltyTier` - is accepted:

```java
@Test
void addingAnOptionalFieldIsBackwardCompatible() throws Exception {
    AvroSchema v2 = new AvroSchema(V2_ADD_OPTIONAL_FIELD);

    assertThat(client.testCompatibility(subject, v2)).isTrue();   // dry run: yes

    int newId = client.register(subject, v2);                     // and it registers
    assertThat(client.getAllVersions(subject)).containsExactly(1, 2);
}
```

The breaking one - `amount` from `double` to `string` - is refused, with the same HTTP 409 your CI pipeline would see:

```java
@Test
void changingAFieldTypeIsRejected() {
    AvroSchema broken = new AvroSchema(INCOMPATIBLE_TYPE_CHANGE);

    assertThat(compatible(broken)).isFalse();                     // dry run: no

    assertThatThrownBy(() -> client.register(subject, broken))
        .isInstanceOf(RestClientException.class)
        .satisfies(ex -> assertThat(((RestClientException) ex).getStatus()).isEqualTo(409));
}
```

That 409 is the entire value proposition made testable. A round-trip integration test - produce over real Kafka, consume back an `OrderEvent` - proves the happy path in the same suite.

## The Same Thing in Spring Cloud Stream

Plain `spring-kafka` is the right call for a focused service. But if you're already invested in the **functional binding model** - `Supplier`, `Function`, `Consumer` beans wired to destinations - Spring Cloud Stream integrates with the registry cleanly too. (Background: my [Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams/).)

The key insight: Spring Cloud Stream has its *own* message conversion layer (content-type based). To hand serialization off to Confluent's Avro serde instead, you enable **native encoding/decoding** and configure the serializers at the binder level.

```java
@Bean
public Function<OrderEvent, OrderEvent> enrichOrder() {
    // Business logic only - no registry code
    return order -> {
        order.setStatus(OrderStatus.PAID);
        return order;
    };
}
```

```yaml
spring:
  cloud:
    stream:
      function:
        definition: enrichOrder
      bindings:
        enrichOrder-in-0:
          destination: orders
          group: order-enricher
          consumer:
            # Let the Confluent deserializer do the work, not SCSt's converters
            use-native-decoding: true
        enrichOrder-out-0:
          destination: enriched-orders
          producer:
            use-native-encoding: true
      kafka:
        binder:
          brokers: localhost:9092
        bindings:
          enrichOrder-in-0:
            consumer:
              configuration:
                schema.registry.url: http://localhost:8081
                specific.avro.reader: true
                value.deserializer: io.confluent.kafka.serializers.KafkaAvroDeserializer
          enrichOrder-out-0:
            producer:
              configuration:
                schema.registry.url: http://localhost:8081
                value.serializer: io.confluent.kafka.serializers.KafkaAvroSerializer
```

The rule of thumb: **`use-native-encoding`/`use-native-decoding: true` plus the Confluent serdes in the binder `configuration` block.** Without native (de)coding, Spring Cloud Stream tries to convert the bytes itself and you'll get content-type errors that are miserable to debug.

> A historical note: older Spring Cloud Stream had its *own* schema-registry-client and Avro message converters (`spring-cloud-stream-schema`). That approach is deprecated - don't reach for it in new code. Use the native Kafka serdes as above.

## The Change Process (The Part to Steal)

Everything above is setup for the workflow. Here's how a team ships a schema change without a war room.

**1. Edit the `.avsc` and open a pull request.** The schema is code. It gets reviewed like code. Reviewers can reason about the change because the diff *is* the contract, not a Java class three layers deep.

**2. CI runs a compatibility check against the registry - a dry run.** This is the gate. The compatibility endpoint tells you yes/no *without* registering anything:

```bash
#!/usr/bin/env bash
# check-compatibility.sh <subject> <path-to-.avsc>
set -euo pipefail

REGISTRY="${SCHEMA_REGISTRY_URL:-http://localhost:8081}"
SUBJECT="${1:?subject required, e.g. orders-value}"
SCHEMA_FILE="${2:?path to .avsc required}"

# --rawfile slurps the file as a JSON string, escaping it correctly for the API.
payload="$(jq -n --rawfile schema "$SCHEMA_FILE" '{schema: $schema, schemaType: "AVRO"}')"

curl -s -X POST \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  --data "$payload" \
  "$REGISTRY/compatibility/subjects/$SUBJECT/versions/latest" | jq .
```

```bash
./scripts/check-compatibility.sh orders-value evolution/order-event-v2-backward-compatible.avsc
# → { "is_compatible": true }

./scripts/check-compatibility.sh orders-value evolution/order-event-incompatible.avsc
# → { "is_compatible": false }
```

Fail the build when `is_compatible` is `false`. Now a breaking change *cannot* merge. The 2am incident from the intro becomes a red check on a PR.

**3. Roll out in the compatibility-appropriate order.** Under `BACKWARD` you deploy **consumers first** (they learn to read the new field), then producers (they start writing it). Under `FORWARD`, it's the reverse. Register the new version as part of that rollout, from CI - not from a laptop.

**4. In production, don't auto-register.** The demo sets `auto.register.schemas=true` so you can play with it in thirty seconds. On a real system, set it to `false`. Auto-registration means any producer can invent a schema at runtime - which quietly moves the source of truth from your reviewed `.avsc` files into whatever happened to deploy last. Register from CI instead, and the registry stays a deliberate, reviewed artifact.

```yaml
spring:
  kafka:
    producer:
      properties:
        auto.register.schemas: false   # production
        use.latest.version: true       # use the registered schema, don't invent one
```

That's the whole discipline:

- schema in version control,
- compatibility checked in CI,
- registration in the pipeline,
- rollout ordered by compatibility mode.

Four rules, and the class of "someone broke the topic" incidents essentially disappears.

## Switching Formats: Protobuf and JSON Schema

The concepts don't change when you switch formats - only the serde classes and the schema file. Here's exactly what moves.

### Protobuf

Add the Protobuf serde and a `.proto` instead of an `.avsc`:

```kotlin
implementation("io.confluent:kafka-protobuf-serializer:8.0.0")
```

```protobuf
// order_event.proto
syntax = "proto3";
package com.example.schemaregistry.proto;

message OrderEvent {
  string order_id = 1;
  string customer_id = 2;
  double amount = 3;
  string currency = 4;
  int64 created_at = 5;
}
```

```yaml
spring:
  kafka:
    producer:
      value-serializer: io.confluent.kafka.serializers.protobuf.KafkaProtobufSerializer
    consumer:
      value-deserializer: io.confluent.kafka.serializers.protobuf.KafkaProtobufDeserializer
      properties:
        # Point the deserializer at your generated class
        specific.protobuf.value.type: com.example.schemaregistry.proto.OrderEvent
```

Protobuf evolution is governed by **field numbers**: adding a new field with a new number is safe; you must never reuse a number, and you `reserved` numbers you retire. The registry enforces this the same way it enforces Avro rules.

### JSON Schema

```kotlin
implementation("io.confluent:kafka-json-schema-serializer:8.0.0")
```

```yaml
spring:
  kafka:
    producer:
      value-serializer: io.confluent.kafka.serializers.json.KafkaJsonSchemaSerializer
    consumer:
      value-deserializer: io.confluent.kafka.serializers.json.KafkaJsonSchemaDeserializer
      properties:
        json.value.type: com.example.schemaregistry.OrderEvent
```

Here your POJO *is* effectively the schema (Confluent can derive a JSON Schema from the class, or you supply one). You trade Avro's compactness for messages you can read straight off the topic - handy when non-JVM consumers or humans are in the loop.

## Switching Registries: Apicurio and AWS Glue

### Apicurio Registry

Apicurio exposes a **Confluent-compatible API**, so the *easiest* path is to keep the Confluent serdes and just point them at Apicurio's compatibility endpoint:

```yaml
spring:
  kafka:
    properties:
      # Apicurio's Confluent-compatible ("ccompat") endpoint
      schema.registry.url: http://localhost:8080/apis/ccompat/v7
```

That's often the entire change. If you'd rather use Apicurio's *native* serdes (which unlock its extra features), swap in `io.apicurio:apicurio-registry-serdes-avro-serde` and the `AvroKafkaSerializer`/`AvroKafkaDeserializer` classes, configuring `apicurio.registry.url` instead. For most teams migrating from Confluent, the ccompat endpoint is the pragmatic move.

### AWS Glue Schema Registry

Glue is the outlier: it uses the **AWS SDK**, not the Confluent REST API, so the serde library is different.

```kotlin
implementation("software.amazon.glue:schema-registry-serde:1.1.20")
```

```yaml
spring:
  kafka:
    producer:
      value-serializer: com.amazonaws.services.schemaregistry.serializers.GlueSchemaRegistrySerializer
      properties:
        region: us-east-1
        registry.name: orders-registry
        schemaAutoRegistrationEnabled: false
        dataFormat: AVRO
        compatibility: BACKWARD
    consumer:
      value-deserializer: com.amazonaws.services.schemaregistry.deserializers.GlueSchemaRegistryDeserializer
      properties:
        region: us-east-1
        avroRecordType: SPECIFIC_RECORD
```

Authentication rides on the standard AWS credential chain (IAM role, profile, env vars). The upside is zero infrastructure to run - the registry is a managed AWS resource, and it plugs straight into MSK. The downside is you're now AWS-coupled and off the Confluent API path, so third-party tooling built for Confluent won't necessarily work.

## Running It Yourself

The demo ships a Docker Compose stack - KRaft-based Kafka, Schema Registry, and Kafka UI:

```bash
docker compose up -d      # Kafka + Schema Registry + Kafka UI
./gradlew bootRun

curl -s -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"customer-42","amount":129.99,"currency":"USD"}'

curl -s http://localhost:8080/orders/received | jq .
```

Open Kafka UI to watch the `orders` topic fill up and see the `orders-value` schema the producer registered. Then try registering the incompatible schema by hand and watch the registry say no.

Or skip all of that and just run the tests - they start their own infrastructure via Testcontainers and prove the whole story:

```bash
./gradlew test
```

## Common Pitfalls and Troubleshooting

### `specific.avro.reader` not set - you get a GenericRecord

**Symptom:** `ClassCastException: GenericData$Record cannot be cast to OrderEvent`.

**Fix:** Set `specific.avro.reader: true` on the consumer (or `specific.protobuf.value.type` / `json.value.type` for the other formats). Without it, the deserializer returns an untyped generic record.

### Forgot the Confluent Maven repo

**Symptom:** `Could not find io.confluent:kafka-avro-serializer`.

**Fix:** The Confluent serdes aren't on Maven Central. Add `https://packages.confluent.io/maven/` to your repositories.

### Schema registered from a laptop, not CI

**Symptom:** Production has a schema version nobody reviewed, and you can't tell where it came from.

**Fix:** `auto.register.schemas: false` in production, `use.latest.version: true`, and register exclusively from your pipeline. The registry should only ever contain schemas that went through review.

### Subject naming surprises

**Symptom:** Compatibility checks pass but consumers still break, or two topics fight over one subject.

**Fix:** Confirm your `value.subject.name.strategy`. The default `TopicNameStrategy` gives one subject per topic (`<topic>-value`); if you're putting multiple event types on a topic you need `TopicRecordNameStrategy`, and every checker/registration script must use the same subject name.

### Spring Cloud Stream double-encoding

**Symptom:** Garbled bytes or content-type conversion errors under Spring Cloud Stream.

**Fix:** Set `use-native-encoding: true` (producer) and `use-native-decoding: true` (consumer). Otherwise SCSt's own converters run *in addition to* the Kafka serde, and the two fight.

### Compatibility passes locally, fails in CI (or vice versa)

**Symptom:** `is_compatible` differs between environments.

**Fix:** You're almost certainly checking against different registry state. Compatibility is evaluated against the versions *currently registered for that subject*. `TRANSITIVE` modes check every historical version; non-transitive checks only the latest. Make sure CI checks against the same subject history production has.

## Summary and Quick Reference

### Format decision

```
Kafka-first, JVM-heavy, want smallest payloads?     → Avro
Already using Protobuf / gRPC / polyglot clients?    → Protobuf
Need human-readable messages / JS-TS interop?        → JSON Schema
```

### Registry decision

```
On Confluent Platform or Cloud?          → Confluent Schema Registry
Want Apache-licensed / self-hosted / k8s? → Apicurio (Confluent-compatible API)
Living in AWS MSK, want zero ops?         → AWS Glue Schema Registry
```

### Compatibility cheat sheet

| Mode | Reads survive | Deploy | Safe changes |
|---|---|---|---|
| `BACKWARD` (default) | new reads old | consumers first | add optional, remove |
| `FORWARD` | old reads new | producers first | add, remove optional |
| `FULL` | both | either | add/remove optional only |
| `*_TRANSITIVE` | across all versions | as above | as above, stricter |
| `NONE` | nothing | your problem | anything |

### The four rules that matter most

1. **Schema in git** - the `.avsc`/`.proto` is the reviewed source of truth.
2. **Compatibility checked in CI** - a red check on breaking changes, before merge.
3. **Registration in the pipeline** - `auto.register.schemas: false` in prod.
4. **Rollout ordered by mode** - consumers-first for BACKWARD, producers-first for FORWARD.

### Useful resources

- [Confluent Schema Registry documentation](https://docs.confluent.io/platform/current/schema-registry/index.html)
- [Apache Avro specification](https://avro.apache.org/docs/current/specification/)
- [Apicurio Registry](https://www.apicur.io/registry/)
- [AWS Glue Schema Registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html)
- The runnable demo for this guide: [StevenPG/DemosAndArticleContent - spring-boot-kafka-schema-registry](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-kafka-schema-registry)

---

A Schema Registry turns a Kafka topic from "bytes and hope" into an enforced, versioned contract, for the price of a 5-byte header per message. With Spring Boot 4, the application code stays boring - produce and consume generated objects; the registry lives entirely in configuration. `BACKWARD` compatibility plus "additive, optional, defaulted" covers the vast majority of real schema changes.

But the wiring was never the hard part. The value is the **process**: schema in git, compatibility checked in CI, registration in the pipeline. That's what stops the 2am page - and it's what I wish someone had handed me the first time I stood one of these up.
