---
author: StevenPG
pubDatetime: 2025-02-07T12:00:00.000Z
title: Spring Cloud Stream's Record Recoverable Processor
slug: spring-cloud-stream-record-recoverable-processor
featured: true
ogImage: /assets/9c3ccd7a-9f7d-496e-be89-1fdb32628163.png
tags:
  - software
  - spring boot
  - java
  - kafka
description: An example using the new RecordRecoverableProcessor class in Spring Cloud Streams for highly configurable error handling.
---

# Spring Cloud Stream's Record Recoverable Processor

## Table of Contents

[[toc]]

## The Old Way (and its Pain Points)

In the past, when you had an error in your Spring Cloud Stream processor, often the go-to solution was to configure a
Dead Letter Queue. The idea is simple: if a message can't be processed after a few retries, shunt it off to a separate
queue (the DLQ) for later investigation.

Unfortunately, DLQs in Spring Cloud Streams Kafka Streams binder are limited to deserialization. Once the message enters
your defined stream there's no configurable DLQ capability, it must be manually written.

Why am I writing this post? Because I requested this feature and wrote the examples!

https://github.com/spring-cloud/spring-cloud-stream/issues/2779

Kudos to [Soby Chako][soby-chako]

Documentation on the [Spring Cloud Stream Kafka Streams Binder][kafka-streams-binder-documentation]

And while DLQs are useful for capturing messages that are truly unprocessable, they can be unsophisticated for
everyday errors. What if you want to do something *specific* when a particular type of
error occurs? DLQs are great for "fire and forget" error handling – the message is bad, let's just put it aside. But
often, we need more control.

Let's think about a scenario. Imagine you have a processor that enriches data from an external service. If that service
is temporarily unavailable, your processor will fail. You might want to retry, log the error, or even send it to a
different topic for specific error handling.

## Enter RecordRecoverableProcessor

This is where the `RecordRecoverableProcessor` comes in!  Introduced in Spring Cloud
Streams version 4.1.0, this class gives you a much more granular and configurable way to deal with errors directly within your
processor. Instead of just letting errors bubble up, crashing the stream or relying on framework-level retry 
and DLQ mechanisms, you can now define exactly what happens when an error occurs *inside* your processing logic.

So, what happens when an error occurs in a traditional processor versus one using `RecordRecoverableProcessor`?

**Traditional Processor (Error):**

1. Error occurs in your `Function` or `Consumer`.
2. Spring Cloud Stream's error handling kicks in (retry, DLQ, etc., based on your configuration). Potentially crashing your stream!
3. Limited control over what happens *specifically* when an error occurs in *your code*.

**`RecordRecoverableProcessor` (Error):**

1. Error occurs in the `apply` method of your `Function`.
2. The `RecordRecoverableProcessor` catches the error.
3. **Your custom error handling logic (provided as a `BiConsumer`) is executed.**  This `BiConsumer` gets access to both
   the errored record *and* the exception!
4. You can decide what to do: log the error, send it to an error topic, apply custom recovery logic, *and more*.

The beauty of `RecordRecoverableProcessor` is that it puts *you* in the driver's seat for error handling within your
processing logic.

Check out the [Spring Cloud Stream Samples][scs-samples] under the `kafka-recoverable`
sub-project if you want to go straight to the published Spring samples.

## No More Clunky Workarounds

Before `RecordRecoverableProcessor`, achieving this level of fine-grained control often involved writing somewhat clunky
and less-than-elegant error handling logic directly within your processing functions. You might have seen (or even
written!) code that tried to catch exceptions, manually send messages to error topics using `StreamBridge`, and
generally make the core processing logic harder to read and maintain.

`RecordRecoverableProcessor` sidesteps these older, less ideal approaches. It provides a clean separation of
concerns: your `Function` focuses on the core processing, and your `BiConsumer` handles the errors, but *right there,
connected to your processor*.

## The Code Example!

Let's get into a practical example. We'll use a Spring Boot application with Spring Cloud Stream and Kafka (because
that's a super common setup). Imagine we're building a system that processes `PaymentEvent` messages. Sometimes, 
this payment might fail (maybe a service is down, or the data is temporarily unavailable).

Here's how we can use `RecordRecoverableProcessor` to handle these potential errors gracefully.

First, let's define a `BiConsumer` that will handle our errors. A good starting point is to send the errored record and
the exception to a dedicated "error topic". This allows us to inspect these errors later and potentially reprocess them
or take other actions.

```java
public class BiConsumerErrorHandlingSupplier<K, V> implements Supplier<BiConsumer<Record<K, V>, Exception>> {
    private final StreamBridge streamBridge;
    private final String errorTopicName;

    public BiConsumerErrorHandlingSupplier(StreamBridge streamBridge, String errorTopicName) {
        this.streamBridge = streamBridge;
        this.errorTopicName = errorTopicName;
    }

    @Override
    public BiConsumer<Record<K, V>, Exception> get() {
        return (erroredRecord, ex) -> streamBridge.send(errorTopicName, new ErrorRecord(erroredRecord.key(), erroredRecord.value(), ex));
    }
}
```

This `BiConsumerErrorHandlingSupplier` is a `Supplier` of a `BiConsumer`. Why a Supplier? This is a common pattern in
Spring to allow for lazy initialization and dependency injection. In this case, it makes it easy to inject
the `StreamBridge` and configure the `errorTopicName`. The `BiConsumer` itself takes two arguments: the `Record` that
caused the error and the `Exception` itself. Inside the `BiConsumer`, we're using `StreamBridge` (a handy tool in Spring
Cloud Stream for sending messages programmatically) to send an `ErrorRecord` (you'd need to define this class to hold
the relevant error information) to our `errorTopicName`.

Now, let's look at our processor, which we'll call `PaymentsProcessor`.

```java

@Component
@AllArgsConstructor
public class PaymentsProcessor implements Function<Record<String, PaymentEvent>, Record<String, Object>> {
    private final StreamBridge streamBridge;

    @Override
    public Record<String, Object> apply(Record<String, PaymentEvent> stringPaymentEventRecord) {
        // ... your core processing logic here that might throw an exception ...
        throw new RuntimeException("Error retrieving payment data!");
    }

    public RecordRecoverableProcessor<String, PaymentEvent, String, Object> get() {
        return new RecordRecoverableProcessor<>(this,
                new BiConsumerErrorHandlingSupplier<String, PaymentEvent>(streamBridge, "error-handler").get());
    }
}
```

Notice that `PaymentsProcessor` *itself* is still a regular `Function`. The magic happens in the `get()`
method. This method returns a `RecordRecoverableProcessor`. We create a new instance of `RecordRecoverableProcessor`,
passing two things:

1. `this`:  The instance of our `PaymentsProcessor` (which is the `Function` that contains our core
   processing logic).
2. `new BiConsumerErrorHandlingSupplier<String, PaymentEvent>(streamBridge, "error-handler").get()`:  This is how we
   provide our custom error handling `BiConsumer`. We're using our `BiConsumerErrorHandlingSupplier` to create and
   configure the `BiConsumer` that will be executed when errors occur in the `apply` method.

Finally, let's see how to wire this up in our Spring Cloud Stream configuration:

```java

@Bean
public Consumer<KStream<String, PaymentEvent>> paymentConsumer(PaymentsProcessor paymentsProcessor) {
    return input -> input.process(() -> paymentsProcessor.get());
            // .process(paymentsProcessor::get) also works!
}
```

Key things to note in this `@Bean` definition:

* We're using a `Consumer<KStream<String, PaymentEvent>>` because we're processing a stream of `PaymentEvent`
  messages.
* **`.process(() -> paymentsProcessor.get())`**:  This is crucial!  Instead of just using
  `.process(paymentsProcessor)`, we are using `.process(() -> paymentsProcessor.get())`.
  This is how we tell Spring Cloud Stream to use our `RecordRecoverableProcessor` as the actual processor. We're calling
  the `get()` method to get the `RecordRecoverableProcessor` instance.

## Understanding `Function` and `BiConsumer` in this Context

Let's quickly recap the roles of `Function` and `BiConsumer` in `RecordRecoverableProcessor`:

* **`Function<Record<K, V>, Record<KR, VR>>` (or `Consumer<Record<K, V>>`, `BiConsumer<Record<K, V>, Record<KR, VR>>`,
  etc.):** This is your *core processing logic*. It's what you want to do with each message when everything goes right.
  It's the heart of your stream processing application. In our example, it's the `PaymentsProcessor`.
* **`BiConsumer<Record<K, V>, Exception>`:** This is your *error handling logic*. It's executed *only* when an exception
  occurs within your `Function`. It gets access to the record that caused the error and the exception itself. You define
  what should happen in error scenarios. In our example, it's the `BiConsumer` created by
  `BiConsumerErrorHandlingSupplier`.

`RecordRecoverableProcessor` acts as the intermediary, neatly connecting your processing logic (`Function`) and your
error handling logic (`BiConsumer`).

## Full Example (Putting It All Together)

To make this completely runnable , let's flesh out a bit more code. You'll need to define
`PaymentEvent` and `ErrorRecord` classes (these can be simple POJOs). You'll also need to configure your Kafka
bindings and potentially an error topic.

**Example PaymentEvent**

```java
public class PaymentEvent {
    private String paymentId;
    private String payload;
    // Getters, setters, constructors...
}
```

**Example ErrorRecord**

```java
public class ErrorRecord<K, V> {
    private final K key;
    private final V value;
    private final Exception exception;

    public ErrorRecord(K key, V value, Exception exception) {
        this.key = key;
        this.value = value;
        this.exception = exception;
    }
}
```

**Processor**

```java
@Component
public class PaymentsProcessor implements Function<Record<String, PaymentEvent>, Record<String, Object>>
{
    private final StreamBridge streamBridge;
    // You can inject the error topic binding or topic name into the processor instead of hardcoding
    
    public PaymentsProcessor(StreamBridge streamBridge) {
        this.streamBridge = streamBridge;
    }

    @Override
    public Record<String, Object> apply(Record<String, PaymentEvent> paymentEventRecord) {
        // your business logic!
        return null;
    }

    public RecordRecoverableProcessor<String, PaymentEvent, String, Object> get() {
        return new RecordRecoverableProcessor<>(this,
            new BiConsumerErrorHandlingSupplier<String, PaymentEvent>(streamBridge, "error-handler").get());
    }
}
```

**Spring Boot Application**

```java

@SpringBootApplication
public class RecordRecoverableProcessorExampleApplication {

    public static void main(String[] args) {
        SpringApplication.run(RecordRecoverableProcessorExampleApplication.class, args);
    }

    @Bean
    public Consumer<KStream<String, PaymentEvent>> paymentConsumer(PaymentsProcessor paymentsProcessor) {
        return input -> input
                .process(() -> paymentsProcessor.get());
    }
}
```

**`application.yml` (or `application.properties`) - Example Kafka Bindings:**

```yaml
spring:
  cloud:
    stream:
      function:
        definition: paymentConsumer-in-0
      bindings:
        paymentConsumer-in-0:
          destination: payment-events-topic
          group: payment-group
      kafka:
        binder:
          brokers: localhost:9092
```

## End

If you've been struggling with error handling in Spring Cloud Stream, or if you're looking for a more elegant
alternative to just relying on DLQs, definitely explore `RecordRecoverableProcessor`.

[soby-chako]: https://github.com/sobychacko
[kafka-streams-binder-documentation]: https://cloud.spring.io/spring-cloud-stream-binder-kafka/spring-cloud-stream-binder-kafka.html#_kafka_streams_binder
[scs-samples]: https://github.com/spring-cloud/spring-cloud-stream-samples
