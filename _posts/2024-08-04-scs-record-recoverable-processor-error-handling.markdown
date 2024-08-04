---
layout: post
title:  "Spring Cloud Stream's RecordRecoverableProcessor for Workflow Error Handling"
toc: true
date: 2024-08-04 12:00:00 -0500
categories:
- software
- spring boot
- java
- kafka
---

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
        SpringApplication.run(KafkaStreamsRecoverableSample.class, args);
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

Prior to the introduction of the RecordRecoverableProcessor, the only error handling available
in the documentation was [handling deserialization errors][deserialization-error-scs-ks].

This means that you could only gracefully handle errors using the framework's common components by
making sure the initial deserialization failed, or you had to perform try-catch wrapped operations at all
processing points in the code.

Better yet, the default configuration of spring-cloud-streams is to kill the consumer thread when an exception
propagates to the root. Killing the thread results in a failure to ACK a kafka message.

The final result of all of this, is a single exception thrown in a processing component makes an application
continuously restart and fail on the same message over and over again.

In my experience, resolving this meant applying a pattern where an optional was returned from every processing or transforming
component and following it with a filter operation, checking whether there was an error or not.

This also came with issues with Intellisense, as it sometimes could not determine the type from the
return Optional.

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

Attempting to implement a dead-letter-queue process (which is fully available via configuration during deserialization)
was an extremely manual process too.

Cue my conversation with one of the Spring Cloud Streams' team members, [Soby Chako][soby-chako].

[Spring Cloud Streams Issue #2779][spring-cloud-stream-issues-2779]

It doesn't take long to hit this issue in production and become very frustrated with
what feels like a massive gap in the framework's capabilities.

The components to resolve this issue were available in the framework, but not as a standard
component until after issue #2779 referenced above was resolved.

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
