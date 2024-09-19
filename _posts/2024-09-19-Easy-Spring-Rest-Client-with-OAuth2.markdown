---
layout: post
title:  "Easy Spring Rest Client w/ OAuth2"
toc: true
date: 2024-09-19 12:00:00 -0500
categories:
- software
- spring boot
- java
---

Structure:

- overview of oauth2

- note about updating on release
- webclient in latest spring boot

- spring security milestone version
- spring boot milestone version

- full example of restclient

# Brief

The purpose of the post is to explain the RecordRecoverableProcessor which is a new addition
to the Spring Cloud Streams library of functions available to the Kafka Streams collection of stream functions.

If you'd like to view the notes here on the RecordRecoverableProcessor, you can simple scroll
down to the "Solution" section, or check out the [Spring Cloud Stream Samples][scs-samples] under the `kafka-recoverable`
sub-project.

## Spring Cloud Streams

[Spring Cloud Stream][spring-cloud-stream-documentation] is a framework for building rich event processing applications
with minimal code and relatively straightforward configurations.

In my professional career, I've used spring cloud streams extensively to create
tons of messaging applications using the supported message processing softwares such as
Kafka, RabbitMq, Solace, etc.

There are a great deal of sample projects available in the [Spring Cloud Stream Samples][scs-samples] repository.

Here's a quick snippet of how simple this framework makes the process of wiring up
event driven applications to set the stage for why we would use this framework over others.

##### Minimal Configuration

{% highlight yaml %}
spring:
  cloud:
    function:
      # Enable the bean by name
      definition: readAndPublish 
    stream:
      bindings:
        # The configuration for the function IN binding
        readAndPublish-in-0:
          destination: my.in.topic
        # The configuration for the function OUT binding
        readAndPublish-out-0:
          destination: my.out.topic
{% endhighlight %}

##### Minimal Java Code

{% highlight java %}

@SpringBootApplication
public class SpringCloudStreamExample {

    public static void main(String[] args) {
        SpringApplication.run(SpringCloudStreamExample.class, args);
    }

    /**
    * This stream we've defined simple checks if the incoming value is not equal to null.
    * If it isn't null, then it gets passed to the BeanName-out-0 configuration from our properties.
    *
    * The name of this bean is what gets mapped to the configuration, where "in-0" is the input configuration
    * and "out-0" is the output configuration for the function that we return here.
    **/
    @Bean
    public Function<KStream<String, String>, KStream<String, String>> readAndPublish() {
        return input -> input.filter(value -> value != null);
    }
}
{% endhighlight %}

This minimal code example does a simple null check and passes the message from the in-0 configuration
to the out-0 configuration. The framework comes with a TON of sensible default values, so a basic configuration is all
that's needed to set up our simple example.

However, my team noticed a relatively large gap when building incredibly
complex pipelines using Spring Cloud Streams, specifically when working with
Kafka Streams using the [Spring Cloud Stream Kafka Streams Binder][kafka-streams-binder-documentation]

## Problem

Before the introduction of RecordRecoverableProcessor, handling errors in Kafka Streams was a real headache. The framework primarily focused on [deserialization errors][deserialization-error-scs-ks], leaving developers to fend for themselves when it came to processing logic.

To manage exceptions, we were forced to wrap every processing step in a try-catch block and manually handle errors. This was not only tedious but also error-prone. To make matters worse, Spring Cloud Streams' default behavior was to kill the consumer thread upon any exception, preventing message acknowledgments and leading to endless restart loops.

A common workaround was to return Optional values from processing components and filter out errors. However, this approach introduced its own set of challenges, including type inference issues and a less-than-ideal developer experience.

{% highlight java %}
// Pseudocode
@Bean
public Function<KStream<String, String>, KStream<String, String>> readAndPublish() {
    return input -> input
        // This method has a complicated try-catch with logging and DLQ
        // and then ends in Optional.empty() if an error occurred
        .process(someMethod::returnsOptional)
        .filter(optional -> optional.isPresent())
        .process(someOtherMethod::returnsOptional2)
        .filter(optional -> optional.isPresent())
        .process(sometOtherOtherMethod::returnsOptional3)
        .filter(optional -> optional.isPresent())
}
{% endhighlight %}

Implementing a Dead Letter Queue (DLQ) was also a manual nightmare. While the framework offered DLQ capabilities for deserialization errors, there was no out-of-the-box solution for processing errors.

It wasn't until after raising [Issue #2779][spring-cloud-stream-issues-2779] with the Spring Cloud Streams team that the RecordRecoverableProcessor was introduced. This marked a significant improvement in the framework's error handling capabilities.
(Special thanks to [Soby Chako][soby-chako])

Attempting to implement a dead-letter-queue process (which is fully available via configuration during deserialization)
was an extremely manual process too.

## Solution

The solution, the RecordRecoverableProcessor and the DltAwareProcessor.

These two Processor components support supplying a function that is applied to the
incoming data and the result pushed to the outgoing data sink. They also can receive an error handling
function that gets applied to any exception thrown from inside the supplied function.

The new section of the documentation for these capabilities is [available here][non-deserialization-error-scs-ks].

There are two new components that can be used as KStream processor objects.

Both operate on a similar concept.

This is the main body of the [RecordRecoverableProcessor][rrp]:

{% highlight java %}
try {
    // The delegate function is the function passed into the processor
    Record<KOut, VOut> downstreamRecord = this.delegateFunction.apply(record);
    this.context.forward(downstreamRecord);
}
catch (Exception exception) {
    // The processorRecordRecoverer is the error function supplied.
    if (this.processorRecordRecoverer == null) {
      this.processorRecordRecoverer = defaultProcessorRecordRecoverer();
    }
    this.processorRecordRecoverer.accept(record, exception);
}
{% endhighlight %}

Both rely on the `this.context.forward` call to propagate the record downstream.

If `forward` is not called on the message, it is simply consumed on the spot and does not continue
through the stream, and no exception is propagated.

Below are examples of each of the two new components:

#### DltAwareProcessor

{% highlight java %}

@Bean
public Function<KStream<UUID, String>, KStream<UUID, String>> dltAwareExample(
    DltPublishingContext dltPublishingContext) {
    return input -> input
        .process(() -> new DltAwareProcessor<>(myRecord -> {
            throw new RuntimeException("Something went wrong, Error");
        }, "my.dead-letter-queue.topic", dltPublishingContext));
}

{% endhighlight %}

#### RecordRecoverableProcessor

Here is a sample RecordRecoverableProcessor, fully laid out. An IDE will suggest turning many parts
of this example into lambda functions, making it significantly cleaner. I will link both here to show what exactly
is happening with the expanded version, but also how short it can be with the cleaned up version.

{% highlight java %}

// Expanded version
@Bean
public Function<KStream<String, String>, KStream<String, String>> rrpDemo(){
    return input -> input
        .process(new ProcessorSupplier<String, String, String, String>() {
            @Override
            public Processor<String, String, String, String> get() {
                return new RecordRecoverableProcessor<>(
                    new Function<Record<String, String>, Record<String, String>>() {
                        @Override
                        public Record<String, String> apply(Record<String, String> stringStringRecord) {
                            return stringStringRecord;
                        }
                    },
                    new BiConsumer<Record<String, String>, Exception>() {
                        @Override
                        public void accept(Record<String, String> stringStringRecord, Exception e) {
                            log.error(e.getMessage());
                        }
                    }
                );
            }
        }
    );
}

// Collapsed Version
@Bean
public Function<KStream<String, String>, KStream<String, String>> rrpDemo(){
    return input -> input
        .process(() -> new RecordRecoverableProcessor<>(
            stringStringRecord -> stringStringRecord,
            (stringStringRecord, e) -> log.error(e.getMessage()
        )
    ));
}

{% endhighlight %}



### Finally

With Spring Cloud Streams, we can easily create rich and powerful pipelines connecting any number
of message processing systems.

I'm proud to have had a hand in closing what I see as one of the largest gaps in this framework
and look forward to the continued development of something so useful to the spring community!

[scs-samples]: https://github.com/spring-cloud/spring-cloud-stream-samples
[spring-cloud-stream-documentation]: https://spring.io/projects/spring-cloud-stream
[kafka-streams-binder-documentation]: https://cloud.spring.io/spring-cloud-stream-binder-kafka/spring-cloud-stream-binder-kafka.html#_kafka_streams_binder
[deserialization-error-scs-ks]: https://cloud.spring.io/spring-cloud-stream-binder-kafka/spring-cloud-stream-binder-kafka.html#_handling_deserialization_exceptions
[non-deserialization-error-scs-ks]: https://cloud.spring.io/spring-cloud-stream-binder-kafka/spring-cloud-stream-binder-kafka.html#_handling_non_deserialization_exceptions
[soby-chako]: https://github.com/sobychacko
[spring-cloud-stream-issues-2779]: https://github.com/spring-cloud/spring-cloud-stream/issues/2779
[rrp]: https://github.com/spring-cloud/spring-cloud-stream/blob/main/binders/kafka-binder/spring-cloud-stream-binder-kafka-streams/src/main/java/org/springframework/cloud/stream/binder/kafka/streams/RecordRecoverableProcessor.java#L84
