---
author: StevenPG
pubDatetime: 2025-11-16T05:00:00.000Z
title: Should I use Java 25 Compact Object Headers?
slug: should-i-use-java-25-compact-object-headers
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - java
  - performance
description: With the release of Java 25, should you consider using Compact Object Headers for better memory efficiency?
---

# Should Java Developers Enable Compact Object Headers in Java 25?

Java 25 introduces [JEP 519](https://openjdk.org/jeps/519), which adds support for compact object headers as a production feature. This capability was experimental in Java 24 [JEP 450](https://openjdk.org/jeps/450). This is one of those improvements that sounds abstract but has real implications for both memory usage and CPU performance. Here we'll break down what this means for your applications and whether you should consider enabling it.

## What Are Compact Object Headers?

Every object in the Java heap starts with an object header—metadata that tracks the object's hash code, lock state, and garbage collection information. In traditional Java, this header consumes 96 bits (12 bytes) on 64-bit systems with compressed references enabled.

Compact object headers reduce this overhead by storing some of this metadata outside the object itself, in a separate auxiliary data structure. The header shrinks to 64 bits (8 bytes), saving 4 bytes per object instance. While that might sound minor, when you're working with millions of small objects, it adds up quickly.

## Why Does This Improve Performance?

The benefits work on two levels: memory and CPU.

The claim by JEP 519 is an up to 30% memory savings in object-heavy workloads, which includes Spring Boot applications.

**Memory:** Fewer bytes per object means more objects fit in your CPU cache and heap. This directly reduces your memory footprint, which matters for containerized environments where heap size is constrained.

**CPU Cache Efficiency:** More objects in the L1/L2 cache means fewer cache misses during traversal. When your application iterates through collections of objects or performs bulk operations, better cache locality translates to measurable throughput improvements. The CPU has to access main memory fewer times.

**Garbage Collection:** The reduced header size means the GC has less metadata to scan and process, potentially improving pause times and GC throughput.

Technically, this works by using a side table (indexed by object address) to store traditionally in-header data like hash codes and monitor information. When an object needs this data, the JVM looks it up in the auxiliary structure rather than reading it from the object itself.

## Comparisons

Here's where it gets interesting. Enable the flag with `-XX:+UseCompactObjectHeaders` and you'll see differences depending on your workload.

For this first test, I ran a simple API that connects to a postgres database and performed a set of operations
that exercised the API's logic. These are averages over 3 repeated and identical workflow executions.

The app is limited in resources with the following options: `-XX:ActiveProcessorCount=1 -Xms32m -Xmx64m`

| Metric                   | Jre24 Standard Headers | Jre25 Standard Headers | Compact Headers | Improvement |
|--------------------------|------------------------|------------------------|-----------------|-------------|
| Startup Time (ms)        | 7.39                   | 7.28                   | 6.29            | 14.8%       |
| First GC Heap Size (MiB) | 18.4                   | 17.4                   | 15.8            | 14.2%       |
| End Heap Size (MiB)      | 55.4                   | 48.8                   | 45.8            | 17.3%       |


*Note: This is just a simple Rest API, these metrics would vary significantly based on object size distribution and application characteristics. Your application may benefit less or more than this example*

The second test is an API that receives a message and sends it to Kafka to be processed asynchronously by a message processor.

This is more of a real-world scenario, with roughly 1000 requests per second being sent to the API, and here are the results:

API Settings: `-XX:ActiveProcessorCount=4 -Xms2048m -Xmx2048m`
Message Processor Settings: `-XX:ActiveProcessorCount=2 -Xms512m -Xmx512m`

These were also each repeated 3 times for accuracy.

| Metric                   | Jre21 Standard Headers | Jre25 Compact Headers | Improvement |
|--------------------------|------------------------|-----------------------|-------------|
| Throughput (reqs/sec)    | 1028                   | 1028                  | 0%          |
| Mean Response Time (s)   | 3.7                    | 2.9                   | 21.6%       |
| Median Response Time (s) | 2                      | 2                     | 0%          |
| p99 Response Time (s)    | 32.8                   | 19.9                  | 39.3%       |
| API Start Heap (MiB)     | 136                    | 134                   | ~0%         |
| MP Start Heap (MiB)      | 124                    | 114                   | 8%          |
| API Mid-Test Heap (MiB)  | 651                    | 142                   | 78%         |
| MP Mid-Test Heap (MiB)   | 507                    | 373                   | 26%         |

From this test, we can see that compact headers decrease response time slightly, and does reduce the overall memory footprint.

It's slightly more difficult to determine cpu efficiency gains, but decreased response time shows a clear improvement.

The API simply publishes kafka messages and does basic processing to the incoming request, but we see a MASSIVE memory improvement
during the test under active load for the API, dropping nearly 80% of the heap size. This is likely due to the fact that the
API handles many small objects for the life of the request, and with less memory pressure, the GC can run more often.

Similarly, the message processor processes a set number of messages per second, so with the decreased header size, it
processes a similar number of messages per second (limited by CPU concurrency), but with a lower memory footprint (nearly 26% less in this test).

## Should You Enable It?

You should enable this feature if you're using Java 25 and meet the following criteria:

- Your application creates lots of small objects
- You're memory-constrained (Kubernetes pod limits, cloud costs)
- You're already using compressed references (`-XX:+UseCompressedOops`)
- You can test it thoroughly in a staging environment

## Reasons to be Cautious

Although at first glance it seems like this feature has no downsides, it's worth considering carefully if:

- You're running on Java 25 for the first time in production (it was experimental in Java 24, so ensure stability first)
- You use libraries heavily dependent on object header assumptions (rare, but possible)
- Your application relies on specific lock or hash code behaviors

## The Reality Check

This is an experimental feature in Java 24 that was made available in Java 25. That means it's stable enough to try, but not guaranteed to be the default in future releases. The JDK team is gathering feedback on real-world workloads.

The performance gains are real but workload-dependent. A batch processing application handling millions of small DTOs will see bigger wins than a request-per-thread web service. The 4-byte savings per object compounds differently depending on your object graph.

## Next Steps

If you're interested in testing this:

```bash
java -XX:+UseCompactObjectHeaders -jar your-app.jar
```

Collect metrics on memory usage, GC behavior, and throughput under realistic load. Compare against your baseline. The results will tell you whether this feature makes sense for your specific application.

The key takeaway: compact object headers are a solid micro-optimization for object-heavy workloads. It's worth benchmarking if you fit that profile, but it's not a magic bullet for every Java application.