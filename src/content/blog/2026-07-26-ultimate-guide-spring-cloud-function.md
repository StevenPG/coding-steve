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

**So what is it?** Spring Cloud Function is a Spring Cloud project that turns plain Java functions — `Supplier`, `Function`, and `Consumer` beans from `java.util.function` — into the fundamental building block of your application, and then does all the tedious plumbing needed to run those functions in different environments. It gives you a uniform programming model for business logic and takes care of the surrounding concerns: discovering your function beans into a `FunctionCatalog`, converting payloads to and from the wire (JSON by default, or any content type you teach it), composing functions into pipelines, and routing between them at runtime. Crucially, it also ships **adapters** that attach those same functions to a concrete runtime — an HTTP endpoint, a message broker via Spring Cloud Stream, or a serverless platform like AWS Lambda, Azure Functions, or Google Cloud Functions.

What is it actually *used for*? Three big things. First, **serverless / FaaS**: it's the idiomatic way to write an AWS Lambda (or Azure/GCP function) in Spring without coupling your code to a cloud SDK, so you can develop and test locally and deploy the same jar to the cloud. Second, **event-driven microservices**: Spring Cloud Stream is built directly on top of it, so every Kafka or RabbitMQ processor you write *is* a Spring Cloud Function under the hood. Third, **portable, transport-agnostic business logic**: because a function has no idea how it's being invoked, you can expose the same logic over HTTP today and add a Kafka binding tomorrow without rewriting anything — which is exactly what this guide demonstrates.

Here's the one sentence that unlocks it:

> **Spring Cloud Function lets you write your business logic once, as plain `java.util.function` beans, and then expose those exact same beans over HTTP, over a message broker, over RSocket, or as a serverless function — without changing a single line of the functions.**

That's the whole idea. Your business logic is a `Function<Order, Decision>`. It has no idea whether it's being called by a REST endpoint, a Kafka binding, an RSocket route, or an AWS Lambda invocation. The *transport* is a deployment concern that Spring Cloud Function bolts on at the edge. Your code stays boring, testable, and portable.

This guide is the comprehensive, Spring-Boot-4-native tour I wish I'd had. We'll start from the three interfaces everything is built on, work through composition, reactive functions, `Message<T>` and headers, runtime routing, custom content types, dynamic registration, and multi-arity tuples — and *then* we'll take one identical `functions-core` module and light it up over **four different surfaces**, one at a time, so you can see with your own eyes that the functions never change.

Everything here is built and tested against a real, runnable companion project:

| Piece                          | Version                       |
| ------------------------------ | ----------------------------- |
| Spring Boot                    | **4.0.7**                     |
| Spring Cloud                   | **2025.1.2** ("Oakwood")      |
| Spring Cloud Function          | **5.0.3** (pinned by the BOM) |
| Spring Cloud Stream            | **5.0.2** (pinned by the BOM) |
| Java                           | **21**                        |
| Gradle                         | **8.14**                      |
| Kafka                          | `apache/kafka` **3.9**        |

The full demo repository is linked at the end and referenced throughout. It's a multi-module Gradle build: one `functions-core` module holding *all* the business logic, and four thin "surface" modules that each expose those same functions a different way. Every module below `functions-core` writes **zero business logic**. If you already use Spring Cloud Function and just want a specific piece, jump to [Surface 1: HTTP](#surface-1-http-with-spring-cloud-function-web), [Kafka](#surface-2-kafka-with-spring-cloud-stream), [RSocket](#surface-3-rsocket-roll-your-own-with-the-functioncatalog), or [AWS Lambda](#surface-4-aws-lambda).

## The Core Idea: Functions as the Unit of Deployment

Traditional Spring applications organize around *frameworks*. You write a `@RestController` for HTTP, a `@KafkaListener` for messaging, an `@MessageMapping` for RSocket. Each of those couples your business logic to a transport. The logic that decides whether to approve an order ends up living inside an HTTP handler, and the day you need that same decision on a Kafka topic, you copy-paste it into a listener.

Spring Cloud Function inverts this. The unit of code is a **function bean** — one of the three interfaces from `java.util.function`:

| Interface        | Shape                | Role                          |
| ---------------- | -------------------- | ----------------------------- |
| `Supplier<R>`    | `() -> R`            | A source. Produces output, takes no input. |
| `Function<T, R>` | `T -> R`             | A transform. Input in, output out.          |
| `Consumer<T>`    | `T -> void`          | A sink. Consumes input, produces nothing.   |

You register these as ordinary Spring beans. Spring Cloud Function discovers them, wraps each one in a `FunctionInvocationWrapper`, and puts it in a registry called the **`FunctionCatalog`**. Every surface adapter — web, stream, RSocket, Lambda — talks to that catalog. None of them talk to your beans directly.

The payoff is that "how do I expose this?" becomes a *dependency and configuration* question, not a *rewrite* question. Want it over HTTP? Add `spring-cloud-starter-function-web`. Over Kafka? Add a Spring Cloud Stream binder. As a Lambda? Add the AWS adapter and set a handler. The functions don't move.

### The demo's business logic

Throughout this guide, the running example is a small order-processing pipeline. In the demo everything lives under the `com.stevenpg.scf` package. Here are the domain types — plain records, nothing framework-specific:

```java
// The raw order that enters the pipeline.
public record Order(
        String orderId,
        String customerId,
        BigDecimal amount,
        String currency,
        int itemCount) {
}

// An Order after enrichment: we've added the customer's tier and a risk score
// that the decision step needs. A distinct type keeps the pipeline strongly
// typed end to end.
public record EnrichedOrder(
        String orderId,
        String customerId,
        BigDecimal amount,
        String currency,
        int itemCount,
        String customerTier,
        int riskScore) {

    // Convenience factory that carries the original order fields forward.
    public static EnrichedOrder from(Order order, String customerTier, int riskScore) {
        return new EnrichedOrder(order.orderId(), order.customerId(), order.amount(),
                order.currency(), order.itemCount(), customerTier, riskScore);
    }
}

// The pipeline's verdict. `outcome` doubles as a routing key downstream.
public record Decision(
        String orderId,
        String outcome,        // APPROVED | REJECTED | REVIEW
        String reason,
        BigDecimal amount,
        String customerTier) {

    public static final String APPROVED = "APPROVED";
    public static final String REJECTED = "REJECTED";
    public static final String REVIEW   = "REVIEW";
}
```

Nothing here imports Spring. That's the point — this is code you could unit test with plain JUnit and no application context at all.

## The Three Interfaces in Practice

Let's define the pipeline as function beans. In the demo these live in `PipelineFunctions.java`. The **bean name** is the name you'll use everywhere to select or compose a function, so name them deliberately.

### Supplier — producing values

A `Supplier<T>` is a source. It takes nothing and returns a value. Depending on the surface, it's invoked differently: over HTTP a `GET /generateOrders` calls it once; in Spring Cloud Stream it's *polled* on a schedule; as a Lambda it runs when triggered.

```java
@Configuration
public class PipelineFunctions {

    // A source of orders. Over HTTP this responds to GET /generateOrders; in a
    // stream it can be polled on a schedule. Deterministic so tests are stable.
    @Bean
    public Supplier<Order> generateOrders() {
        AtomicLong seq = new AtomicLong();
        String[] customers = {"cust-alice", "cust-bob", "cust-carol", "cust-dave"};
        return () -> {
            long n = seq.incrementAndGet();
            String customer = customers[(int) (n % customers.length)];
            BigDecimal amount = BigDecimal.valueOf(50L + (n * 37L) % 15000L);
            int items = 1 + (int) (n % 5);
            return new Order("ord-" + n, customer, amount, "USD", items);
        };
    }
```

### Function — transforming values

A `Function<T, R>` is the workhorse. `enrichOrder` adds derived fields (a customer tier and a risk score); `validateOrder` turns an enriched order into a decision. They're deliberately typed so they compose: `enrichOrder`'s output is exactly `validateOrder`'s input.

```java
    // Order -> EnrichedOrder. Adds the tier and risk score later stages need.
    @Bean
    public Function<Order, EnrichedOrder> enrichOrder() {
        return order -> EnrichedOrder.from(order,
                tierFor(order.customerId()),
                riskScore(order));
    }

    // EnrichedOrder -> Decision. The natural composition partner of enrichOrder,
    // so `enrichOrder|validateOrder` is a Function<Order, Decision>.
    @Bean
    public Function<EnrichedOrder, Decision> validateOrder() {
        return PipelineFunctions::decide;
    }
```

The business rules are plain static methods — deterministic, unit-testable, and shared by the reactive and tuple variants later:

```java
    static String tierFor(String customerId) {
        int h = Math.abs(customerId.hashCode()) % 3;
        return switch (h) {
            case 0 -> "PLATINUM";
            case 1 -> "GOLD";
            default -> "STANDARD";
        };
    }

    static int riskScore(Order order) {
        int base = order.amount().intValue() / 200;   // pricier -> riskier
        int itemsFactor = order.itemCount() * 5;
        return Math.min(100, base + itemsFactor);
    }

    static Decision decide(EnrichedOrder e) {
        if (e.riskScore() >= 70) {
            return new Decision(e.orderId(), Decision.REVIEW,
                    "risk score " + e.riskScore() + " needs manual review",
                    e.amount(), e.customerTier());
        }
        boolean bigSpender = e.amount().compareTo(BigDecimal.valueOf(10_000)) > 0;
        if (bigSpender && !"PLATINUM".equals(e.customerTier())) {
            return new Decision(e.orderId(), Decision.REJECTED,
                    "amount over limit for tier " + e.customerTier(),
                    e.amount(), e.customerTier());
        }
        return new Decision(e.orderId(), Decision.APPROVED,
                "within risk and spend limits", e.amount(), e.customerTier());
    }
```

### Consumer — the sink

A `Consumer<T>` takes a value and returns nothing. It's the end of a pipeline. Note the explicit bean name — the *method* is `notifyOutcome`, but the **bean** is `notify`, which is what you'll compose against:

```java
    // A sink. Compose it onto the end for a fire-and-forget pipeline:
    // `enrichOrder|validateOrder|notify` is a Consumer<Order>.
    @Bean("notify")
    public Consumer<Decision> notifyOutcome() {
        return decision -> LOG.log(Level.INFO, "notify -> order {0} was {1} ({2})",
                decision.orderId(), decision.outcome(), decision.reason());
    }
```

### A function over a collection

One more that's easy to miss and very useful: a function of `List<T>` in, `List<R>` out. This is how you batch on the messaging surfaces, and over HTTP it just accepts a JSON array:

```java
    // List<Order> -> List<Decision>. Reuses the two functions above.
    @Bean
    public Function<List<Order>, List<Decision>> validateBatch() {
        Function<Order, EnrichedOrder> enrich = enrichOrder();
        Function<EnrichedOrder, Decision> validate = validateOrder();
        return orders -> orders.stream().map(enrich).map(validate).toList();
    }
}
```

That's the entire business layer: a source, two transforms, a sink, and a batch variant. Everything else in this guide is about *how you invoke them*.

## The FunctionCatalog: How Spring Sees Your Beans

When Spring Cloud Function starts, it scans for `Supplier`, `Function`, and `Consumer` beans and registers each one in the `FunctionCatalog` under its **bean name**. You can inject the catalog and look functions up by name — this is the "roll your own" API that the RSocket surface uses later:

```java
FunctionCatalog catalog = ...; // injected
// Look up a composed function by name. The catalog returns a
// FunctionInvocationWrapper that implements Function<Object, Object>.
Function<Order, Decision> pipeline = catalog.lookup("enrichOrder|validateOrder");
Decision decision = pipeline.apply(order);
```

Two things are doing a lot of work here and are worth internalizing:

1. **The lookup name is the bean name.** `enrichOrder` the bean is `enrichOrder` in the catalog. If you have one function and no ambiguity, most surfaces find it automatically. When there's more than one, you disambiguate with `spring.cloud.function.definition`.
2. **`|` composes on the fly.** `catalog.lookup("enrichOrder|validateOrder")` returns a *single* function whose input is `enrichOrder`'s input (`Order`) and whose output is `validateOrder`'s output (`Decision`). The catalog also transparently inserts type conversion between steps when needed.

### `spring.cloud.function.definition`

The single most important property in all of Spring Cloud Function is `spring.cloud.function.definition`. It tells a surface *which* function to bind when there's ambiguity.

```yaml
spring:
  cloud:
    function:
      # Bind this single logical function. It's a composition of two beans.
      definition: enrichOrder|validateOrder
```

- A single name (`enrichOrder`) selects one bean.
- A pipe-composed name (`enrichOrder|validateOrder`) selects a composition.
- A semicolon-separated list (`enrichOrder;validateOrder;notify`) declares *multiple* independent functions — used when a surface can host several.

If there's exactly one function bean in the application, you can often omit this entirely and Spring Cloud Function will infer it. The moment there are two, be explicit — or, as the web surface does, let an adapter that supports many functions expose them all by name.

## Function Composition

Composition is Spring Cloud Function's superpower, and the `|` operator is how you express it. Composition shows up at three levels, and different surfaces expose different ones:

**1. In configuration** — the definition property, resolved at startup:

```yaml
spring:
  cloud:
    function:
      definition: enrichOrder|validateOrder|notify
```

That composes a `Function`, a `Function`, and a `Consumer` into a single `Consumer<Order>` — input goes in, flows through enrichment and validation, and lands in the sink. **The type of the composition is determined by its last element:** end with a `Consumer` and the whole thing is a consumer; end with a `Function` and it's a function.

**2. At the HTTP edge** — the web adapter lets you compose *ad hoc* per request using a comma-separated path. `POST /enrichOrder,validateOrder` composes them for that one call (the comma is the URL-safe stand-in for the pipe).

**3. Programmatically** — via `catalog.lookup("a|b")` as shown above.

The rule that trips people up: **types have to line up, or a converter has to exist.** `enrichOrder` outputs `EnrichedOrder`; `validateOrder` inputs `EnrichedOrder`; they compose cleanly. When one side is `byte[]` or `String` (as it is off the wire), Spring Cloud Function's message converters bridge the gap using the declared content type — which is exactly why the same `Function<Order, Decision>` can be fed raw JSON bytes over HTTP.

## Reactive Functions: Flux and Mono

Everything so far has been *imperative* — one input, one output. Spring Cloud Function is equally happy with **reactive** signatures using Project Reactor's `Flux` (0..N) and `Mono` (0..1). It treats `Function<Order, Decision>` and `Function<Flux<Order>, Flux<Decision>>` uniformly — it will adapt an imperative function into a reactive stream and vice versa, so an adapter can call either style. You reach for the reactive form when you want to work on the *stream itself*: buffering, windowing, backpressure, async fan-out.

In the demo these live in `ReactiveFunctions.java`, side by side with the imperative ones, reusing the same static business rules:

```java
@Configuration
public class ReactiveFunctions {

    // The whole pipeline as one reactive function. This is where you'd add
    // .buffer(), .window(), .flatMap(this::callAsyncService), etc.
    @Bean
    public Function<Flux<Order>, Flux<Decision>> reactivePipeline() {
        return orders -> orders
                .map(o -> EnrichedOrder.from(o,
                        PipelineFunctions.tierFor(o.customerId()),
                        PipelineFunctions.riskScore(o)))
                .map(PipelineFunctions::decide);
    }

    // Reactive halves, so you can compose reactive-with-reactive
    // (reactiveEnrich|reactiveValidate).
    @Bean
    public Function<Flux<Order>, Flux<EnrichedOrder>> reactiveEnrich() {
        return orders -> orders.map(o -> EnrichedOrder.from(o,
                PipelineFunctions.tierFor(o.customerId()),
                PipelineFunctions.riskScore(o)));
    }

    @Bean
    public Function<Flux<EnrichedOrder>, Flux<Decision>> reactiveValidate() {
        return enriched -> enriched.map(PipelineFunctions::decide);
    }

    // A reactive Supplier is special: Supplier<Flux<T>> is an UNBOUNDED source.
    // Point a stream binding at `liveOrders` and you get a self-driving
    // producer — no `poller` configuration involved at all.
    @Bean
    public Supplier<Flux<Order>> liveOrders() {
        Supplier<Order> imperative = new PipelineFunctions().generateOrders();
        return () -> Flux.interval(Duration.ofSeconds(1)).map(tick -> imperative.get());
    }
}
```

Things worth knowing about reactive functions:

- **You can mix imperative and reactive in a composition.** Spring Cloud Function lifts an imperative `Function<T, R>` into a reactive context when composing.
- **A reactive function is invoked once, with the whole stream.** Unlike an imperative function called per message, `Function<Flux<Order>, Flux<Decision>>` receives the entire flux and you operate on it with operators — that's how you implement windowing or batching.
- **A reactive `Supplier<Flux<T>>` is an unbounded producer.** `liveOrders` becomes a continuous source with no polling config, versus an imperative `Supplier<T>` that gets polled on a fixed delay.
- **Don't block inside a reactive function.** If you must, `subscribeOn` a bounded-elastic scheduler — same rules as any Reactor code.

## Messages and Headers

So far the functions dealt in plain domain objects. But real transports carry **metadata** — HTTP headers, Kafka record headers. When your function needs to *see* or *set* that metadata, you declare it in terms of `Message<T>` instead of `T`. Spring Cloud Function still converts the payload to `T` for you but *also* hands you the headers. In the demo this is `MessageFunctions.decideWithHeaders`:

```java
@Configuration
public class MessageFunctions {

    // Read an inbound `channel` header, run the decision, and echo the channel
    // back plus a couple of derived headers. Over HTTP these become response
    // headers; over Kafka they become record headers. Same function, both.
    @Bean
    public Function<Message<Order>, Message<Decision>> decideWithHeaders() {
        return message -> {
            Order order = message.getPayload();
            Object channel = message.getHeaders().getOrDefault("channel", "unknown");

            EnrichedOrder enriched = EnrichedOrder.from(order,
                    PipelineFunctions.tierFor(order.customerId()),
                    PipelineFunctions.riskScore(order));
            Decision decision = PipelineFunctions.decide(enriched);

            return MessageBuilder.withPayload(decision)
                    .setHeader("channel", channel)
                    .setHeader("decision-outcome", decision.outcome())
                    .setHeader("customer-tier", decision.customerTier())
                    .setHeader("processed-by", "decideWithHeaders")
                    .build();
        };
    }
}
```

The beautiful part: **`Message<T>` is transport-neutral.** The same `decideWithHeaders` bean reads `channel` whether it arrived as an HTTP request header or a Kafka record header, because each surface adapter normalizes its native metadata into `MessageHeaders`. This is the idiomatic way to carry correlation IDs, tenant IDs, or trace context through a function.

When to use `Message<T>` vs. a plain type:

- **Plain type (`Order`)** — when your logic only cares about the payload. This is the majority of functions. Keep it simple.
- **`Message<T>`** — when you need to read incoming metadata or set outgoing metadata.

## Runtime Message Routing

Sometimes a single logical endpoint needs to dispatch to *different* functions based on the content or headers of each message. Spring Cloud Function has a built-in facility: the reserved **`functionRouter`** function. Set `spring.cloud.function.definition=functionRouter` and it decides, per message, which real function to invoke, picking the target in this order of precedence:

1. a `spring.cloud.function.definition` **message header**;
2. the `spring.cloud.function.routing-expression` SpEL property;
3. a `MessageRoutingCallback` bean — the programmatic hook.

The demo uses the callback (`RoutingConfig`) to send small "express" orders down a cheap fast-approve path and everything else through the full pipeline:

```java
@Configuration
public class RoutingConfig {

    // The cheap path: express orders are auto-approved without enrichment.
    @Bean
    public Function<Order, Decision> fastApprove() {
        return order -> new Decision(order.orderId(), Decision.APPROVED,
                "auto-approved via express fast-lane", order.amount(), "EXPRESS");
    }

    // Programmatic routing: return the function definition string to invoke.
    // We route on a HEADER so it works before the payload is even converted.
    @Bean
    public MessageRoutingCallback orderRouter() {
        return new MessageRoutingCallback() {
            @Override
            public String routingResult(Message<?> message) {
                Object channel = message.getHeaders().get("order-channel");
                if ("express".equals(channel)) {
                    return "fastApprove";
                }
                return "enrichOrder|validateOrder";   // default: the full pipeline
            }
        };
    }
}
```

Now a single endpoint (`POST /functionRouter`, or one Kafka binding) fans out to `fastApprove` or the full `enrichOrder|validateOrder` pipeline depending on the `order-channel` header. If your routing is a simple header-to-name mapping, you can skip the callback entirely and use a SpEL expression instead — no code required:

```yaml
spring:
  cloud:
    function:
      definition: functionRouter
      routing-expression: "headers['order-channel'] == 'express' ? 'fastApprove' : 'enrichOrder|validateOrder'"
```

## Custom Content Types and Message Converters

By default Spring Cloud Function speaks JSON — it uses Jackson to convert between the bytes on the wire and your POJOs, keyed off the `Content-Type`. But you can teach it *any* wire format by registering a `MessageConverter`, and SCF builds a composite converter from every `MessageConverter` bean in the context plus its built-in JSON/`byte[]`/`String` ones. The demo does this for `text/csv`, so the very same `enrichOrder` function can accept a CSV line as an order — no change to the function.

```java
// Teaches the pipeline to speak text/csv in addition to JSON.
// CSV shape (one order per message): orderId,customerId,amount,currency,itemCount
public class CsvOrderMessageConverter extends AbstractMessageConverter {

    public CsvOrderMessageConverter() {
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
        String csv = asString(message.getPayload()).trim();
        String[] f = csv.split(",");
        if (f.length != 5) {
            throw new IllegalArgumentException(
                    "expected 5 CSV fields (orderId,customerId,amount,currency,itemCount) but got: " + csv);
        }
        return new Order(f[0].trim(), f[1].trim(), new BigDecimal(f[2].trim()),
                f[3].trim(), Integer.parseInt(f[4].trim()));
    }

    // Order -> wire (CSV)
    @Override
    protected Object convertToInternal(Object payload, MessageHeaders headers, Object hint) {
        Order o = (Order) payload;
        return String.join(",", o.orderId(), o.customerId(),
                o.amount().toPlainString(), o.currency(), Integer.toString(o.itemCount()))
                .getBytes(StandardCharsets.UTF_8);
    }
}
```

Contributing the new format is just declaring the bean:

```java
@Configuration
public class ConverterConfig {

    @Bean
    public CsvOrderMessageConverter csvOrderMessageConverter() {
        return new CsvOrderMessageConverter();
    }
}
```

Now a caller can `POST` a body of `ord-9,cust-alice,199.99,USD,3` with `Content-Type: text/csv` to `/enrichOrder` and get back an enriched order as JSON — the *input* converter turned CSV into an `Order`, the function ran unchanged, and the *output* converter (JSON, the default) serialized the result. That's how you support a legacy wire format without touching business logic.

## Dynamic Function Registration

Everything so far declared functions at compile time as `@Bean` methods. But the `FunctionCatalog` is also a `FunctionRegistry` — you can push new functions into it *while the application is running*. This is the seed of the "function deployer" idea: accept a function's definition (or even its jar) over an API and make it invocable immediately, with no redeploy. The demo registers a trivial `dynamicUppercase` once all singletons are ready:

```java
@Component
public class DynamicFunctionRegistrar implements SmartInitializingSingleton {

    private final FunctionRegistry functionRegistry;

    public DynamicFunctionRegistrar(FunctionRegistry functionRegistry) {
        this.functionRegistry = functionRegistry;
    }

    @Override
    public void afterSingletonsInstantiated() {
        Function<String, String> fn = input -> input == null ? null : input.toUpperCase();

        // SCF needs the generic signature to know how to convert inputs/outputs.
        Type functionType = ResolvableType
                .forClassWithGenerics(Function.class, String.class, String.class)
                .getType();

        FunctionRegistration<Function<String, String>> registration =
                new FunctionRegistration<>(fn, "dynamicUppercase").type(functionType);

        functionRegistry.register(registration);
    }
}
```

After this runs, `dynamicUppercase` is a first-class function: `catalog.lookup("dynamicUppercase")` finds it and `POST /dynamicUppercase` works over HTTP, exactly like the compile-time beans. The key gotcha is that you **must supply the type** via `FunctionRegistration.type(...)` — a raw lambda erases its generics, and without the type the framework can't wire up conversion.

## Multi-Argument Functions with Tuples

A `Function<T, R>` is one-in / one-out. Spring Cloud Function supports **many-in and many-out** using Reactor's `Tuple2` of `Flux`. On a messaging binder, each slot of the tuple maps to its own binding (its own topic) — which is how you fan in from several topics or fan out to several topics from a single function. The demo shows both directions in `TupleFunctions.java`.

**Multi-output (fan-out)** — one stream of orders in, two streams of decisions out:

```java
// One input stream; TWO output streams (approved vs. everything else).
// On Kafka these become two separate output topics.
@Bean
public Function<Flux<Order>, Tuple2<Flux<Decision>, Flux<Decision>>> partitionDecisions() {
    return orders -> {
        // publish().autoConnect(2) lets both downstream flows share ONE upstream
        // subscription instead of running the pipeline twice.
        Flux<Decision> decisions = orders
                .map(o -> EnrichedOrder.from(o,
                        PipelineFunctions.tierFor(o.customerId()),
                        PipelineFunctions.riskScore(o)))
                .map(PipelineFunctions::decide)
                .publish()
                .autoConnect(2);

        Flux<Decision> approved = decisions.filter(d -> Decision.APPROVED.equals(d.outcome()));
        Flux<Decision> needsAttention = decisions.filter(d -> !Decision.APPROVED.equals(d.outcome()));
        return Tuples.of(approved, needsAttention);
    };
}
```

**Multi-input (fan-in)** — a stream of orders zipped with a parallel stream of priority flags:

```java
// TWO input streams joined into one decision stream. On Kafka these are two
// input topics feeding one function.
@Bean
public Function<Tuple2<Flux<Order>, Flux<String>>, Flux<Decision>> joinWithPriority() {
    return tuple -> {
        Flux<Order> orders = tuple.getT1();
        Flux<String> priorities = tuple.getT2();
        return orders.zipWith(priorities, (order, priority) -> {
            EnrichedOrder enriched = EnrichedOrder.from(order,
                    PipelineFunctions.tierFor(order.customerId()),
                    PipelineFunctions.riskScore(order));
            Decision base = PipelineFunctions.decide(enriched);
            // "high" priority forces a manual review regardless of the score.
            if ("high".equalsIgnoreCase(priority) && Decision.APPROVED.equals(base.outcome())) {
                return new Decision(base.orderId(), Decision.REVIEW,
                        "high-priority manual review requested", base.amount(), base.customerTier());
            }
            return base;
        });
    };
}
```

The subtlety with `partitionDecisions` — and it's the same subtlety a Kafka binder handles for you — is that **both outputs must be subscribed before the shared upstream connects**. That's exactly what `publish().autoConnect(2)` guarantees, and it's why the test zips both outputs together before asserting.

---

With the function toolkit covered, the rest of the guide is the fun part: taking the *exact same* `functions-core` module and exposing it four different ways. Watch how little changes — every surface module below writes **zero** business logic.

## Surface 1: HTTP with spring-cloud-function-web

The simplest surface. Add one starter and every function bean becomes an HTTP endpoint — no controllers, no request mapping.

```kotlin
// app-web/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))     // the business logic
    implementation("org.springframework.cloud:spring-cloud-starter-function-web")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
}
```

```java
@SpringBootApplication   // in package com.stevenpg.scf — component scanning finds functions-core
public class WebApplication {
    public static void main(String[] args) {
        SpringApplication.run(WebApplication.class, args);
    }
}
```

That's the whole application — no controller and no function of its own. Because it sits in the `com.stevenpg.scf` base package, component scanning picks up every `@Configuration` from `functions-core`, and `spring-cloud-function-web` publishes each function bean as an HTTP endpoint automatically:

| HTTP call                              | What runs                                       |
| -------------------------------------- | ----------------------------------------------- |
| `GET  /generateOrders`                 | the `generateOrders` Supplier                   |
| `POST /enrichOrder`                    | the `enrichOrder` Function (body = `Order`)     |
| `POST /enrichOrder,validateOrder`      | **ad-hoc composition** for this one request     |
| `POST /notify`                         | the `notify` Consumer (`202 Accepted`)          |
| `POST /validateBatch`                  | the batch function (body = JSON array)          |
| `POST /decideWithHeaders`              | reads/sets headers via `Message<T>`             |
| `POST /functionRouter` + `order-channel` | header-driven routing                         |
| `POST /dynamicUppercase`               | the runtime-registered function                 |

The routing conventions:

- **`Supplier`** answers `GET` (it takes no input).
- **`Function`** answers `POST` with the input as the request body; the return value is the response body.
- **`Consumer`** answers `POST` and returns `202 Accepted` with an empty body.
- **Composition via commas.** `POST /enrichOrder,validateOrder` composes for that call — build pipelines from the client without redeploying.

You don't need to *list* functions in config — with `spring-cloud-function-web` they're all exposed at `POST /<name>`. The demo's YAML mostly just mounts them at the root context and turns on a couple of actuator endpoints:

```yaml
server:
  port: 8080
spring:
  application:
    name: app-web
  cloud:
    function:
      web:
        path: ""       # functions served from the root: POST /enrichOrder
      # `definition` is only needed if you want ONE default endpoint at "/".
      # Composition is available ad hoc via a comma in the path — no config.
management:
  endpoints:
    web:
      exposure:
        include: health, info, functions, mappings   # /actuator/functions lists the catalog
```

### Headers and content types over HTTP

Because functions are transport-neutral, headers and content negotiation just work:

```bash
# JSON in, JSON out (the default).
curl -X POST localhost:8080/enrichOrder -H 'Content-Type: application/json' \
  -d '{"orderId":"ord-1","customerId":"cust-alice","amount":199.99,"currency":"USD","itemCount":2}'

# CSV in (thanks to our custom converter), JSON out.
curl -X POST localhost:8080/enrichOrder -H 'Content-Type: text/csv' -d 'ord-9,cust-alice,199.99,USD,3'

# A header the function reads via Message<Order>; it echoes headers back on the response.
curl -i -X POST localhost:8080/decideWithHeaders -H 'Content-Type: application/json' \
  -H 'channel: mobile-app' \
  -d '{"orderId":"ord-1","customerId":"cust-alice","amount":199.99,"currency":"USD","itemCount":2}'

# Header-driven routing: express -> fastApprove.
curl -X POST localhost:8080/functionRouter -H 'Content-Type: application/json' \
  -H 'order-channel: express' \
  -d '{"orderId":"ord-x","customerId":"cust-bob","amount":25.00,"currency":"USD","itemCount":1}'
```

## Surface 2: Kafka with Spring Cloud Stream

Now the *same functions* over Kafka. Spring Cloud Stream is built directly on top of Spring Cloud Function — your function beans *are* the stream processors. You don't write listeners; you bind a function to input/output destinations.

```kotlin
// app-stream-kafka/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.cloud:spring-cloud-stream")
    implementation("org.springframework.cloud:spring-cloud-stream-binder-kafka")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-tracing-bridge-brave")  // trace every invocation
}
```

Here the demo makes a deliberate design choice worth calling out. Instead of binding the raw composition string `enrichOrder|validateOrder`, it wraps the two functions in a **single named bean**, `orderPipeline`. This does two things: it gives the binding a clean name (more on why in a second), and it's the natural place to add the *messaging* concern that only makes sense on a broker — a poison-message guard:

```java
@Configuration
public class StreamBindings {

    // No new business logic — just wires the two existing functions-core beans
    // together and adds an input guard. A non-USD order throws, which (with
    // enable-dlq) routes that record to the dead-letter topic instead of
    // blocking the partition. The canonical "poison message" pattern.
    @Bean
    public Function<Order, Decision> orderPipeline(
            @Qualifier("enrichOrder") Function<Order, EnrichedOrder> enrichOrder,
            @Qualifier("validateOrder") Function<EnrichedOrder, Decision> validateOrder) {

        Function<Order, Decision> pipeline = enrichOrder.andThen(validateOrder);
        return order -> {
            if (order.currency() == null || !"USD".equals(order.currency())) {
                throw new IllegalArgumentException("unsupported currency: " + order.currency());
            }
            return pipeline.apply(order);
        };
    }
}
```

The configuration binds `orderPipeline` to Kafka topics. Binding names follow the `<function>-in-0` / `<function>-out-0` convention:

```yaml
spring:
  application:
    name: app-stream-kafka
  kafka:
    bootstrap-servers: localhost:9092   # the Testcontainers test overrides this
  cloud:
    function:
      definition: orderPipeline         # only this function is bound to Kafka
    stream:
      bindings:
        orderPipeline-in-0:
          destination: orders
          group: scf-guide              # a consumer group => durable, DLQ-capable
          consumer:
            max-attempts: 1             # fail fast: no in-memory retries before DLQ
        orderPipeline-out-0:
          destination: decisions
      kafka:
        binder:
          brokers: ${spring.kafka.bootstrap-servers}
        bindings:
          orderPipeline-in-0:
            consumer:
              enable-dlq: true          # poison messages go to a dead-letter topic
              dlq-name: orders-dlq
              auto-commit-on-error: true
management:
  tracing:
    sampling:
      probability: 1.0                  # trace every message for the demo
```

The important observations for someone coming from `@KafkaListener`:

- **Why the named `orderPipeline` bean instead of `enrichOrder|validateOrder`?** You *can* bind a composed definition directly, but the binding name is derived by stripping the pipe — `enrichOrder|validateOrder` becomes binding key `enrichOrdervalidateOrder-in-0`, which is ugly and bites everyone once. Wrapping the composition in a named bean gives you `orderPipeline-in-0`, and a clean home for broker-only concerns like the currency guard.
- **`group` is required for the DLQ.** Dead-letter routing needs a consumer group; without one, `enable-dlq` silently does nothing. This is the single most common Spring Cloud Stream DLQ bug.
- **`max-attempts: 1`** means "no in-memory retries — the first failure goes straight to `orders-dlq`." In production you'd usually retry transient failures with backoff before dead-lettering.
- **Tracing is automatic.** With the Micrometer Brave bridge on the classpath, trace context propagates through Kafka record headers across every hop — no code changes.

For a *much* deeper treatment of the stream side — the two Kafka binders, Kafka Streams, `DltAwareProcessor`, and error handling — see my dedicated [Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams/). Everything there builds on the function model this post describes.

## Surface 3: RSocket — Roll Your Own with the FunctionCatalog

Not every transport has a turnkey Spring Cloud Function adapter. RSocket is a great example: SCF once shipped a `spring-cloud-function-rsocket` adapter, but it was **never released for the GA 5.0.x line** (only `5.0.0` milestones exist on Maven Central). Rather than pin a milestone against GA artifacts, `app-rsocket` demonstrates the pattern you use whenever a turnkey adapter is missing *or* you're on a bespoke transport: **inject the `FunctionCatalog` and invoke functions by name.** Once you've done this, you understand what *every* adapter is doing under the hood.

```kotlin
// app-rsocket/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.boot:spring-boot-starter-rsocket")
}
```

The controller injects the catalog and maps RSocket routes to function lookups — and it lines up cleanly with RSocket's interaction models:

```java
@Controller
public class FunctionRSocketController {

    private final FunctionCatalog catalog;

    public FunctionRSocketController(FunctionCatalog catalog) {
        this.catalog = catalog;
    }

    // request/response: one Order in, its EnrichedOrder out.
    @MessageMapping("orders.enrich")
    public Mono<EnrichedOrder> enrich(Order order) {
        Function<Order, EnrichedOrder> fn = catalog.lookup("enrichOrder");
        return Mono.fromSupplier(() -> fn.apply(order));
    }

    // request/response: the full composed pipeline, Order in, Decision out.
    @MessageMapping("orders.decide")
    public Mono<Decision> decide(Order order) {
        Function<Order, Decision> fn = catalog.lookup("enrichOrder|validateOrder");
        return Mono.fromSupplier(() -> fn.apply(order));
    }

    // request/channel: a stream of Orders in, a stream of Decisions out.
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
- **Still zero changes to `functions-core`.** The same `enrichOrder|validateOrder` composition served over HTTP and Kafka is served here — the RSocket module just reaches it through the same catalog.

## Surface 4: AWS Lambda

Finally, the same functions as a serverless deployment. Spring Cloud Function's AWS adapter provides a generic Lambda handler that bridges the Lambda runtime to your function.

```kotlin
// adapter-aws/build.gradle.kts
dependencies {
    implementation(project(":functions-core"))
    implementation("org.springframework.cloud:spring-cloud-function-adapter-aws")
    implementation("com.amazonaws:aws-lambda-java-core:1.2.3")
}
```

```java
@SpringBootApplication   // com.stevenpg.scf — scanning pulls in every functions-core bean
public class LambdaApplication {
    public static void main(String[] args) {
        SpringApplication.run(LambdaApplication.class, args);
    }
}
```

```properties
# application.properties — pick which function this Lambda exposes.
# The SAME composed pipeline the web, kafka, and rsocket surfaces use.
spring.cloud.function.definition=enrichOrder|validateOrder
```

On AWS you do **not** run `main`. You configure the Lambda's **handler** to Spring Cloud Function's generic invoker:

```
Handler: org.springframework.cloud.function.adapter.aws.FunctionInvoker
```

When Lambda invokes the function, `FunctionInvoker` boots (or reuses) the Spring context, looks up the function named by `spring.cloud.function.definition`, deserializes the event JSON into the input type, runs the function, and serializes the result back out. Your `enrichOrder|validateOrder` composition runs on Lambda with **zero AWS-specific code** in your business logic.

### Testing the Lambda handler in-process

The best part of the AWS adapter for development: you can drive the *exact deployable unit* locally, no AWS account required, by invoking `FunctionInvoker` with input and output streams — which is precisely what the Lambda runtime does.

```java
class LambdaHandlerTest {

    @BeforeEach
    void pointHandlerAtThisApp() {
        // In a real jar, FunctionInvoker finds the app via the manifest Start-Class.
        System.setProperty("MAIN_CLASS", LambdaApplication.class.getName());
    }

    @Test
    void invokesComposedPipelineThroughLambdaHandler() throws Exception {
        // The same class AWS configures as the handler; the arg selects the function.
        FunctionInvoker invoker = new FunctionInvoker("enrichOrder|validateOrder");

        String order = "{\"orderId\":\"ord-1\",\"customerId\":\"cust-alice\","
                + "\"amount\":199.99,\"currency\":\"USD\",\"itemCount\":2}";

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        invoker.handleRequest(
                new ByteArrayInputStream(order.getBytes(StandardCharsets.UTF_8)),
                out,
                null);  // Lambda Context — unused by the function

        JsonNode decision = new ObjectMapper().readTree(out.toByteArray());
        assertThat(decision.get("outcome").asText()).isIn("APPROVED", "REJECTED", "REVIEW");
    }
}
```

This is a genuinely underrated capability — you get high confidence that the thing you deploy works, without any of the pain of a real Lambda round-trip in your test loop.

### Shipping it for real

The demo is local-only, but the path to a real deployment is short. Two things to know:

- **Shade the app into a single jar.** Lambda can't read Spring Boot's nested-jar layout, so package an "uber" jar (e.g. with the Shadow plugin) for the custom-runtime layout.
- **Deploy with SAM.** A minimal `template.yaml` points the handler at `FunctionInvoker` and sets the function via an env var:

  ```yaml
  Resources:
    OrderFunction:
      Type: AWS::Serverless::Function
      Properties:
        Handler: org.springframework.cloud.function.adapter.aws.FunctionInvoker
        Runtime: java21
        MemorySize: 512
        Environment:
          Variables:
            SPRING_CLOUD_FUNCTION_DEFINITION: "enrichOrder|validateOrder"
  ```

  ```bash
  sam local invoke OrderFunction -e event.json
  ```

## Testing Functions Across Every Surface

Because your logic is plain functions, the *core* tests need no running server — they exercise the beans through the `FunctionCatalog` exactly as every adapter will, using an `ApplicationContextRunner`:

```java
class FunctionCatalogTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(ContextFunctionCatalogAutoConfiguration.class))
            .withUserConfiguration(PipelineFunctions.class, ReactiveFunctions.class,
                    MessageFunctions.class, TupleFunctions.class, RoutingConfig.class,
                    ConverterConfig.class, DynamicFunctionRegistrar.class);

    @Test
    void composesEnrichAndValidate() {
        runner.run(context -> {
            FunctionCatalog catalog = context.getBean(FunctionCatalog.class);
            Function<Order, Decision> pipeline = catalog.lookup("enrichOrder|validateOrder");

            Decision decision = pipeline.apply(
                    new Order("ord-1", "cust-alice", new BigDecimal("199.99"), "USD", 2));
            assertThat(decision.outcome())
                    .isIn(Decision.APPROVED, Decision.REJECTED, Decision.REVIEW);
        });
    }
}
```

That one test class covers composition, `Message` headers (`decideWithHeaders`), the reactive pipeline (via `StepVerifier`), the multi-output tuple, and the runtime-registered function — all through the catalog. Then each surface module proves the functions behave *identically* on the wire:

- **`app-web`** — `WebTestClient` posts to `/enrichOrder`, `/enrichOrder,validateOrder`, and CSV/router variants, asserting the same decisions.
- **`app-stream-kafka`** — Testcontainers spins up a real Kafka broker, publishes to `orders`, and asserts decisions land on `decisions` (and a poison EUR order on `orders-dlq`). It **skips itself** (via `@EnabledIf("dockerAvailable")`) when Docker isn't present, so `./gradlew test` stays green on a laptop without Docker.
- **`app-rsocket`** — a real `RSocketRequester` client hits `orders.enrich`, `orders.decide`, and the streaming `orders.decideStream` route.
- **`adapter-aws`** — the in-process `FunctionInvoker` test shown above.

The through-line: **one set of assertions about business behavior, verified five ways** (the catalog plus four surfaces). When the function is right, every surface is right, because every surface runs the *same function*. For the Testcontainers patterns the Kafka test uses, see the [Ultimate Guide to Testcontainers with Spring Boot](/posts/ultimate-guide-testcontainers-spring-boot/).

## GraalVM Native Image

Spring Cloud Function and GraalVM native images are a natural pair — especially for serverless, where cold-start time is money. A native Lambda starts in tens of milliseconds instead of seconds. The demo *documents* this rather than shipping a native build (which needs a GraalVM toolchain), and the guidance is worth capturing.

Add the native build plugin to an app module and build:

```kotlin
plugins {
    id("org.springframework.boot")
    id("io.spring.dependency-management")
    id("org.graalvm.buildtools.native") version "0.10.3"
}
```

```bash
./gradlew :app-web:nativeCompile
./app-web/build/native/nativeCompile/app-web
```

What you need to know, specific to SCF + native:

- **Plain function beans work out of the box.** SCF's function type introspection is AOT-friendly, so `Supplier`/`Function`/`Consumer` over standard types need no hints.
- **Register your POJOs for reflection** if you rely on runtime type inspection — custom converters and reflective payloads may need `@RegisterReflectionForBinding(Order.class)` (and friends) on the application class:

  ```java
  @SpringBootApplication
  @RegisterReflectionForBinding({Order.class, EnrichedOrder.class, Decision.class})
  public class WebApplication { /* ... */ }
  ```

- **Composition and routing resolve at runtime by name.** Keep the function definitions in configuration so AOT can see them, and prefer an explicit `spring.cloud.function.definition` over purely dynamic lookups where cold-start matters.
- **The AWS adapter has a dedicated native/custom-runtime path.** Combine the Shadow-jar guidance above with GraalVM's `native-image` for the smallest Lambda cold starts.

If native images are your main interest, my [Go vs Spring Boot native benchmark](/posts/go-vs-spring-boot-native-benchmark/) has real cold-start and memory numbers.

## Common Pitfalls and Troubleshooting

### "No such function" / function not found

**Cause:** ambiguity. You have multiple function beans and a surface doesn't know which to bind.

**Fix:** be explicit with `spring.cloud.function.definition`. With exactly one function bean it's inferred; with two or more, name it (or use an adapter like `spring-cloud-function-web` that exposes them all by name).

### The pipe disappears in stream binding names

**Cause:** you bound a composed definition (`enrichOrder|validateOrder`) and wrote the binding key with the pipe. Spring Cloud Stream strips the `|` when deriving the binding name, so the actual key is `enrichOrdervalidateOrder-in-0`.

**Fix:** either use the stripped name, or do what the demo does — wrap the composition in a **named `@Bean`** (`orderPipeline`) and bind `orderPipeline-in-0`. The named bean is also the right home for broker-only concerns like a poison-message guard.

### DLQ silently does nothing

**Cause:** no consumer `group`. Dead-letter routing requires a consumer group.

**Fix:** always set `group` on the input binding when you want a DLQ (the demo uses `group: scf-guide`).

### Types don't line up in a composition

**Cause:** `a`'s output type and `b`'s input type don't match and there's no converter to bridge them.

**Fix:** make the types align, or register a `MessageConverter` for the content type in play. Remember off-the-wire input is bytes/`String` and relies on the declared `Content-Type` to convert.

### A `Supplier` only fires once (or never) in a stream

**Cause:** an imperative `Supplier<T>` is *polled*; without a poller it uses the default interval. A reactive `Supplier<Flux<T>>` (like `liveOrders`) is subscribed once and runs continuously.

**Fix:** set `spring.cloud.stream.poller.fixed-delay` for imperative suppliers, or return a `Flux` for a continuous source.

### Dynamic function registered but "untyped"

**Cause:** you didn't set `.type(...)` on the `FunctionRegistration`, so generics were erased and the framework can't wire up converters.

**Fix:** always supply the type via `ResolvableType.forClassWithGenerics(...).getType()`.

## Taking It to Production

The demo is intentionally simplified. Before you ship functions in anger:

- **Pin exactly one function per Lambda.** A Lambda should do one thing; set `spring.cloud.function.definition` to a single function or composition and keep the deployable focused.
- **Configure real retry before the DLQ.** `max-attempts: 1` (straight to DLQ) is a demo choice. In production, retry transient failures with backoff and only dead-letter what's genuinely poisoned.
- **Guard the web surface.** `spring-cloud-function-web` exposes *every* function by name. Don't accidentally expose an internal function to the internet — scope what's on the classpath and put the endpoints behind auth.
- **Watch the composition types at the edges.** The wire always speaks bytes; be deliberate about `Content-Type` so the right converter runs.
- **Go native for serverless.** The cold-start improvement from a GraalVM native Lambda is the difference between "usable" and "painful" for latency-sensitive event handlers. Budget the build time and test the native binary.
- **Propagate tracing everywhere.** The Micrometer bridge gives you a trace across HTTP, Kafka, and RSocket hops for free — wire it to a real collector so a single order's journey across surfaces is one trace.
- **Keep `functions-core` free of transport dependencies.** The entire value proposition collapses the moment your business module imports a web or Kafka type. In the demo, `functions-core` depends only on `spring-cloud-function-context`, `reactor-core`, and `jackson-databind` — enforce a boundary like that (a module split or an ArchUnit test) so the functions stay portable.

## Wrapping Up

Spring Cloud Function asks you to make one shift in how you think about a Spring application: **the unit of code is a function, not a controller or a listener.** Once you make that shift, an enormous amount of accidental complexity falls away. Your business logic becomes plain `java.util.function` beans you can unit test with no framework at all. Exposing them over HTTP, Kafka, RSocket, or AWS Lambda stops being a rewrite and becomes a matter of adding a dependency and a few lines of config. Composition, routing, content negotiation, and reactive streaming are available to every surface, because every surface talks to the same `FunctionCatalog`.

The demo proves the thesis the hard way: one `functions-core` module, four surfaces, and integration tests that assert the *same* business behavior five different ways — without the functions ever knowing which transport called them. That's the promise, and it holds.

If you take one thing away: keep your `functions-core` pure. No `@RestController`, no `@KafkaListener`, no AWS types. The moment your functions know how they're being invoked, you've lost the portability that makes this worth doing. Guard that boundary and Spring Cloud Function will let you deploy the same logic anywhere the business needs it next.

The full demo repository used throughout this post — `functions-core` plus the `app-web`, `app-stream-kafka`, `app-rsocket`, and `adapter-aws` modules, with tests covering every surface — is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-cloud-function-ultimate-guide). The `scripts/` directory has `run-demo.sh` (builds everything and starts Kafka via Docker Compose), `demo-requests.sh` (exercises every feature end to end, labeled), and `stop-demo.sh`, so you can watch one set of functions answer over four transports in a couple of commands.

If you found this useful, the [Ultimate Guide to Spring Cloud Streams](/posts/ultimate-guide-spring-cloud-streams/) goes much deeper on the Kafka surface, the [Ultimate Guide to Testcontainers with Spring Boot](/posts/ultimate-guide-testcontainers-spring-boot/) covers the integration-testing patterns used here, and the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/) covers the platform everything in this post runs on.
