---
author: StevenPG
pubDatetime: 2026-07-26T00:00:00.000Z
title: "The Ultimate Guide to Spring Cloud Function"
slug: ultimate-guide-spring-cloud-function
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - spring-cloud
  - spring-cloud-function
  - serverless
  - kafka
  - rsocket
  - aws lambda
description: A deep, end-to-end guide to Spring Cloud Function on Spring Boot 4 — write your business logic once as plain java.util.function beans, then expose the exact same functions over HTTP, Kafka, RSocket, and AWS Lambda without changing a line. Composition, reactive Flux/Mono, message routing, custom converters, runtime registration, testing, and GraalVM native images.
---

# The Ultimate Guide to Spring Cloud Function

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Cloud Function is one of the most under-appreciated projects in the entire Spring ecosystem, and it's also one of the most misunderstood. Most people meet it sideways — they wanted to deploy something to AWS Lambda, or they were using Spring Cloud Stream and noticed their `Consumer<T>` beans were being picked up by "some function thing" — and they never actually learned what it *is*.

Here's the one sentence that unlocks it:

> **Spring Cloud Function lets you write your business logic once, as plain `java.util.function` beans, and then expose those exact same beans over HTTP, over a message broker, over RSocket, or as a serverless function — without changing a single line of the functions.**

That's the whole idea. Your business logic is a `Function<Order, Decision>`. It has no idea whether it's being called by a REST controller, a Kafka listener, an RSocket route, or an AWS Lambda invocation. The *transport* is a deployment concern that Spring Cloud Function bolts on at the edge. Your code stays boring, testable, and portable.

This guide is the comprehensive, Spring-Boot-4-native tour I wish I'd had. We'll start from the three interfaces everything is built on, work through composition, reactive functions, `Message<T>` and headers, runtime routing, custom content types, and dynamic registration — and *then* we'll take one identical set of functions and light it up over **four different surfaces**, one at a time, so you can see with your own eyes that the functions never change.

Everything here is built and tested against a real, runnable companion project:

| Piece                          | Version                  |
| ------------------------------ | ------------------------ |
| Spring Boot                    | **4.0.7**                |
| Spring Cloud                   | **2025.1.2** ("Oakwood") |
| Spring Cloud Function          | **5.0.3**                |
| Java                           | **21**                   |
| Gradle                         | **8.14**                 |
| Kafka                          | via Docker Compose       |

The full demo repository is linked at the end and referenced throughout. It is a multi-module Gradle build: one `functions-core` module holding the business logic, and four thin "surface" modules (`app-web`, `app-stream-kafka`, `app-rsocket`, `adapter-aws`) that each expose the same functions a different way. If you already use Spring Cloud Function and just want a specific piece, jump to [Surface 1: HTTP](#surface-1-http-with-spring-cloud-function-web), [Kafka](#surface-2-kafka-with-spring-cloud-stream), [RSocket](#surface-3-rsocket-roll-your-own-with-the-functioncatalog), or [AWS Lambda](#surface-4-aws-lambda).

## The Core Idea: Functions as the Unit of Deployment

Traditional Spring applications organize around *frameworks*. You write a `@RestController` for HTTP, a `@KafkaListener` for messaging, an `@MessageMapping` for RSocket. Each of those couples your business logic to a transport. The logic that decides whether to approve an order ends up living inside an HTTP handler, and the day you need that same decision on a Kafka topic, you copy-paste it into a listener.

Spring Cloud Function inverts this. The unit of code is a **function bean** — one of the three interfaces from `java.util.function`:

| Interface        | Shape                | Role                          |
| ---------------- | -------------------- | ----------------------------- |
| `Supplier<R>`    | `() -> R`            | A source. Produces output, takes no input. |
| `Function<T, R>` | `T -> R`             | A transform. Input in, output out.          |
| `Consumer<T>`    | `T -> void`          | A sink. Consumes input, produces nothing.   |

You register these as ordinary Spring beans. Spring Cloud Function discovers them, wraps each one in a `FunctionInvocationWrapper`, and puts it in a registry called the **`FunctionCatalog`**. Every surface adapter — web, stream, RSocket, Lambda — talks to that catalog. None of them talk to your beans directly.

The payoff is that "how do I expose this?" becomes a *dependency and configuration* question, not a *rewrite* question. Want it over HTTP? Add `spring-cloud-function-web`. Over Kafka? Add a Spring Cloud Stream binder. As a Lambda? Add the AWS adapter and set a handler. The functions don't move.

### The demo's business logic

Throughout this guide, the running example is a tiny order-processing pipeline. Here are the domain types (plain records — nothing framework-specific):

```java
// The raw order coming in off some surface.
public record Order(
        String orderId,
        String customerId,
        BigDecimal amount,
        String currency,
        int itemCount) {
}

// An order after enrichment (we've added derived fields).
public record EnrichedOrder(
        String orderId,
        String customerId,
        BigDecimal amount,
        String currency,
        int itemCount,
        boolean highValue,
        Instant enrichedAt) {
}

// The final decision our pipeline produces.
public record Decision(
        String orderId,
        boolean approved,
        String reason) {
}
```

Nothing here imports Spring. That's the point — this is code you could unit test with plain JUnit and no application context at all.

## The Three Interfaces in Practice

Let's define the pipeline as function beans. In the demo these live in `PipelineFunctions.java`.

### Supplier — producing values

A `Supplier<T>` is a source. It takes nothing and returns a value. Depending on the surface, it's invoked differently: over HTTP a `GET /generateOrders` calls it once; in Spring Cloud Stream it's *polled* on a schedule; as a Lambda it runs when triggered.

```java
@Configuration
public class PipelineFunctions {

    // A source of orders. Over HTTP this responds to GET /generateOrders.
    // In a stream it is polled on a fixed delay to emit orders.
    @Bean
    public Supplier<Order> generateOrders() {
        return () -> new Order(
                UUID.randomUUID().toString(),
                "cust-" + ThreadLocalRandom.current().nextInt(1, 100),
                BigDecimal.valueOf(ThreadLocalRandom.current().nextInt(10, 5000)),
                "USD",
                ThreadLocalRandom.current().nextInt(1, 20));
    }
```

### Function — transforming values

A `Function<T, R>` is the workhorse. Here are the two core transforms — `enrichOrder` adds derived fields, and `validateOrder` turns an enriched order into a decision:

```java
    // Enrich an order: compute derived fields the raw order didn't carry.
    // Notice this is pure business logic — no HTTP, no Kafka, nothing.
    @Bean
    public Function<Order, EnrichedOrder> enrichOrder() {
        return order -> new EnrichedOrder(
                order.orderId(),
                order.customerId(),
                order.amount(),
                order.currency(),
                order.itemCount(),
                // A "high value" order is worth special handling downstream.
                order.amount().compareTo(BigDecimal.valueOf(1000)) >= 0,
                Instant.now());
    }

    // Validate the enriched order and produce an approval decision.
    @Bean
    public Function<EnrichedOrder, Decision> validateOrder() {
        return order -> {
            if (order.amount().compareTo(BigDecimal.ZERO) <= 0) {
                return new Decision(order.orderId(), false, "Non-positive amount");
            }
            if (order.itemCount() <= 0) {
                return new Decision(order.orderId(), false, "No items");
            }
            // High-value orders get a note but are still approved here.
            String reason = order.highValue() ? "Approved (high value)" : "Approved";
            return new Decision(order.orderId(), true, reason);
        };
    }
```

### Consumer — the sink

A `Consumer<T>` takes a value and returns nothing. It's the end of a pipeline — write to a database, send a notification, log an audit event.

```java
    // The terminal step. Over a stream this is a pure sink with no output binding.
    @Bean
    public Consumer<Decision> notifyDecision() {
        return decision -> log.info("Decision for {}: approved={} ({})",
                decision.orderId(), decision.approved(), decision.reason());
    }
}
```

That's the entire business layer: a source, two transforms, and a sink. Everything else in this guide is about *how you invoke them*.

## The FunctionCatalog: How Spring Sees Your Beans

When Spring Cloud Function starts, it scans for `Supplier`, `Function`, and `Consumer` beans and registers each one in the `FunctionCatalog` under its **bean name**. You can inject the catalog and look functions up by name — this is the "roll your own" API that the RSocket surface uses later:

```java
@Component
public class CatalogExample {

    private final FunctionCatalog catalog;

    public CatalogExample(FunctionCatalog catalog) {
        this.catalog = catalog;
    }

    public Decision run(Order order) {
        // Look up a composed function by name. The catalog returns a
        // FunctionInvocationWrapper that implements Function<Object, Object>.
        Function<Order, Decision> pipeline = catalog.lookup("enrichOrder|validateOrder");
        return pipeline.apply(order);
    }
}
```

Two things are doing a lot of work here and are worth internalizing:

1. **The lookup name is the bean name.** `enrichOrder` the bean is `enrichOrder` in the catalog. If you have one function bean and no ambiguity, most surfaces will find it automatically. When there's more than one, you disambiguate with `spring.cloud.function.definition` (more on that next).
2. **`|` composes on the fly.** `catalog.lookup("enrichOrder|validateOrder")` returns a *single* function whose input is `enrichOrder`'s input (`Order`) and whose output is `validateOrder`'s output (`Decision`). The catalog also transparently inserts type conversion between steps when needed.

### `spring.cloud.function.definition`

The single most important property in all of Spring Cloud Function is `spring.cloud.function.definition`. It tells the framework *which* function a given surface should bind to when there's ambiguity.

```yaml
spring:
  cloud:
    function:
      # Bind this single logical function. Because it uses the pipe
      # operator, it's a composition of two beans.
      definition: enrichOrder|validateOrder
```

- A single name (`enrichOrder`) selects one bean.
- A pipe-composed name (`enrichOrder|validateOrder`) selects a composition.
- A semicolon-separated list (`enrichOrder;validateOrder;notifyDecision`) declares *multiple* independent functions — used when a surface can host several (Spring Cloud Stream does this).

If you only have one function bean in the whole application, you can often omit this entirely and Spring Cloud Function will infer it. The moment you have two, be explicit.

## Function Composition

Composition is Spring Cloud Function's superpower, and the `|` operator is how you express it. You already saw `enrichOrder|validateOrder`. Composition works at three levels, and it's worth seeing all three because different surfaces expose different ones:

**1. In configuration** — the definition property, resolved at startup:

```yaml
spring:
  cloud:
    function:
      definition: enrichOrder|validateOrder|notifyDecision
```

That composes a `Function`, a `Function`, and a `Consumer` into a single `Consumer<Order>` — input goes in, flows through enrichment and validation, and lands in the sink. The type of the composition is determined by its last element: end with a `Consumer` and the whole thing is a consumer; end with a `Function` and it's a function.

**2. At the HTTP edge** — the web adapter lets you compose *ad hoc* per request using a comma-separated path (covered in the HTTP section). `POST /enrichOrder,validateOrder` composes them for that one call.

**3. Programmatically** — via `catalog.lookup("a|b")` as shown above.

The rule that trips people up: **types have to line up, or a converter has to exist.** `enrichOrder` outputs `EnrichedOrder`; `validateOrder` inputs `EnrichedOrder`; they compose cleanly. If the types don't match and there's no registered converter, you'll get a startup or invocation error. When one side is `byte[]` or `String` (as it is off the wire), Spring Cloud Function's message converters bridge the gap using the declared content type — which is exactly why the same `Function<Order, Decision>` can be fed raw JSON bytes over HTTP.

## Reactive Functions: Flux and Mono

Everything so far has been *imperative* — one input, one output. Spring Cloud Function is equally happy with **reactive** signatures using Project Reactor's `Flux` (0..N) and `Mono` (0..1). This matters because some surfaces are inherently streaming (RSocket channels, a Supplier polled as an unbounded source), and because reactive functions can batch, window, and backpressure.

The rule is simple: wrap the types you already have in `Flux` or `Mono`. In the demo these live in `ReactiveFunctions.java`.

```java
@Configuration
public class ReactiveFunctions {

    // An unbounded source. As a stream Supplier this becomes a continuous
    // producer rather than something polled one-at-a-time.
    @Bean
    public Supplier<Flux<Order>> orderStream() {
        return () -> Flux.interval(Duration.ofSeconds(1))
                .map(i -> new Order(
                        UUID.randomUUID().toString(),
                        "cust-stream",
                        BigDecimal.valueOf(100 + i),
                        "USD",
                        1));
    }

    // A reactive pipeline: takes a stream of orders, returns a stream of
    // decisions. Perfect for RSocket request/channel. Same business rules,
    // expressed over a Flux.
    @Bean
    public Function<Flux<Order>, Flux<Decision>> reactivePipeline() {
        return orders -> orders
                .map(order -> new EnrichedOrder(
                        order.orderId(), order.customerId(), order.amount(),
                        order.currency(), order.itemCount(),
                        order.amount().compareTo(BigDecimal.valueOf(1000)) >= 0,
                        Instant.now()))
                .map(enriched -> new Decision(
                        enriched.orderId(),
                        enriched.amount().compareTo(BigDecimal.ZERO) > 0,
                        enriched.highValue() ? "Approved (high value)" : "Approved"));
    }
}
```

A few things worth knowing about reactive functions:

- **You can mix imperative and reactive in a composition.** Spring Cloud Function will lift an imperative `Function<T, R>` into a reactive context when composing it with a reactive one, so `enrichOrder|reactiveThing` works.
- **A reactive function is invoked once, with the whole stream.** Unlike an imperative function that's called per message, `Function<Flux<Order>, Flux<Decision>>` receives the entire flux and you operate on it with operators. This is how you'd implement windowing or batching.
- **Don't block inside a reactive function.** If you need a blocking call, `subscribeOn` a bounded elastic scheduler — the same rules as any Reactor code.

## Messages and Headers

So far the functions have dealt in plain domain objects. But real transports carry **metadata** — HTTP headers, Kafka record headers, RSocket metadata. When your function needs to *see* or *set* that metadata, you declare it in terms of `Message<T>` instead of `T`. In the demo these live in `MessageFunctions.java`.

```java
@Configuration
public class MessageFunctions {

    // Take a Message so we can read incoming headers, and return a Message
    // so we can set outgoing ones. Over HTTP the input headers are the
    // request headers; over Kafka they are the record headers.
    @Bean
    public Function<Message<Order>, Message<Decision>> processWithHeaders() {
        return message -> {
            Order order = message.getPayload();

            // Read a header the caller sent (e.g. a correlation/trace id).
            String correlationId = (String) message.getHeaders()
                    .getOrDefault("correlationId", "none");

            Decision decision = new Decision(
                    order.orderId(),
                    order.amount().compareTo(BigDecimal.ZERO) > 0,
                    "Processed with correlation " + correlationId);

            // Build the response message and echo the correlation id back out.
            return MessageBuilder.withPayload(decision)
                    .setHeader("correlationId", correlationId)
                    .setHeader("processedAt", Instant.now().toString())
                    .build();
        };
    }
}
```

The beautiful part: **`Message<T>` is transport-neutral.** The same `processWithHeaders` bean reads a header whether it arrived as an HTTP request header or a Kafka record header, because each surface adapter normalizes its native metadata into `MessageHeaders`. You write to the abstraction once; the adapters map it to and from the wire.

When to use `Message<T>` vs. a plain type:

- **Plain type (`Order`)** — when your logic only cares about the payload. This is the majority of functions. Keep it simple.
- **`Message<T>`** — when you need to read incoming metadata (correlation ids, routing keys, timestamps) or set outgoing metadata.

## Runtime Message Routing

Sometimes a single logical endpoint needs to dispatch to *different* functions based on the content or headers of each message. Spring Cloud Function has a built-in facility for this: the reserved **`functionRouter`** function, driven by a `MessageRoutingCallback`.

The idea: you point the definition at `functionRouter`, and provide a callback bean that inspects each incoming `Message` and returns the *name* of the function that should handle it.

```java
@Configuration
public class RoutingConfig {

    // Inspect each message and decide which function should handle it.
    // Return the bean name (or a composed "a|b" definition).
    @Bean
    public MessageRoutingCallback orderRouter() {
        return new MessageRoutingCallback() {
            @Override
            public String routingResult(Message<?> message) {
                // Route on a header the caller sets.
                String channel = (String) message.getHeaders()
                        .getOrDefault("order-channel", "standard");

                return switch (channel) {
                    case "express" -> "fastApprove";       // skip validation
                    case "review"  -> "enrichOrder|validateOrder"; // full pipeline
                    default          -> "enrichOrder";      // just enrich
                };
            }
        };
    }

    // The "express lane" function the router can dispatch to.
    @Bean
    public Function<Order, Decision> fastApprove() {
        return order -> new Decision(order.orderId(), true, "Express approved");
    }
}
```

Then wire the router as the active function:

```yaml
spring:
  cloud:
    function:
      # functionRouter is a built-in function; the callback decides the target.
      definition: functionRouter
      # Alternatively, route with a SpEL expression instead of a callback:
      # routing-expression: "headers['order-channel']"
```

Now a single endpoint (HTTP `/functionRouter`, or a single Kafka binding) fans out to `fastApprove`, `enrichOrder`, or the full pipeline depending on the `order-channel` header. Two ways to drive it:

- **`MessageRoutingCallback` bean** — full Java control, as above. Best when routing logic is non-trivial.
- **`spring.cloud.function.routing-expression`** — a SpEL expression evaluated against the message (`headers['order-channel']` returns the function name directly). Best for simple header-to-name mappings, no code required.

## Custom Content Types and Message Converters

By default Spring Cloud Function speaks JSON — it uses Jackson to convert between the bytes on the wire and your POJOs, keyed off the `Content-Type`. But you can teach it *any* wire format by registering a `MessageConverter`. The demo does this for `text/csv`, so the very same `enrichOrder` function can accept a CSV line as an order.

```java
// Teaches Spring Cloud Function how to read an Order from a text/csv body.
public class CsvOrderMessageConverter extends AbstractMessageConverter {

    public CsvOrderMessageConverter() {
        // This converter handles the text/csv media type.
        super(new MimeType("text", "csv"));
    }

    @Override
    protected boolean supports(Class<?> clazz) {
        return Order.class.equals(clazz);
    }

    // Wire (CSV bytes/string) -> Order
    @Override
    protected Object convertFromInternal(Message<?> message, Class<?> targetClass,
                                         Object conversionHint) {
        String payload = new String((byte[]) message.getPayload(), StandardCharsets.UTF_8);
        // Format: orderId,customerId,amount,currency,itemCount
        String[] fields = payload.trim().split(",");
        return new Order(
                fields[0],
                fields[1],
                new BigDecimal(fields[2]),
                fields[3],
                Integer.parseInt(fields[4]));
    }

    // Order -> wire (CSV)
    @Override
    protected Object convertToInternal(Object payload, MessageHeaders headers,
                                       Object conversionHint) {
        Order o = (Order) payload;
        return String.join(",", o.orderId(), o.customerId(),
                o.amount().toPlainString(), o.currency(),
                String.valueOf(o.itemCount()))
                .getBytes(StandardCharsets.UTF_8);
    }
}
```

Register it as a bean and Spring Cloud Function adds it to the converter chain:

```java
@Configuration
public class ConverterConfig {

    @Bean
    public MessageConverter csvOrderMessageConverter() {
        return new CsvOrderMessageConverter();
    }
}
```

Now a caller can `POST` a body of `abc,cust-1,1500,USD,3` with `Content-Type: text/csv` to `/enrichOrder` and get back an enriched order as JSON — the *input* converter turned CSV into an `Order`, the function ran unchanged, and the *output* converter (JSON, the default) serialized the result. Content negotiation, end to end, with the function none the wiser.

## Dynamic Function Registration

Everything so far declared functions at compile time as `@Bean` methods. But the `FunctionCatalog` is a *live registry* — you can register (and unregister) functions at runtime through the `FunctionRegistry` interface. This is useful for plugin systems, functions loaded from configuration, or anything where the set of functions isn't known until the app is running.

```java
@Configuration
public class DynamicFunctionRegistrar {

    // FunctionRegistry is the mutable side of the FunctionCatalog.
    private final FunctionRegistry registry;

    public DynamicFunctionRegistrar(FunctionRegistry registry) {
        this.registry = registry;
    }

    @PostConstruct
    public void registerAtRuntime() {
        // Build a function that wasn't declared as a @Bean.
        Function<String, String> dynamicUppercase = String::toUpperCase;

        // Wrap it in a FunctionRegistration, giving it a name and its type.
        FunctionRegistration<Function<String, String>> registration =
                new FunctionRegistration<>(dynamicUppercase, "dynamicUppercase")
                        .type(FunctionTypeUtils.functionType(String.class, String.class));

        // Now it's in the catalog and every surface can reach it by name.
        registry.register(registration);
    }
}
```

After this runs, `dynamicUppercase` is a first-class function: `catalog.lookup("dynamicUppercase")` finds it, `POST /dynamicUppercase` works over HTTP, and you could even compose it: `enrichOrder|...`. The key gotcha is that you must supply the **type** explicitly via `FunctionRegistration.type(...)`, because a raw lambda erases its generics and the framework needs the types to wire up conversion.

## Multi-Argument Functions with Tuples

`Function<T, R>` takes one input. What about functions that legitimately need two or three inputs — say, joining an order stream with a customer stream? Spring Cloud Function supports this in two ways.

**`BiFunction`** for two inputs where one is a "context" object:

```java
// Two inputs: the order, and some pricing context.
@Bean
public BiFunction<Order, PricingContext, Decision> priceAndDecide() {
    return (order, pricing) -> new Decision(
            order.orderId(),
            pricing.isWithinBudget(order.amount()),
            "Priced against " + pricing.tier());
}
```

**Reactor `Tuple2`** for multiple *streams*, which is how the message surfaces model multi-input functions:

```java
@Configuration
public class TupleFunctions {

    // A function of two input streams, producing one output stream.
    // Over a stream binder, in-0 and in-1 map to two topics.
    @Bean
    public Function<Tuple2<Flux<Order>, Flux<PricingContext>>, Flux<Decision>> joinOrdersAndPricing() {
        return tuple -> {
            Flux<Order> orders = tuple.getT1();
            Flux<PricingContext> pricing = tuple.getT2();
            // Zip the two streams and decide.
            return Flux.zip(orders, pricing, (order, price) ->
                    new Decision(order.orderId(),
                            price.isWithinBudget(order.amount()),
                            "Joined decision"));
        };
    }
}
```

When bound to a message surface, a `Tuple2`-input function gets **multiple input bindings** — `joinOrdersAndPricing-in-0` and `joinOrdersAndPricing-in-1` — one per stream. This is the functional equivalent of a stream join.

---

With the function toolkit covered, the rest of the guide is the fun part: taking the *exact same* `functions-core` module and exposing it four different ways. Watch how little changes.

## Surface 1: HTTP with spring-cloud-function-web

The simplest surface. Add one dependency and every function bean becomes an HTTP endpoint — no controllers, no request mapping.

```kotlin
// app-web/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))     // the business logic
    implementation("org.springframework.cloud:spring-cloud-function-web")
}
```

```java
@SpringBootApplication
// Import the functions module so its beans are in this context.
@Import(PipelineFunctions.class)
public class WebApplication {
    public static void main(String[] args) {
        SpringApplication.run(WebApplication.class, args);
    }
}
```

That's the whole application. The web adapter maps functions to endpoints by name:

| HTTP call                              | What runs                                   |
| -------------------------------------- | ------------------------------------------- |
| `GET  /generateOrders`                 | the `generateOrders` Supplier               |
| `POST /enrichOrder`                    | the `enrichOrder` Function (body = `Order`) |
| `POST /validateOrder`                  | the `validateOrder` Function                |
| `POST /notifyDecision`                 | the `notifyDecision` Consumer (202 Accepted)|
| `POST /enrichOrder,validateOrder`      | **ad-hoc composition** for this one request |

The routing conventions:

- **`Supplier`** answers `GET` (it takes no input).
- **`Function`** answers `POST` with the input as the request body; the return value is the response body.
- **`Consumer`** answers `POST` and returns `202 Accepted` with an empty body (there's nothing to return).
- **Composition via commas.** `POST /enrichOrder,validateOrder` composes them for that call — the comma is the URL-safe stand-in for the pipe. You get to build pipelines from the client without redeploying.

### Headers and content types over HTTP

Because functions are transport-neutral, headers and content negotiation just work:

```bash
# JSON in, JSON out (the default).
curl -X POST http://localhost:8080/enrichOrder \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"o1","customerId":"c1","amount":1500,"currency":"USD","itemCount":3}'

# CSV in (thanks to our custom converter), JSON out.
curl -X POST http://localhost:8080/enrichOrder \
  -H 'Content-Type: text/csv' \
  -d 'o1,c1,1500,USD,3'

# A header the function can read via Message<Order>.
curl -X POST http://localhost:8080/processWithHeaders \
  -H 'Content-Type: application/json' \
  -H 'correlationId: trace-42' \
  -d '{"orderId":"o1","customerId":"c1","amount":1500,"currency":"USD","itemCount":3}'
```

The `processWithHeaders` function reads `correlationId` from the request headers and echoes it back as a *response* header, all through the `Message<T>` abstraction — the function has no idea it's HTTP.

### Configuration

```yaml
spring:
  cloud:
    function:
      # With many function beans, list the ones the web layer should expose,
      # or leave it out to expose them all by name.
      definition: generateOrders;enrichOrder;validateOrder;notifyDecision;processWithHeaders
server:
  port: 8080
```

## Surface 2: Kafka with Spring Cloud Stream

Now the *same functions* over Kafka. Spring Cloud Stream is built directly on top of Spring Cloud Function — your function beans *are* the stream processors. You don't write listeners; you bind functions to topics.

```kotlin
// app-stream-kafka/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.cloud:spring-cloud-stream")
    implementation("org.springframework.cloud:spring-cloud-stream-binder-kafka")
    // Distributed tracing across the pipeline.
    implementation("io.micrometer:micrometer-tracing-bridge-brave")
}
```

```java
@SpringBootApplication
@Import(PipelineFunctions.class)
public class StreamApplication {
    public static void main(String[] args) {
        SpringApplication.run(StreamApplication.class, args);
    }
}
```

The configuration binds the composed pipeline to Kafka topics. The binding names follow the `<function>-in-0` / `<function>-out-0` convention:

```yaml
spring:
  cloud:
    function:
      # Compose enrich + validate into one function bound to Kafka.
      definition: enrichOrder|validateOrder
    stream:
      bindings:
        # Input: read orders from the "orders" topic.
        enrichOrdervalidateOrder-in-0:
          destination: orders
          group: order-processor        # consumer group — required for DLQ
        # Output: write decisions to the "decisions" topic.
        enrichOrdervalidateOrder-out-0:
          destination: decisions
      kafka:
        binder:
          brokers: localhost:9092
        bindings:
          enrichOrdervalidateOrder-in-0:
            consumer:
              enable-dlq: true          # failed records go to a dead-letter topic
              dlq-name: orders-dlq
              # Send straight to DLQ on the first failure in this demo.
              # In production you'd usually retry a few times first.
      # For a Supplier, control how often it's polled.
      poller:
        fixed-delay: 1000
management:
  tracing:
    sampling:
      probability: 1.0                  # trace everything in the demo
```

The important observations for someone coming from `@KafkaListener`:

- **The composed name loses its pipe in the binding key.** `enrichOrder|validateOrder` becomes `enrichOrdervalidateOrder-in-0`. The framework strips the `|` when it derives the binding name. This bites everyone once.
- **`group` is required for the DLQ.** Dead-letter routing needs a consumer group; without one, `enable-dlq` silently does nothing. This is the single most common Spring Cloud Stream DLQ bug.
- **A `Consumer` has no `-out-0`.** If you bind `...|notifyDecision`, the composition ends in a sink and there's no output binding to declare.
- **Tracing is automatic.** With the Micrometer bridge on the classpath, trace context propagates through Kafka record headers across every hop of the pipeline — no code changes.

For a *much* deeper treatment of the stream side — the two Kafka binders, Kafka Streams, `DltAwareProcessor`, and error handling — see my dedicated [Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams/). Everything there builds on the function model this post describes.

## Surface 3: RSocket — Roll Your Own with the FunctionCatalog

Not every transport has a turnkey Spring Cloud Function adapter. RSocket is a great example — and it's also the best way to understand the "roll your own" pattern, because you inject the `FunctionCatalog` directly and invoke functions yourself. Once you've done this, you understand what *every* adapter is doing under the hood.

```kotlin
// app-rsocket/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.boot:spring-boot-starter-rsocket")
    implementation("org.springframework.cloud:spring-cloud-function-context")
}
```

The controller injects the catalog and maps RSocket routes to function lookups:

```java
@Controller
public class FunctionRSocketController {

    private final FunctionCatalog catalog;

    public FunctionRSocketController(FunctionCatalog catalog) {
        this.catalog = catalog;
    }

    // request/response: enrich a single order.
    @MessageMapping("orders.enrich")
    public Mono<EnrichedOrder> enrich(Order order) {
        Function<Order, EnrichedOrder> fn = catalog.lookup("enrichOrder");
        return Mono.just(fn.apply(order));
    }

    // request/response over the composed pipeline.
    @MessageMapping("orders.decide")
    public Mono<Decision> decide(Order order) {
        // Compose on lookup — same trick as everywhere else.
        Function<Order, Decision> fn = catalog.lookup("enrichOrder|validateOrder");
        return Mono.just(fn.apply(order));
    }

    // request/channel: a stream of orders in, a stream of decisions out.
    // This is where the reactive function earns its keep.
    @MessageMapping("orders.decideStream")
    public Flux<Decision> decideStream(Flux<Order> orders) {
        Function<Flux<Order>, Flux<Decision>> fn = catalog.lookup("reactivePipeline");
        return fn.apply(orders);
    }
}
```

```yaml
spring:
  rsocket:
    server:
      port: 7000
      transport: tcp
```

What this teaches:

- **`FunctionCatalog.lookup(name)` is the whole API.** Any transport you can imagine — RSocket, gRPC, a custom TCP protocol, a scheduled job — can host your functions by injecting the catalog and calling `lookup`.
- **Reactive functions map naturally onto streaming transports.** `orders.decideStream` is an RSocket request/channel; the `Function<Flux<Order>, Flux<Decision>>` fits it exactly, backpressure and all.
- **Still zero changes to `functions-core`.** The RSocket module imports the same beans and reaches them through the same catalog as everything else.

## Surface 4: AWS Lambda

Finally, the same functions as a serverless deployment. Spring Cloud Function's AWS adapter provides a generic Lambda handler that bridges the Lambda runtime to your function.

```kotlin
// adapter-aws/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.cloud:spring-cloud-function-adapter-aws")
    implementation("com.amazonaws:aws-lambda-java-core")
}
```

```java
@SpringBootApplication
@Import(PipelineFunctions.class)
public class LambdaApplication {
    public static void main(String[] args) {
        SpringApplication.run(LambdaApplication.class, args);
    }
}
```

```properties
# application.properties — pick which function this Lambda exposes.
spring.cloud.function.definition=enrichOrder|validateOrder
```

The deployment configuration on AWS points the Lambda's **handler** at Spring Cloud Function's generic invoker rather than at a class you wrote:

```
Handler: org.springframework.cloud.function.adapter.aws.FunctionInvoker
```

When Lambda invokes the function, `FunctionInvoker` boots (or reuses) the Spring context, looks up the function named by `spring.cloud.function.definition`, deserializes the event JSON into the input type, runs the function, and serializes the result back out. Your `enrichOrder|validateOrder` composition runs on Lambda with **zero AWS-specific code** in your business logic.

### Testing the Lambda handler in-process

The best part of the AWS adapter for development: you can drive the *exact deployable unit* locally, no AWS account required, by invoking `FunctionInvoker` with input and output streams — which is precisely what the Lambda runtime does.

```java
class LambdaHandlerTest {

    @Test
    void invokesFunctionEndToEnd() throws Exception {
        // The same class AWS configures as the handler.
        FunctionInvoker invoker = new FunctionInvoker();

        String orderJson = """
                {"orderId":"o1","customerId":"c1","amount":1500,
                 "currency":"USD","itemCount":3}
                """;
        var input = new ByteArrayInputStream(orderJson.getBytes(StandardCharsets.UTF_8));
        var output = new ByteArrayOutputStream();

        // Drive it exactly like the Lambda runtime: stream in, stream out.
        invoker.handleRequest(input, output, null);

        String result = output.toString(StandardCharsets.UTF_8);
        assertThat(result).contains("\"approved\":true");
    }
}
```

This is a genuinely underrated capability — you get high confidence that the thing you deploy works, without any of the pain of a real Lambda round-trip in your test loop.

## Testing Functions Across Every Surface

Because your logic is plain functions, the *core* tests need no Spring at all:

```java
class FunctionCatalogTest {

    // Pure unit test — no context, no transport, just the function.
    @Test
    void enrichMarksHighValueOrders() {
        Function<Order, EnrichedOrder> enrich = new PipelineFunctions().enrichOrder();
        EnrichedOrder result = enrich.apply(
                new Order("o1", "c1", BigDecimal.valueOf(2000), "USD", 2));
        assertThat(result.highValue()).isTrue();
    }
}
```

But the real confidence comes from proving the functions behave *identically* on every surface. Each surface module has an integration test:

- **`app-web`** — `WebTestClient` posts to `/enrichOrder`, `/enrichOrder,validateOrder`, and CSV/header variants, asserting the same decisions.
- **`app-stream-kafka`** — Testcontainers spins up a real Kafka broker, publishes to `orders`, and asserts decisions land on `decisions` (and bad records on `orders-dlq`). It auto-skips when Docker isn't available, so `./gradlew test` stays green on a laptop without Docker.
- **`app-rsocket`** — a real `RSocketRequester` client hits `orders.enrich`, `orders.decide`, and the streaming `orders.decideStream` route.
- **`adapter-aws`** — the in-process `FunctionInvoker` test shown above.

The through-line: **one set of assertions about business behavior, verified four ways.** When the function is right, every surface is right, because every surface runs the *same function*.

For the Kafka test, the Testcontainers pattern looks like this — and if you want the full treatment, see the [Ultimate Guide to Testcontainers with Spring Boot](/posts/ultimate-guide-testcontainers-spring-boot/):

```java
@SpringBootTest
@Testcontainers
@DisabledIfSystemProperty(named = "skip.docker", matches = "true")
class StreamPipelineTest {

    @Container
    static KafkaContainer kafka = new KafkaContainer(
            DockerImageName.parse("apache/kafka:3.8.0"));

    @DynamicPropertySource
    static void kafkaProps(DynamicPropertyRegistry registry) {
        registry.add("spring.cloud.stream.kafka.binder.brokers",
                kafka::getBootstrapServers);
    }

    @Test
    void validOrderProducesApprovedDecision() {
        // publish to "orders", consume from "decisions", assert approved=true
    }

    @Test
    void invalidOrderIsRoutedToDlq() {
        // publish a bad order, assert it lands on "orders-dlq"
    }
}
```

## GraalVM Native Image

Spring Cloud Function and GraalVM native images are a natural pair — especially for serverless, where cold-start time is money. A native Lambda starts in tens of milliseconds instead of seconds.

Spring Boot's AOT processing handles most of the work. Add the native build plugin and build:

```kotlin
plugins {
    id("org.graalvm.buildtools.native") version "0.10.3"
}
```

```bash
./gradlew nativeCompile
```

What you need to know:

- **Plain function beans work out of the box.** `Supplier`, `Function`, `Consumer` over standard types need no hints — Spring's AOT engine registers them.
- **Reflection on your domain types.** JSON (de)serialization of `Order`, `EnrichedOrder`, and `Decision` needs reflection metadata. Records defined in your own module are usually picked up by AOT, but if you hit a `ClassNotFoundException` or empty-fields-at-runtime symptom, register a hint:

  ```java
  @Configuration
  @ImportRuntimeHints(FunctionRuntimeHints.class)
  public class NativeConfig {
  }

  class FunctionRuntimeHints implements RuntimeHintsRegistrar {
      @Override
      public void registerHints(RuntimeHints hints, ClassLoader cl) {
          hints.reflection()
                  .registerType(Order.class, MemberCategory.values())
                  .registerType(EnrichedOrder.class, MemberCategory.values())
                  .registerType(Decision.class, MemberCategory.values());
      }
  }
  ```

- **Dynamic and reflective features need extra care.** Runtime function registration (via `FunctionRegistry`) and SpEL routing expressions can be harder for AOT to reason about — test the native binary, don't assume JVM behavior transfers.
- **The AWS adapter has native support.** Deploy a native Lambda with a custom runtime for the dramatic cold-start win; the demo's README walks through the packaging.

If native images are your main interest, my [Go vs Spring Boot native benchmark](/posts/go-vs-spring-boot-native-benchmark/) has real cold-start and memory numbers.

## Common Pitfalls and Troubleshooting

### "No such function" / function not found

**Symptom:** startup or invocation error that a function can't be resolved.

**Cause:** ambiguity. You have multiple function beans and Spring Cloud Function doesn't know which to bind.

**Fix:** be explicit with `spring.cloud.function.definition`. If you have exactly one function bean it's inferred; with two or more, always name it.

### The pipe disappears in stream binding names

**Symptom:** your Kafka binding config is ignored.

**Cause:** you wrote `enrichOrder|validateOrder-in-0` as the binding key. The framework strips the `|`, so the actual binding name is `enrichOrdervalidateOrder-in-0`.

```yaml
# WRONG
spring.cloud.stream.bindings.enrichOrder|validateOrder-in-0.destination: orders
# RIGHT — the pipe is removed when the binding name is derived
spring.cloud.stream.bindings.enrichOrdervalidateOrder-in-0.destination: orders
```

### DLQ silently does nothing

**Symptom:** `enable-dlq: true` but failed messages never reach the dead-letter topic.

**Cause:** no consumer `group`. Dead-letter routing requires a consumer group.

**Fix:** always set `group` on the input binding when you want a DLQ.

### Types don't line up in a composition

**Symptom:** conversion error composing `a|b`.

**Cause:** `a`'s output type and `b`'s input type don't match and there's no converter to bridge them.

**Fix:** make the types align, or register a `MessageConverter` for the content type in play. Remember that off-the-wire input is bytes/`String` and relies on the declared `Content-Type` to convert.

### A `Supplier` only fires once (or never) in a stream

**Symptom:** your source function runs a single time or not at all.

**Cause:** imperative `Supplier<T>` is *polled*. Without a poller configured it uses the default interval; a reactive `Supplier<Flux<T>>` is subscribed once and runs continuously.

**Fix:** set `spring.cloud.stream.poller.fixed-delay` for imperative suppliers, or return a `Flux` for a continuous source.

### Dynamic function registered but "untyped"

**Symptom:** a runtime-registered function fails conversion.

**Cause:** you didn't set `.type(...)` on the `FunctionRegistration`, so generics were erased and the framework can't wire up converters.

**Fix:** always supply the type via `FunctionTypeUtils.functionType(...)`.

## Taking It to Production

The demo is intentionally simplified. Before you ship functions in anger:

- **Pin exactly one function per Lambda.** A Lambda should do one thing; set `spring.cloud.function.definition` to a single function or composition and keep the deployable focused.
- **Configure real retry before the DLQ.** `max-attempts: 1` (straight to DLQ) is a demo choice. In production, retry transient failures with backoff and only dead-letter what's genuinely poisoned.
- **Watch the composition types at the edges.** The wire always speaks bytes; be deliberate about `Content-Type` so the right converter runs. Log the resolved converter when debugging.
- **Guard the web surface.** `spring-cloud-function-web` exposes *every* function by name unless you constrain the definition. Don't accidentally expose an internal function to the internet — scope `spring.cloud.function.definition` and put it behind auth.
- **Go native for serverless.** The cold-start improvement from a GraalVM native Lambda is the difference between "usable" and "painful" for latency-sensitive event handlers. Budget the build time and test the native binary.
- **Propagate tracing everywhere.** The Micrometer bridge gives you a trace across HTTP, Kafka, and RSocket hops for free — wire it to a real collector so a single order's journey across surfaces is one trace.
- **Keep `functions-core` free of transport dependencies.** The entire value proposition collapses the moment your business module imports a web or Kafka type. Enforce it — a module boundary or an ArchUnit test — so the functions stay portable.

## Wrapping Up

Spring Cloud Function asks you to make one shift in how you think about a Spring application: **the unit of code is a function, not a controller or a listener.** Once you make that shift, an enormous amount of accidental complexity falls away. Your business logic becomes plain `java.util.function` beans that you can unit test with no framework at all. Exposing them over HTTP, Kafka, RSocket, or AWS Lambda stops being a rewrite and becomes a matter of adding a dependency and a few lines of config. Composition, routing, content negotiation, and reactive streaming are all available to every surface, because every surface talks to the same `FunctionCatalog`.

The demo proves the thesis the hard way: one `functions-core` module, four surfaces, and a set of integration tests that assert the *same* business behavior four different ways — without the functions ever knowing which transport called them. That's the promise, and it holds.

If you take one thing away: keep your `functions-core` pure. No `@RestController`, no `@KafkaListener`, no AWS types. The moment your functions know how they're being invoked, you've lost the portability that makes this worth doing. Guard that boundary and Spring Cloud Function will let you deploy the same logic anywhere the business needs it next.

The full demo repository used throughout this post — `functions-core` plus the `app-web`, `app-stream-kafka`, `app-rsocket`, and `adapter-aws` modules, with tests covering every surface — is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-cloud-function-ultimate-guide). The `scripts/` directory has `run-demo.sh` (builds everything and starts Kafka via Docker Compose), `demo-requests.sh` (exercises every surface end to end, labeled), and `stop-demo.sh`, so you can watch one set of functions answer over four transports in a couple of commands.

If you found this useful, the [Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams/) goes much deeper on the Kafka surface, the [Ultimate Guide to Testcontainers with Spring Boot](/posts/ultimate-guide-testcontainers-spring-boot/) covers the integration-testing patterns used here, and the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/) covers the platform everything in this post runs on.
