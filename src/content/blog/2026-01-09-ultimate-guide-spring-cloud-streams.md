---
author: StevenPG
pubDatetime: 2026-01-09T12:00:00.000Z
title: "The Ultimate Guide to Spring Cloud Streams"
slug: ultimate-guide-spring-cloud-streams
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - spring boot
  - java
  - kafka
  - kafka-streams
  - spring-cloud
description: A comprehensive guide covering every aspect of Spring Cloud Streams - from functional programming models to multiple binders, error handling, and beyond.
---

# The Ultimate Guide to Spring Cloud Streams

## Table of Contents

[[toc]]

## Introduction

Spring Cloud Stream documentation can be sparse and scattered. You'll find bits and pieces across different guides, Stack Overflow answers, and GitHub issues. This guide aims to consolidate everything you need to know about Spring Cloud Streams into one comprehensive resource.

Whether you're trying to understand the difference between the Kafka binder and Kafka Streams binder, figure out why your bindings aren't connecting, or implement proper error handling with dead letter queues, this guide has you covered.

### A Quick Kafka Refresher

Before diving in, let's ensure we're on the same page with Kafka basics. Kafka organizes messages into **topics**, which are split into **partitions** for parallel processing. **Consumer groups** allow multiple instances of your application to share the workload - each partition is consumed by exactly one consumer in a group. **Producers** write messages to topics, and **consumers** read from them. If you need a deeper Kafka primer, the official [Kafka documentation](https://kafka.apache.org/documentation/) is excellent.

## Understanding the Two Binders: Kafka vs Kafka Streams

This is where most confusion begins. Spring Cloud Stream offers **two different Kafka binders**, and understanding when to use each is critical.

### Message Channel Binder (spring-cloud-stream-binder-kafka)

The standard Kafka binder uses Spring's message channel abstraction. It's built on top of Spring Kafka and treats Kafka like any other message broker.

```xml
<!-- Maven dependency for the standard Kafka binder -->
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-stream-binder-kafka</artifactId>
</dependency>
```

**Characteristics:**
- Message-at-a-time processing
- Works with `Consumer<T>`, `Supplier<T>`, `Function<T, R>`
- Built-in DLQ support via configuration
- Simpler mental model - messages in, messages out

### Kafka Streams Binder (spring-cloud-stream-binder-kafka-streams)

The Kafka Streams binder leverages the full power of the Kafka Streams DSL. It's a completely different paradigm.

```xml
<!-- Maven dependency for the Kafka Streams binder -->
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-stream-binder-kafka-streams</artifactId>
</dependency>
```

**Characteristics:**
- Stream processing with `KStream`, `KTable`, `GlobalKTable`
- Stateful operations (joins, aggregations, windowing)
- Exactly-once semantics
- Interactive queries for state store access
- More complex but far more powerful

### When to Use Which

| Use Case | Recommended Binder |
|----------|-------------------|
| Simple consume/produce patterns | Kafka Binder |
| Message transformation (map one message to one message) | Either works |
| Stream joins (combining multiple topics) | Kafka Streams |
| Aggregations and windowing | Kafka Streams |
| Stateful processing with local state | Kafka Streams |
| Need to query application state | Kafka Streams |
| Integration with other brokers (RabbitMQ, etc.) | Kafka Binder |
| Existing Spring Integration knowledge | Kafka Binder |

**Rule of thumb:** Start with the standard Kafka binder. Move to Kafka Streams when you need stream processing features like joins, aggregations, or stateful operations.

## The Evolution: Annotations to Functions

### The Legacy Annotation Approach

If you've seen older Spring Cloud Stream code, you might have encountered annotations like these:

```java
// DEPRECATED - Don't use in new code!
@EnableBinding(Sink.class)
public class MessageConsumer {

    @StreamListener(Sink.INPUT)
    public void handle(String message) {
        // process message
    }
}
```

These annotations (`@EnableBinding`, `@StreamListener`, `@Input`, `@Output`, `@Sink`, `@Source`) were deprecated in Spring Cloud Stream 3.1 and removed in 4.0.

### Why Annotations Were Deprecated

The annotation-based model had several problems:

1. **Tight coupling** to Spring Cloud Stream abstractions
2. **Testing difficulties** - hard to unit test without the full framework
3. **Inconsistency** with Spring's broader move toward functional programming
4. **Maintenance burden** - two parallel programming models to support

The functional model aligns with Spring's direction (Spring WebFlux, Spring Cloud Function) and results in cleaner, more testable code.

## Functional Programming Model Deep Dive

The functional model uses three core Java functional interfaces: `Supplier`, `Consumer`, and `Function`. Spring Cloud Stream automatically binds these to message channels.

### Supplier - Producing Messages

A `Supplier<T>` produces messages. It's typically used for scheduled message generation or as an entry point for data.

```java
@Configuration
public class ProducerConfig {

    // This Supplier will be polled by Spring Cloud Stream
    // By default, it polls every second (configurable)
    // The bean name is important for the yaml configuration
    @Bean
    public Supplier<String> produceGreeting() {
        return () -> {
            // Generate a message to send
            // This runs on a schedule (default: every 1 second)
            return "Hello at " + Instant.now();
        };
    }
}
```

```yaml
# Configure the supplier's output binding
spring:
  cloud:
    stream:
      bindings:
        # Naming convention: beanName-out-0
        produceGreeting-out-0:
          destination: greetings-topic
      # Control polling interval (default 1000ms)
      poller:
        fixed-delay: 5000
```

For reactive streams or event-driven production, use `Supplier<Flux<T>>`:

```java
@Bean
public Supplier<Flux<String>> reactiveProducer() {
    // Emits a message every 5 seconds using reactive streams
    return () -> Flux.interval(Duration.ofSeconds(5))
            .map(i -> "Reactive message " + i);
}
```

### Consumer - Consuming Messages

A `Consumer<T>` receives and processes messages without producing output.

```java
@Configuration
public class ConsumerConfig {

    // Simple consumer - receives messages from configured topic
    @Bean
    public Consumer<String> processMessage() {
        return message -> {
            // Process the incoming message
            // No return value - this is a sink
            System.out.println("Received: " + message);
        };
    }

    // Consumer with full Message access (headers, metadata)
    @Bean
    public Consumer<Message<String>> processWithHeaders() {
        return message -> {
            // Access message payload
            String payload = message.getPayload();

            // Access headers for metadata
            MessageHeaders headers = message.getHeaders();
            String correlationId = headers.get("correlationId", String.class);

            System.out.println("Processing " + payload + " with correlation: " + correlationId);
        };
    }
}
```

```yaml
spring:
  cloud:
    stream:
      bindings:
        # Naming convention: beanName-in-0
        processMessage-in-0:
          destination: incoming-topic
          group: my-consumer-group
        processWithHeaders-in-0:
          destination: another-topic
          group: my-consumer-group
```

### Function - Processing and Transforming

A `Function<T, R>` consumes a message and produces a transformed output.

```java
@Configuration
public class ProcessorConfig {

    // Transform incoming Order to ProcessedOrder
    // The function excepts a message that will serialize to Order and will output
    // a message that will serialize to ProcessedOrder, mapped to the beanName configuration
    @Bean
    public Function<Order, ProcessedOrder> processOrder() {
        return order -> {
            // Perform business logic transformation
            ProcessedOrder processed = new ProcessedOrder();
            processed.setOrderId(order.getId());
            processed.setTotal(calculateTotal(order));
            processed.setProcessedAt(Instant.now());
            return processed;
        };
    }

    // Return null to filter/skip messages
    @Bean
    public Function<Event, Event> filterEvents() {
        return event -> {
            // Return null to drop the message (won't be sent downstream)
            if (event.getType().equals("IGNORED")) {
                return null;
            }
            return event;
        };
    }

    // One-to-many: return Flux to emit multiple messages
    @Bean
    public Function<Order, Flux<OrderLine>> explodeOrder() {
        return order -> {
            // Convert one order into multiple order line messages
            return Flux.fromIterable(order.getLines());
        };
    }
}
```

```yaml
spring:
  cloud:
    stream:
      bindings:
        # Function has both input and output
        processOrder-in-0:
          destination: orders-topic
          group: order-processor
        processOrder-out-0:
          destination: processed-orders-topic
```

### Composing Multiple Functions

Spring Cloud Stream can compose functions into pipelines using the `spring.cloud.function.definition` property.

```java
@Configuration
public class FunctionComposition {

    // Step 1: Parse raw JSON string to Order object
    @Bean
    public Function<String, Order> parseOrder() {
        return json -> objectMapper.readValue(json, Order.class);
    }

    // Step 2: Validate the order
    @Bean
    public Function<Order, Order> validateOrder() {
        return order -> {
            if (order.getItems().isEmpty()) {
                throw new ValidationException("Order must have items");
            }
            return order;
        };
    }

    // Step 3: Enrich with pricing
    @Bean
    public Function<Order, EnrichedOrder> enrichOrder() {
        return order -> {
            EnrichedOrder enriched = new EnrichedOrder(order);
            enriched.setTotalPrice(pricingService.calculate(order));
            return enriched;
        };
    }
}
```

```yaml
spring:
  cloud:
    stream:
      function:
        # Compose functions with | (pipe) operator
        # Messages flow: parseOrder -> validateOrder -> enrichOrder
        definition: parseOrder|validateOrder|enrichOrder
      bindings:
        # Composed function uses first function's input name
        parseOrder|validateOrder|enrichOrder-in-0:
          destination: raw-orders
        # And last function's output name
        parseOrder|validateOrder|enrichOrder-out-0:
          destination: enriched-orders
```

### Defining Multiple Independent Functions

When you have multiple functions that should run independently (not as a pipeline), use the semicolon `;` delimiter. This is common in microservices that handle multiple streams within the same application.

```java
@Configuration
public class MultiStreamConfig {

    // Stream 1: Process incoming orders and produce order confirmations
    @Bean
    public Function<Order, OrderConfirmation> processOrders() {
        return order -> {
            // Validate and process the order
            OrderConfirmation confirmation = orderService.process(order);
            return confirmation;
        };
    }

    // Stream 2: Consume inventory updates (no output - just updates local cache)
    @Bean
    public Consumer<InventoryUpdate> updateInventory() {
        return update -> {
            // Update local inventory cache for order validation
            inventoryCache.update(update.getProductId(), update.getQuantity());
        };
    }

    // Stream 3: Send notifications based on notification requests
    @Bean
    public Consumer<NotificationRequest> sendNotifications() {
        return request -> {
            // Send email, SMS, or push notification
            notificationService.send(request);
        };
    }
}
```

```yaml
spring:
  cloud:
    stream:
      function:
        # Semicolon separates independent functions
        # Each function gets its own input/output bindings
        definition: processOrders;updateInventory;sendNotifications
      bindings:
        # Stream 1: Order processing
        processOrders-in-0:
          destination: incoming-orders
          group: order-service
        processOrders-out-0:
          destination: order-confirmations

        # Stream 2: Inventory updates (Consumer - no output binding)
        updateInventory-in-0:
          destination: inventory-updates
          group: order-service

        # Stream 3: Notifications (Consumer - no output binding)
        sendNotifications-in-0:
          destination: notification-requests
          group: order-service
```

**Key differences:**
- `|` (pipe) = composition: functions chain together, output of one feeds into the next
- `;` (semicolon) = independent: each function operates on its own topics separately

You can also combine both - define multiple independent pipelines:

```yaml
spring:
  cloud:
    function:
      # Two independent pipelines running in parallel
      definition: parseOrder|validateOrder|processOrder;receivePayment|reconcilePayment
```

## YAML Configuration Demystified

Spring Cloud Stream configuration can feel overwhelming. Let's break it down systematically.

### Binding Naming Conventions

The naming pattern is: `<functionName>-<direction>-<index>`

- `functionName`: The bean name of your `Consumer`, `Supplier`, or `Function`
- `direction`: `in` for input, `out` for output
- `index`: Starts at 0, increments for multiple inputs/outputs

```yaml
spring:
  cloud:
    stream:
      bindings:
        # Supplier (produces only) - only has output
        mySupplier-out-0:
          destination: output-topic

        # Consumer (consumes only) - only has input
        myConsumer-in-0:
          destination: input-topic

        # Function (both) - has input and output
        myFunction-in-0:
          destination: input-topic
        myFunction-out-0:
          destination: output-topic
```

### Destination, Group, and Core Properties

```yaml
spring:
  cloud:
    stream:
      bindings:
        processOrder-in-0:
          # The Kafka topic name
          destination: orders

          # Consumer group - REQUIRED for DLQ support
          # Also enables load balancing across instances
          group: order-service

          # Content type for serialization
          content-type: application/json

          # Consumer-specific settings
          consumer:
            # How many messages to process concurrently
            concurrency: 3
            # Max attempts before giving up (or sending to DLQ)
            max-attempts: 3
            # Initial backoff for retries
            back-off-initial-interval: 1000
            # Max backoff interval
            back-off-max-interval: 10000

        processOrder-out-0:
          destination: processed-orders

          # Producer-specific settings
          producer:
            # Partition key expression (SpEL)
            partition-key-expression: headers['partitionKey']
            # Number of partitions (if auto-creating topic)
            partition-count: 6
```

### Kafka-Specific Configuration

```yaml
spring:
  cloud:
    stream:
      kafka:
        # Binder-level configuration (applies to all bindings)
        binder:
          brokers: localhost:9092
          # Auto-create topics if they don't exist
          auto-create-topics: true
          # Replication factor for auto-created topics
          replication-factor: 3

        # Binding-specific Kafka configuration
        bindings:
          processOrder-in-0:
            consumer:
              # Start from earliest offset for new consumer groups
              start-offset: earliest
              # Enable DLQ for this binding
              enable-dlq: true
              # Custom DLQ topic name (default: <destination>.DLT)
              dlq-name: orders-dlq
              # Auto-commit settings
              auto-commit-offset: true

          processOrder-out-0:
            producer:
              # Compression type
              compression-type: snappy
              # Sync send (wait for ack)
              sync: false
```

### Kafka Streams-Specific Configuration

```yaml
spring:
  cloud:
    stream:
      kafka:
        streams:
          binder:
            brokers: localhost:9092
            configuration:
              # Application ID (required for Kafka Streams)
              application.id: my-streams-app
              # Default serde for keys
              default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
              # Default serde for values
              default.value.serde: org.springframework.kafka.support.serializer.JsonSerde
              # State store directory
              state.dir: /tmp/kafka-streams
              # Processing guarantee
              processing.guarantee: exactly_once_v2
              # Commit interval
              commit.interval.ms: 1000

          bindings:
            processStream-in-0:
              consumer:
                # Materialized view name for KTable
                materialized-as: order-store
```

## Using Multiple Binders

Spring Cloud Stream can connect to multiple message brokers simultaneously. This is powerful for migration scenarios, bridge applications, or polyglot messaging architectures.

### Defining Multiple Binders

```yaml
spring:
  cloud:
    stream:
      # Define available binders
      binders:
        # First binder: Kafka
        kafka-binder:
          type: kafka
          environment:
            spring:
              cloud:
                stream:
                  kafka:
                    binder:
                      brokers: kafka-server:9092

        # Second binder: RabbitMQ
        rabbit-binder:
          type: rabbit
          environment:
            spring:
              rabbitmq:
                host: rabbitmq-server
                port: 5672
                username: guest
                password: guest
```

### Example 1: Kafka + RabbitMQ

A common pattern is receiving from one broker and sending to another:

```java
@Configuration
public class MultiBrokerConfig {

    // Consume from Kafka, process, produce to RabbitMQ
    @Bean
    public Function<Order, ProcessedOrder> bridgeKafkaToRabbit() {
        return order -> {
            // Transform the order
            ProcessedOrder processed = new ProcessedOrder(order);
            processed.setProcessedAt(Instant.now());
            return processed;
        };
    }
}
```

```yaml
spring:
  cloud:
    stream:
      binders:
        kafka-binder:
          type: kafka
          environment:
            spring.cloud.stream.kafka.binder.brokers: localhost:9092
        rabbit-binder:
          type: rabbit
          environment:
            spring.rabbitmq.host: localhost

      bindings:
        # Input comes from Kafka
        bridgeKafkaToRabbit-in-0:
          destination: orders
          binder: kafka-binder
          group: bridge-consumer

        # Output goes to RabbitMQ
        bridgeKafkaToRabbit-out-0:
          destination: processed-orders
          binder: rabbit-binder
```

### Example 2: Kafka + Kafka Streams Together

You can use both Kafka binders in the same application - the standard binder for simple operations and Kafka Streams for complex processing:

```java
@Configuration
public class MixedBinderConfig {

    // Simple consumer using standard Kafka binder
    // Good for logging, metrics, or simple operations
    @Bean
    public Consumer<AuditEvent> auditLogger() {
        return event -> {
            auditService.log(event);
        };
    }

    // Complex stream processing using Kafka Streams binder
    // Performs aggregation that requires state
    @Bean
    public Function<KStream<String, Order>, KStream<String, OrderSummary>> aggregateOrders() {
        return orders -> orders
                // Group by customer ID
                .groupByKey()
                // Window into 1-hour tumbling windows
                .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofHours(1)))
                // Aggregate order totals
                .aggregate(
                        OrderSummary::new,
                        (key, order, summary) -> summary.add(order),
                        Materialized.as("order-summaries")
                )
                // Convert windowed result back to stream
                .toStream()
                .map((windowedKey, summary) -> KeyValue.pair(windowedKey.key(), summary));
    }
}
```

```yaml
spring:
  cloud:
    stream:
      binders:
        # Standard Kafka binder
        kafka-standard:
          type: kafka
          environment:
            spring.cloud.stream.kafka.binder.brokers: localhost:9092

        # Kafka Streams binder
        kafka-streams:
          type: kstream
          environment:
            spring.cloud.stream.kafka.streams.binder.brokers: localhost:9092
            spring.cloud.stream.kafka.streams.binder.configuration.application.id: mixed-app

      bindings:
        # Simple consumer uses standard binder
        auditLogger-in-0:
          destination: audit-events
          binder: kafka-standard
          group: audit-service

        # Stream processor uses Kafka Streams binder
        aggregateOrders-in-0:
          destination: orders
          binder: kafka-streams
        aggregateOrders-out-0:
          destination: order-summaries
          binder: kafka-streams
```

### Routing Bindings to Specific Binders

When you have multiple binders of the same type (e.g., two Kafka clusters), explicit routing is essential:

```yaml
spring:
  cloud:
    stream:
      binders:
        kafka-cluster-1:
          type: kafka
          environment:
            spring.cloud.stream.kafka.binder.brokers: kafka1.example.com:9092
        kafka-cluster-2:
          type: kafka
          environment:
            spring.cloud.stream.kafka.binder.brokers: kafka2.example.com:9092

      # Set a default binder (optional but recommended)
      default-binder: kafka-cluster-1

      bindings:
        # Uses default binder (kafka-cluster-1)
        localProcessor-in-0:
          destination: local-events

        # Explicitly routes to kafka-cluster-2
        remoteProcessor-in-0:
          destination: remote-events
          binder: kafka-cluster-2
```

## Kafka Streams Specifics

When using the Kafka Streams binder, you gain access to the full Kafka Streams DSL.

### KStream vs KTable vs GlobalKTable

```java
@Configuration
public class KafkaStreamsTypesConfig {

    // KStream: Unbounded stream of records
    // Each record is an independent event
    @Bean
    public Consumer<KStream<String, ClickEvent>> processClickStream() {
        return clicks -> clicks
                .filter((key, click) -> click.getPage() != null)
                .foreach((key, click) -> metrics.recordClick(click));
    }

    // KTable: Changelog stream / materialized view
    // Latest value per key (like a database table)
    @Bean
    public Consumer<KTable<String, UserProfile>> processUserProfiles() {
        return profiles -> profiles
                .toStream()
                .foreach((userId, profile) -> cache.updateProfile(userId, profile));
    }

    // GlobalKTable: Fully replicated table across all instances
    // Use for small reference data (countries, config, etc.)
    // Enables non-key joins
    @Bean
    public BiFunction<KStream<String, Order>, GlobalKTable<String, Product>, KStream<String, EnrichedOrder>>
            enrichOrdersWithProducts() {
        return (orders, products) -> orders
                // Join order stream with product lookup table
                // GlobalKTable allows joining on any field, not just the key
                .join(
                        products,
                        // Select the join key from the order
                        (orderKey, order) -> order.getProductId(),
                        // Combine order with product details
                        (order, product) -> new EnrichedOrder(order, product)
                );
    }
}
```

```yaml
spring:
  cloud:
    stream:
      bindings:
        processClickStream-in-0:
          destination: click-events
        processUserProfiles-in-0:
          destination: user-profiles
        # BiFunction has two inputs
        enrichOrdersWithProducts-in-0:
          destination: orders
        enrichOrdersWithProducts-in-1:
          destination: products
        enrichOrdersWithProducts-out-0:
          destination: enriched-orders
```

### Stateful Operations and State Stores

Kafka Streams maintains local state for operations like aggregations, joins, and windowing.

```java
@Configuration
public class StatefulOperationsConfig {

    // Aggregation with named state store
    @Bean
    public Function<KStream<String, Transaction>, KTable<String, AccountBalance>>
            calculateBalances() {
        return transactions -> transactions
                .groupByKey()
                .aggregate(
                        // Initializer
                        () -> new AccountBalance(BigDecimal.ZERO),
                        // Aggregator
                        (accountId, transaction, balance) -> {
                            if (transaction.getType() == TransactionType.CREDIT) {
                                return balance.add(transaction.getAmount());
                            } else {
                                return balance.subtract(transaction.getAmount());
                            }
                        },
                        // Materialized state store configuration
                        Materialized.<String, AccountBalance, KeyValueStore<Bytes, byte[]>>as("account-balances")
                                .withKeySerde(Serdes.String())
                                .withValueSerde(new JsonSerde<>(AccountBalance.class))
                );
    }

    // Windowed aggregation
    @Bean
    public Function<KStream<String, PageView>, KStream<Windowed<String>, Long>>
            countPageViewsPerMinute() {
        return pageViews -> pageViews
                .groupByKey()
                // 1-minute tumbling windows
                .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(1)))
                // Count events in each window
                .count(Materialized.as("pageview-counts"))
                .toStream();
    }
}
```

### Interactive Queries

Query state stores directly via REST endpoints:

```java
@RestController
@RequiredArgsConstructor
public class BalanceQueryController {

    private final InteractiveQueryService queryService;

    @GetMapping("/balance/{accountId}")
    public AccountBalance getBalance(@PathVariable String accountId) {
        // Get a handle to the state store
        ReadOnlyKeyValueStore<String, AccountBalance> store = queryService
                .getQueryableStore(
                        "account-balances",
                        QueryableStoreTypes.keyValueStore()
                );

        // Query the local state
        AccountBalance balance = store.get(accountId);

        if (balance == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }

        return balance;
    }

    @GetMapping("/balances")
    public List<AccountBalance> getAllBalances() {
        ReadOnlyKeyValueStore<String, AccountBalance> store = queryService
                .getQueryableStore(
                        "account-balances",
                        QueryableStoreTypes.keyValueStore()
                );

        List<AccountBalance> balances = new ArrayList<>();
        try (KeyValueIterator<String, AccountBalance> iterator = store.all()) {
            iterator.forEachRemaining(kv -> balances.add(kv.value));
        }
        return balances;
    }
}
```

## Error Handling and Dead Letter Queues

Error handling differs significantly between the two binders. Understanding these differences is crucial for production systems.

### Kafka Binder: enable-dlq Configuration

The standard Kafka binder has built-in DLQ support via configuration:

```yaml
spring:
  cloud:
    stream:
      bindings:
        processOrder-in-0:
          destination: orders
          group: order-processor
          consumer:
            # Retry 3 times before sending to DLQ
            max-attempts: 3
            back-off-initial-interval: 1000
            back-off-multiplier: 2.0
            back-off-max-interval: 10000

      kafka:
        bindings:
          processOrder-in-0:
            consumer:
              # Enable Dead Letter Queue
              enable-dlq: true
              # Custom DLQ topic name (default: <destination>.DLT)
              dlq-name: orders-dlq
              # Include headers with error info
              dlq-producer-properties:
                configuration:
                  key.serializer: org.apache.kafka.common.serialization.StringSerializer
                  value.serializer: org.apache.kafka.common.serialization.ByteArraySerializer
```

With this configuration, failed messages automatically go to the DLQ after exhausting retries.

### Kafka Streams Binder: The DLQ Gap

The Kafka Streams binder does **not** have built-in DLQ support for processing errors. The `enable-dlq` property only applies to deserialization errors, not exceptions thrown in your processing logic.

```yaml
spring:
  cloud:
    stream:
      kafka:
        streams:
          bindings:
            processStream-in-0:
              consumer:
                # This ONLY handles deserialization errors!
                # It does NOT catch exceptions in your processor
                # Options: logAndContinue, logAndFail, sendToDlq
                deserialization-exception-handler: sendToDlq
```

For processing errors (exceptions thrown in your business logic), you need `DltAwareProcessor` or `RecordRecoverableProcessor`.

### DLTAwareProcessor - Publishing to DLT

`DltAwareProcessor` is the go-to choice when you want failed records sent to a Dead Letter Topic automatically. Both `DltAwareProcessor` and `RecordRecoverableProcessor` were introduced in Spring Cloud Stream 4.1.0 to address the gap in Kafka Streams error handling - I had the opportunity to contribute to the examples and documentation for these features.

```java
@Configuration
@RequiredArgsConstructor
public class DltAwareConfig {

    // DltPublishingContext is auto-configured by the Kafka Streams binder
    // It provides the StreamBridge and necessary infrastructure for DLT publishing
    private final DltPublishingContext dltPublishingContext;

    @Bean
    public Consumer<KStream<String, Order>> processOrdersWithDlt() {
        return input -> input.process(() ->
                // DltAwareProcessor wraps your processing logic
                new DltAwareProcessor<>(
                        // Your processing function
                        record -> {
                            Order order = record.value();

                            // This might throw an exception
                            if (order.getTotal().compareTo(BigDecimal.ZERO) < 0) {
                                throw new ValidationException("Negative order total");
                            }

                            orderService.process(order);

                            // Return null for Consumer-style processing (no output)
                            return null;
                        },
                        // DLT topic name
                        "orders-dlt",
                        // Publishing context (provides StreamBridge internally)
                        dltPublishingContext
                )
        );
    }
}
```

**Important:** When using `DltAwareProcessor`, configure the DLT binding's key serializer properly:

```yaml
spring:
  cloud:
    stream:
      bindings:
        # The DLT topic binding (for StreamBridge)
        orders-dlt:
          destination: orders-dlt
      kafka:
        bindings:
          orders-dlt:
            producer:
              configuration:
                # Must match your key type
                key.serializer: org.apache.kafka.common.serialization.StringSerializer
```

### RecordRecoverableProcessor - Custom Error Handling

When you need full control over error handling (not just DLT publishing), use `RecordRecoverableProcessor`. I wrote about this in detail in my [RecordRecoverableProcessor article](/posts/spring-cloud-stream-record-recoverable-processor), but here's the summary.

```java
@Component
@RequiredArgsConstructor
public class OrderProcessor implements Function<Record<String, Order>, Record<String, ProcessedOrder>> {

    private final StreamBridge streamBridge;
    private final MetricsService metricsService;

    @Override
    public Record<String, ProcessedOrder> apply(Record<String, Order> record) {
        // Your main processing logic
        Order order = record.value();
        ProcessedOrder processed = orderService.process(order);
        return new Record<>(record.key(), processed, record.timestamp());
    }

    // Returns a RecordRecoverableProcessor that wraps this function
    public RecordRecoverableProcessor<String, Order, String, ProcessedOrder> recoverable() {
        return new RecordRecoverableProcessor<>(
                this,  // The Function to wrap
                createErrorHandler()  // BiConsumer for error handling
        );
    }

    private BiConsumer<Record<String, Order>, Exception> createErrorHandler() {
        return (failedRecord, exception) -> {
            // Log the error with full context
            log.error("Failed to process order: {} - Error: {}",
                    failedRecord.key(),
                    exception.getMessage(),
                    exception);

            // Record metrics
            metricsService.incrementFailedOrders(exception.getClass().getSimpleName());

            // Send to error topic with enriched metadata
            ErrorEvent errorEvent = new ErrorEvent(
                    failedRecord.key(),
                    failedRecord.value(),
                    exception.getMessage(),
                    exception.getClass().getName(),
                    Instant.now()
            );

            streamBridge.send("order-errors", errorEvent);

            // Could also: send alerts, update database, trigger compensating action
        };
    }
}

@Configuration
@RequiredArgsConstructor
public class StreamConfig {

    private final OrderProcessor orderProcessor;

    @Bean
    public Consumer<KStream<String, Order>> processOrders() {
        return input -> input
                // Use the recoverable processor
                .process(() -> orderProcessor.recoverable());
    }
}
```

### Choosing Between DLTAwareProcessor and RecordRecoverableProcessor

| Criteria | DLTAwareProcessor | RecordRecoverableProcessor |
|----------|-------------------|---------------------------|
| Primary use case | Send failures to DLT | Custom error handling |
| Complexity | Simpler | More flexible |
| Built-in DLT support | Yes | No (manual via StreamBridge) |
| Custom error logic | No | Full control |
| Metrics/alerting | No | Yes (you implement it) |
| Multiple error destinations | No | Yes |

**Use DLTAwareProcessor when:** You just want failed records in a DLT for later reprocessing.

**Use RecordRecoverableProcessor when:** You need custom error handling logic - metrics, alerts, different error destinations based on exception type, or compensating transactions.

## Testing Spring Cloud Streams

Spring Cloud Stream provides `TestChannelBinder` for testing without a real broker.

### Setting Up Test Dependencies

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-stream-test-binder</artifactId>
    <scope>test</scope>
</dependency>
```

### Using InputDestination and OutputDestination

```java
@SpringBootTest
class OrderProcessorTest {

    // Inject test utilities
    @Autowired
    private InputDestination inputDestination;

    @Autowired
    private OutputDestination outputDestination;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void shouldProcessValidOrder() throws Exception {
        // Arrange - Create test data
        Order order = new Order("order-123", List.of(
                new OrderItem("product-1", 2, new BigDecimal("29.99"))
        ));

        // Act - Send message to input binding
        inputDestination.send(
                MessageBuilder.withPayload(objectMapper.writeValueAsBytes(order))
                        .setHeader("correlationId", "test-correlation")
                        .build(),
                "orders"  // destination name
        );

        // Assert - Receive from output binding
        Message<byte[]> result = outputDestination.receive(
                5000,  // timeout in ms
                "processed-orders"  // destination name
        );

        assertThat(result).isNotNull();
        ProcessedOrder processed = objectMapper.readValue(
                result.getPayload(),
                ProcessedOrder.class
        );
        assertThat(processed.getOrderId()).isEqualTo("order-123");
        assertThat(processed.getStatus()).isEqualTo(OrderStatus.PROCESSED);
    }

    @Test
    void shouldSendFailedOrderToDlq() throws Exception {
        // Arrange - Create invalid order that will fail processing
        Order invalidOrder = new Order("order-456", Collections.emptyList());

        // Act
        inputDestination.send(
                MessageBuilder.withPayload(objectMapper.writeValueAsBytes(invalidOrder))
                        .build(),
                "orders"
        );

        // Assert - Check DLQ received the failed message
        Message<byte[]> dlqMessage = outputDestination.receive(5000, "orders-dlq");

        assertThat(dlqMessage).isNotNull();
        // Verify error headers
        assertThat(dlqMessage.getHeaders().get("x-exception-message"))
                .asString()
                .contains("Order must have items");
    }

    @Test
    void shouldFilterIgnoredEvents() {
        // Arrange
        Event ignoredEvent = new Event("IGNORED", "some data");

        // Act
        inputDestination.send(
                MessageBuilder.withPayload(ignoredEvent).build(),
                "events"
        );

        // Assert - No output should be produced
        Message<byte[]> result = outputDestination.receive(1000, "processed-events");
        assertThat(result).isNull();
    }
}
```

### Testing Kafka Streams Topologies

For Kafka Streams, use `TopologyTestDriver`:

```java
@SpringBootTest
class KafkaStreamsTopologyTest {

    @Autowired
    private StreamsBuilderFactoryBean streamsBuilderFactoryBean;

    private TopologyTestDriver testDriver;
    private TestInputTopic<String, Order> inputTopic;
    private TestOutputTopic<String, OrderSummary> outputTopic;

    @BeforeEach
    void setup() {
        Topology topology = streamsBuilderFactoryBean.getTopology();
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "test");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "dummy:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, JsonSerde.class);

        testDriver = new TopologyTestDriver(topology, props);

        inputTopic = testDriver.createInputTopic(
                "orders",
                new StringSerializer(),
                new JsonSerializer<>()
        );

        outputTopic = testDriver.createOutputTopic(
                "order-summaries",
                new StringDeserializer(),
                new JsonDeserializer<>(OrderSummary.class)
        );
    }

    @AfterEach
    void teardown() {
        testDriver.close();
    }

    @Test
    void shouldAggregateOrdersByCustomer() {
        // Send multiple orders for same customer
        inputTopic.pipeInput("customer-1", new Order("order-1", new BigDecimal("100")));
        inputTopic.pipeInput("customer-1", new Order("order-2", new BigDecimal("50")));

        // Verify aggregation
        List<KeyValue<String, OrderSummary>> results = outputTopic.readKeyValuesToList();

        OrderSummary finalSummary = results.get(results.size() - 1).value;
        assertThat(finalSummary.getTotalAmount()).isEqualByComparingTo(new BigDecimal("150"));
        assertThat(finalSummary.getOrderCount()).isEqualTo(2);
    }
}
```

## Observability and Metrics

Spring Cloud Stream integrates with Micrometer for metrics and supports distributed tracing.

### Enabling Metrics

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    tags:
      application: ${spring.application.name}
    export:
      prometheus:
        enabled: true
```

### Key Metrics to Monitor

```java
@Configuration
public class StreamMetricsConfig {

    // Spring Cloud Stream automatically exposes these metrics:
    // - spring.cloud.stream.binder.kafka.offset (consumer lag)
    // - spring.integration.send (messages sent)
    // - spring.integration.receive (messages received)

    // Add custom metrics
    @Bean
    public MeterRegistryCustomizer<MeterRegistry> metricsCommonTags() {
        return registry -> registry.config()
                .commonTags("service", "order-processor");
    }
}
```

Key metrics to monitor:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `kafka.consumer.records.lag.max` | Consumer lag per partition | > 10000 |
| `kafka.consumer.fetch.manager.records.consumed.rate` | Consumption rate | Sudden drops |
| `spring.integration.channel.errorChannel.send.count` | Error count | Any increase |
| `kafka.streams.process.total` | Records processed | Monitor trends |

### Distributed Tracing

Add Spring Cloud Sleuth (or Micrometer Tracing in newer versions) for trace propagation:

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-brave</artifactId>
</dependency>
<dependency>
    <groupId>io.zipkin.reporter2</groupId>
    <artifactId>zipkin-reporter-brave</artifactId>
</dependency>
```

```yaml
management:
  tracing:
    sampling:
      probability: 1.0
  zipkin:
    tracing:
      endpoint: http://zipkin:9411/api/v2/spans
```

Trace context is automatically propagated through Kafka message headers.

## GraalVM Native Image Support

Spring Cloud Stream supports GraalVM native compilation for faster startup and lower memory usage.

### What Works Out of the Box

- Basic `Consumer`, `Supplier`, `Function` beans
- Standard Kafka binder
- Most YAML configuration

### Adding Native Hints

For custom serializers or complex types, you may need hints:

```java
@Configuration
@ImportRuntimeHints(StreamNativeHints.class)
public class NativeConfig {
}

class StreamNativeHints implements RuntimeHintsRegistrar {

    @Override
    public void registerHints(RuntimeHints hints, ClassLoader classLoader) {
        // Register your domain classes for reflection
        hints.reflection()
                .registerType(Order.class, MemberCategory.values())
                .registerType(ProcessedOrder.class, MemberCategory.values())
                .registerType(ErrorEvent.class, MemberCategory.values());

        // Register serializers if using custom ones
        hints.reflection()
                .registerType(
                        OrderSerializer.class,
                        MemberCategory.INVOKE_DECLARED_CONSTRUCTORS
                );
    }
}
```

### Native Build Configuration

```xml
<plugin>
    <groupId>org.graalvm.buildtools</groupId>
    <artifactId>native-maven-plugin</artifactId>
    <configuration>
        <buildArgs>
            <buildArg>--initialize-at-build-time=org.apache.kafka</buildArg>
        </buildArgs>
    </configuration>
</plugin>
```

### Limitations

- Kafka Streams with interactive queries requires additional configuration
- Some Spring Cloud Stream features may require explicit hints
- Test thoroughly - native image behavior can differ from JVM

## Common Pitfalls and Troubleshooting

### Binding Name Mismatches

**Problem:** Messages aren't being consumed or produced.

```yaml
# WRONG - typo in function name
spring:
  cloud:
    stream:
      bindings:
        proceessOrder-in-0:  # Extra 'e'!
          destination: orders
```

**Solution:** Double-check binding names match your `@Bean` method names exactly.

### Serialization Issues

**Problem:** `SerializationException` or `ClassCastException`.

```java
// WRONG - mismatched types
@Bean
public Consumer<String> processOrder() {  // Expects String
    return order -> {
        // But the topic has JSON objects!
    };
}
```

**Solution:** Match your consumer type to the message format, or configure proper deserializers:

```yaml
spring:
  cloud:
    stream:
      kafka:
        bindings:
          processOrder-in-0:
            consumer:
              configuration:
                value.deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
                spring.json.trusted.packages: com.example.domain
```

### Consumer Group Required for DLQ

**Problem:** DLQ not working despite `enable-dlq: true`.

```yaml
# WRONG - missing group
spring:
  cloud:
    stream:
      bindings:
        processOrder-in-0:
          destination: orders
          # group: is missing!
```

**Solution:** Always specify a consumer group when using DLQ:

```yaml
spring:
  cloud:
    stream:
      bindings:
        processOrder-in-0:
          destination: orders
          group: order-processor  # Required for DLQ!
```

### Function Not Being Invoked

**Problem:** Your function bean exists but never gets called.

**Solution:** Check `spring.cloud.function.definition`:

```yaml
spring:
  cloud:
    function:
      # Explicitly list functions to bind
      # Semicolon-separated for multiple functions
      definition: processOrder;auditLogger;sendNotification
```

If you have multiple function beans, Spring may not know which to bind automatically.

### Kafka Streams Application ID Conflict

**Problem:** Multiple instances fail with "StreamsException: stream-thread...State transition from CREATED to PARTITIONS_ASSIGNED is not allowed."

**Solution:** Use unique application IDs or ensure proper partition assignment:

```yaml
spring:
  cloud:
    stream:
      kafka:
        streams:
          binder:
            configuration:
              # Use unique ID per logical application
              application.id: ${spring.application.name}-streams
              # Or let Spring manage with:
              # application.id: ${spring.application.name}-${random.uuid}
```

## Summary and Quick Reference

### Binder Decision Tree

```
Do you need stream joins, aggregations, or stateful processing?
├── Yes → Use Kafka Streams Binder
└── No → Do you need integration with non-Kafka brokers?
    ├── Yes → Use Standard Kafka Binder
    └── No → Either works, start with Standard Kafka Binder
```

### Configuration Quick Reference

```yaml
spring:
  cloud:
    function:
      definition: myFunction  # Which functions to bind
    stream:
      bindings:
        myFunction-in-0:
          destination: input-topic
          group: my-group
          consumer:
            max-attempts: 3
        myFunction-out-0:
          destination: output-topic
      kafka:
        binder:
          brokers: localhost:9092
        bindings:
          myFunction-in-0:
            consumer:
              enable-dlq: true
```

### Error Handling Quick Reference

| Binder | Error Type | Solution |
|--------|------------|----------|
| Kafka | Processing errors | enable-dlq: true |
| Kafka | Custom handling | ErrorHandler bean |
| Kafka Streams | Deserialization | deserialization-exception-handler: sendtodlq |
| Kafka Streams | Processing errors | DltAwareProcessor or RecordRecoverableProcessor |

### Useful Resources

- [Spring Cloud Stream Reference Documentation](https://docs.spring.io/spring-cloud-stream/docs/current/reference/html/)
- [Spring Cloud Stream Samples](https://github.com/spring-cloud/spring-cloud-stream-samples)
- [My RecordRecoverableProcessor Article](/posts/spring-cloud-stream-record-recoverable-processor)
- [Kafka Streams Documentation](https://kafka.apache.org/documentation/streams/)

---

Spring Cloud Streams is powerful but has a learning curve. Hopefully this guide helps flatten that curve. Start simple with the standard Kafka binder and `Consumer`/`Function` beans. Add complexity only when you need it. And when things go wrong, check your binding names first - it's almost always a typo.

It's taken me a long time to get comfortable using Spring Cloud Streams, and this guide
is what I wish I had when I started, and what I wish I had for a consistent reference.
