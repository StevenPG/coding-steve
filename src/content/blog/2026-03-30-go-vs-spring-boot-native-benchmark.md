---
author: StevenPG
pubDatetime: 2026-03-30T12:00:00.000Z
title: GraalVM Native Spring Boot vs Go — Build, Boot, and Benchmark
description: A head-to-head comparison of GraalVM native Spring Boot 4 and Go, build time, startup time, and runtime throughput on a real HTTP + Kafka workload.
slug: go-vs-spring-boot-native-benchmark
featured: true
draft: false
ogImage: /assets/default-og-image.png
tags:
  - golang
  - java
  - spring boot
  - graalvm
  - performance
  - kafka
---

## Table of Contents

[[toc]]

# GraalVM Native Spring Boot vs Go — Build, Boot, and Benchmark

Go compiles to a native binary by default. It's just what Go does. Spring Boot with GraalVM compiles to a native binary ahead-of-time. It's what Spring Boot can do when you opt in. Both make compelling claims about performance, and both produce a single executable that starts fast and runs without a traditional VM.

So how do they actually compare?

This post builds the **same application** in both — an HTTP API plus a Kafka consumer, where each request and each message triggers an outbound HTTP call to a downstream service — and measures the things that actually matter when you're making a production decision: **build time**, **startup time**, and **runtime throughput** at 50 concurrent requests.

One important distinction up front: this is **not** JVM Spring Boot vs Go. That's a different and arguably less fair fight. We're comparing GraalVM native Spring Boot 4 — the version that has deliberately opted in to native compilation — against Go. Both produce standalone binaries. Both skip the JVM. That's the interesting comparison.

I can't stand benchmark posts with numbers that were never actually measured. Every result in this post — build times, startup times, latency numbers — came from running this code on real hardware (My personal M3 Macbook Pro). The results table will have my machine's numbers when this publishes, not estimates. Your numbers will differ based on hardware, but the relative patterns should hold. The commands all work as written.

All of the code from this post is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/go-vs-spring-graal-vm-native-images).

# The Setup

Before building either application, we need three pieces of infrastructure: a downstream service to call, a Kafka broker to consume from, and a load testing tool to generate traffic. Everything here is intentionally simple so the benchmark measures the applications, not the test harness.

## Python Echo Server

The echo server simulates a downstream dependency. Every HTTP request and every Kafka message in both applications calls this server, so the workload is identical regardless of which app is running.

The 10ms sleep is the key ingredient. Without it, all calls complete near-instantly and we can't observe how the concurrency models behave under realistic I/O latency.

The server lives in its own `echo-server/` directory as a [uv](/posts/python-package-manager-uv/) project. It has no third-party dependencies — just the Python standard library — but keeping it self-contained means you can drop it anywhere and run it without worrying about your local Python environment.

**`echo-server/pyproject.toml`:**

```toml
[project]
name = "echo-server"
version = "0.1.0"
description = "Benchmark echo server — simulates a downstream service with 10ms latency"
requires-python = ">=3.11"
dependencies = []
```

**`echo-server/server.py`:**

```python
# A minimal HTTP server simulating a downstream service.
# The 10ms sleep is intentional — without a small delay, all calls complete
# near-instantly and we can't see the concurrency model working.
import json, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

class EchoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            time.sleep(0.010)  # 10ms simulated downstream latency
            body = json.dumps({
                "status": "ok",
                "timestamp_ms": int(time.time() * 1000)
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            # Disable keep-alive. Python's ThreadingHTTPServer doesn't manage
            # persistent connections reliably — closing after each response avoids
            # a race where a client reuses a connection Python has already torn down.
            # Java's JDK HttpClient throws EOFException on a stale connection;
            # Go's transport silently retries, so this matters most for Spring.
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            # Print the full error so we can see what's going wrong.
            # BaseHTTPRequestHandler silently swallows exceptions and returns 500
            # without any output if we don't catch them here ourselves.
            print(f"[ERROR] {self.path} — {e}", file=sys.stderr)
            raise

    # Override log_request (not log_message) so we only suppress the normal
    # per-request access lines (GET /echo 200) without also silencing error output.
    # log_message is still active for anything that isn't a routine request log.
    def log_request(self, code='-', size='-'): pass

if __name__ == "__main__":
    # ThreadingHTTPServer handles each connection in its own thread.
    # The default HTTPServer is single-threaded — with 50 concurrent callers
    # its TCP accept backlog fills up and callers get connection refused errors.
    server = ThreadingHTTPServer(("localhost", 9000), EchoHandler)
    print("Echo server ready on :9000")
    server.serve_forever()
```

Start it with:

```bash
cd echo-server && uv run server.py
```

## Docker Compose for Kafka

We're using KRaft-mode Kafka (no Zookeeper). This is the current standard for Kafka 3.x+ and keeps the test environment to a single container.

```yaml
# docker-compose.yml
# Single-node Kafka cluster using KRaft (Kafka Raft) mode.
# No Zookeeper required — this is the current standard for Kafka 3.x+.
services:
  kafka:
    image: apache/kafka:3.8.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      # Don't delay rebalance when there's only one broker
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
```

With Kafka running, I create the benchmark topic with **5 partitions**. Five partitions lets both applications parallelize across consumers — it's enough to see the concurrency model at work without overcomplicating things:

```bash
docker exec $(docker compose ps -q kafka) \
  /opt/kafka/bin/kafka-topics.sh --create \
  --topic benchmark-topic \
  --partitions 5 \
  --replication-factor 1 \
  --bootstrap-server localhost:9092
```

## Pre-loading Kafka Messages

For the Kafka drain test, we pre-populate 1000 messages before starting either application. Both apps use `auto.offset.reset=earliest` (or the equivalent), so they'll consume from the beginning of the topic on first start:

```bash
# Requires kcat (formerly kafkacat): brew install kcat
seq 1 1000 | xargs -I{} \
  sh -c 'echo "{\"id\":{},\"sent_ms\":$(date +%s%3N)}" | kcat -P -b localhost:9092 -t benchmark-topic'
```

## Load Test Tool

For load generation I'm using **`hey`**, a Go-based HTTP load generator. It's simple, fast, and reports exactly what we need — p50, p95, p99 latency and throughput. If you don't have it yet:

```bash
go install github.com/rakyll/hey@latest
```

I ran the same command against both apps:
```bash
hey -z 30s -c 200 http://localhost:8080/api/process
```

30 seconds at 200 concurrency. With 10ms of simulated downstream latency, the theoretical throughput ceiling is `200 ÷ 0.010 = 20,000 req/s` — 200 requests always in flight, each taking 10ms. That's the number to watch: if actual req/s approaches 20k, the concurrency model is working and the echo server is the bottleneck, not the application. If actual throughput falls well below, something is serializing. p50 should stay near 10ms for both apps if neither is queuing.

# The Go Application

The Go application is a single `main.go` file plus a `go.mod`. No frameworks, no dependency injection, no configuration files beyond the module definition. This is representative of how most Go HTTP+Kafka services look in production — the standard library does the heavy lifting.

**`go.mod`:**
```
module benchmark-go

go 1.26

require github.com/twmb/franz-go v1.20.7
```

**`main.go`** — the full application, heavily commented to explain Go idioms for readers coming from the Java side:

<details>

<summary>main.go</summary>

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// echoURL is the downstream service called for every API request and Kafka message.
// Both the HTTP handler and the Kafka consumer call this same target,
// so the workload is identical regardless of which path triggered it.
const echoURL = "http://localhost:9000/echo"

// httpClient is shared across all goroutines.
// Go's http.Client is safe for concurrent use and manages a connection pool internally.
// Setting MaxIdleConnsPerHost prevents connection exhaustion under high concurrency.
var httpClient = &http.Client{
	Timeout: 5 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        0,
		MaxIdleConnsPerHost: 0,
		IdleConnTimeout:     0 * time.Second,
	},
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	// Launch the Kafka consumer as a background goroutine.
	// It runs independently of the HTTP server — no shared state, no coordination needed.
	go runKafkaConsumer()

	// Register the single API route.
	// Go's net/http server automatically handles each incoming request in its own goroutine.
	// There's no configuration required for this — it's the default behavior.
	http.HandleFunc("/api/process", handleProcess)

	// Log the exact moment the server is ready. We use this timestamp to measure startup time.
	log.Printf("ready at %s", time.Now().Format(time.RFC3339Nano))
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// handleProcess handles incoming HTTP requests.
// Each call runs on its own goroutine — Go's scheduler multiplexes goroutines onto
// OS threads, so 50 concurrent requests means 50 goroutines running in parallel.
// If the echo call blocks on I/O, the goroutine parks and the OS thread is reused
// for another goroutine immediately.
func handleProcess(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	resp, err := httpClient.Get(echoURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("downstream error: %v", err), http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":     "ok",
		"elapsed_ms": time.Since(start).Milliseconds(),
	})
}

// runKafkaConsumer consumes messages from "benchmark-topic" starting at the earliest offset.
// Records are grouped by partition. Each partition gets one goroutine that processes its
// messages sequentially — one HTTP call completes before the next message is picked up.
// Across partitions, goroutines run concurrently (up to 5 in flight simultaneously).
// This is the standard Kafka consumer model: respect partition ordering, parallelize
// across partitions.
func runKafkaConsumer() {
	client, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:9092"),
		// "go-consumer-group" is distinct from Spring's "spring-consumer-group".
		// Each app independently reads all 1000 messages from the beginning of the topic.
		kgo.ConsumerGroup("go-consumer-group"),
		kgo.ConsumeTopics("benchmark-topic"),
		// "earliest" means start from the first message in the topic, not just new ones.
		// This lets us pre-load messages and measure drain time from a cold start.
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		log.Fatalf("kafka client error: %v", err)
	}
	defer client.Close()

	var (
		processed atomic.Int64
		firstAt   atomic.Int64 // UnixMilli of first completed message
		lastAt    atomic.Int64 // UnixMilli of most recently completed message
	)

	log.Println("kafka consumer ready")

	for {
		// PollFetches blocks until records are available, then returns them all.
		// With 5 partitions and 1000 pre-loaded messages, the first poll may return
		// hundreds of records at once.
		fetches := client.PollFetches(context.Background())
		if fetches.IsClientClosed() {
			break
		}
		fetches.EachError(func(t string, p int32, err error) {
			log.Printf("kafka error %s/%d: %v", t, p, err)
		})

		// Group records by partition. We'll give each partition its own goroutine
		// and process that partition's records one at a time.
		partitions := make(map[int32][]*kgo.Record)
		fetches.EachRecord(func(rec *kgo.Record) {
			partitions[rec.Partition] = append(partitions[rec.Partition], rec)
		})

		// Fan out: one goroutine per partition.
		// Within each goroutine, records are processed sequentially — the HTTP call
		// blocks until the echo server responds before moving to the next record.
		// WaitGroup ensures all partitions finish before we poll and commit again.
		var wg sync.WaitGroup
		for _, recs := range partitions {
			wg.Add(1)
			go func(records []*kgo.Record) {
				defer wg.Done()
				for range records {
					resp, err := httpClient.Get(echoURL)
					if err != nil {
						log.Printf("echo error: %v", err)
						continue
					}
					resp.Body.Close()

					n := processed.Add(1)
					now := time.Now().UnixMilli()
					// CAS: only the very first completion sets firstAt (0 → now).
					firstAt.CompareAndSwap(0, now)
					lastAt.Store(now)

					if n%100 == 0 {
						log.Printf("processed %d messages", n)
					}
				}
			}(recs)
		}
		wg.Wait()
	}

	if n := processed.Load(); n > 0 {
		log.Printf("DONE: processed %d messages in %dms", n, lastAt.Load()-firstAt.Load())
	}
}
```

</details>

A few things to notice here. There's no framework. The HTTP server is the standard library. The Kafka consumer is one third-party library (`franz-go`). The concurrency model — goroutine per request, goroutine per Kafka record — is the natural Go pattern, not something bolted on. This is what "Go is native by default" looks like in practice.

# The Spring Boot Native Application

The Spring Boot version of the same application uses Spring Boot 4 with the GraalVM Native Build Tools plugin. It's a single Java file, a build file, and a properties file. The structure is more than Go's single file, but it's also carrying more framework machinery — dependency injection, auto-configuration, Kafka listener abstraction.

<details>

<summary>Full Spring Application</summary>

It's worth mentioning, that it took me a while to get the Spring Boot app working with Kafka
due to the native image compilation not seeing some of the reflective kafka pieces. I ended up
needed to run the tracing agent manually, starting up the app as a JVM application, and then
re-running the native image build. This is a known issue with GraalVM native compilation — if the build doesn't see certain code paths during the points-to analysis, it won't include the necessary metadata for reflection, and you have to use the tracing agent to capture that metadata. Spring Boot's AOT processor generates hints for most of Spring's own features, but third-party libraries like Kafka can require manual intervention.

That's tip in Golangs favor when native images are necessary, as none of this is necessary with Golang.

## Build Configuration

**`build.gradle`:**

```groovy
// build.gradle
plugins {
    id 'java'
    id 'org.springframework.boot' version '4.0.0'
    id 'io.spring.dependency-management' version '1.1.7'
    // The GraalVM Native Build Tools plugin adds nativeCompile, nativeRun, and nativeTest tasks.
    // It also integrates with the Spring AOT processor to generate native hints automatically
    // for most Spring Boot features.
    id 'org.graalvm.buildtools.native' version '0.10.3'
}

group = 'com.example'
version = '0.0.1-SNAPSHOT'

java {
    // Spring Boot 4 requires Java 25. GraalVM CE for Java 25 is required for nativeCompile.
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.kafka:spring-kafka'
}

graalvmNative {
    // The reachability metadata repository contains pre-generated native image hints
    // for popular libraries (Jackson, Hibernate, etc.). Enabling this avoids most
    // manual reflect-config.json entries for third-party code.
    metadataRepository {
        enabled = true
    }
    binaries {
        main {
            // Automatically detect and include resources (application.properties, etc.)
            resources.autodetect()
        }
    }
}
```

**`application.properties`:**

```properties
# application.properties

# Virtual threads — each incoming HTTP request and each Kafka message
# gets its own virtual thread instead of borrowing from a fixed platform-thread pool.
# Virtual threads are cheap (JDK manages millions), so blocking I/O calls like our
# echo server call don't waste OS threads waiting.
spring.threads.virtual.enabled=true

spring.kafka.bootstrap-servers=localhost:9092
spring.kafka.consumer.auto-offset-reset=earliest
spring.kafka.consumer.key-deserializer=org.apache.kafka.common.serialization.StringDeserializer
spring.kafka.consumer.value-deserializer=org.apache.kafka.common.serialization.StringDeserializer

# One listener container per partition. Each container processes records from its
# partition sequentially — each message must complete before the next is dispatched.
# With 5 partitions, up to 5 messages are processed concurrently at any time.
spring.kafka.listener.concurrency=5
```

The `spring.threads.virtual.enabled=true` line is doing a lot of work here. It tells Spring Boot to handle each incoming HTTP request on a **virtual thread** instead of borrowing from a fixed platform-thread pool. Virtual threads are cheap — the JDK can manage millions of them — so blocking I/O calls (like our outbound HTTP call to the echo server) don't waste OS threads. This is architecturally the same idea as goroutines.

## Application Code

**`Application.java`** — the full single file, heavily commented for readers coming from the Go side:

```java
package com.example;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.http.client.JdkClientHttpRequestFactory;

import java.net.http.HttpClient;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

@SpringBootApplication
public class Application {

    private static final Logger log = Logger.getLogger(Application.class.getName());

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    @Bean
    RestClient restClient() {
        // Use Java's built-in HTTP client backed by a virtual-thread-per-task executor.
        // This pairs with spring.threads.virtual.enabled=true so every outbound
        // call runs on a virtual thread — no platform thread is held while waiting
        // for the echo server to respond.
        var jdkClient = HttpClient.newBuilder()
                .executor(Executors.newVirtualThreadPerTaskExecutor())
                .build();
        return RestClient.builder()
                .requestFactory(new JdkClientHttpRequestFactory(jdkClient))
                .build();
    }

    // -------------------------------------------------------------------------
    // HTTP API
    // -------------------------------------------------------------------------

    @RestController
    @RequestMapping("/api")
    static class ApiController {

        private final RestClient restClient;

        ApiController(RestClient restClient) {
            this.restClient = restClient;
        }

        @GetMapping("/process")
        ResponseEntity<Map<String, Object>> process() {
            long start = System.currentTimeMillis();

            // With spring.threads.virtual.enabled=true, each HTTP request lands on
            // a virtual thread. This blocking call suspends the virtual thread while
            // waiting for the echo server — the underlying platform thread is freed
            // to run other virtual threads. Equivalent to a goroutine parking on I/O.
            restClient.get()
                    .uri("http://localhost:9000/echo")
                    .retrieve()
                    .toBodilessEntity();

            return ResponseEntity.ok(Map.of(
                    "status", "ok",
                    "elapsed_ms", System.currentTimeMillis() - start
            ));
        }
    }

    // -------------------------------------------------------------------------
    // Kafka Consumer
    // -------------------------------------------------------------------------

    @Component
    static class KafkaMessageConsumer {

        private static final Logger log = Logger.getLogger(KafkaMessageConsumer.class.getName());
        private static final int EXPECTED_MESSAGES = 1000;

        private final RestClient restClient;
        private final AtomicLong processed = new AtomicLong(0);
        private final AtomicLong firstAt   = new AtomicLong(0);
        private final AtomicLong lastAt    = new AtomicLong(0);

        KafkaMessageConsumer(RestClient restClient) {
            this.restClient = restClient;
        }

        // spring.kafka.listener.concurrency=5 creates one listener container per partition.
        // Each container's thread processes records from its partition one at a time —
        // this method must return before the next record on that partition is dispatched.
        // Across partitions, the 5 containers run concurrently: up to 5 HTTP calls in
        // flight simultaneously. This mirrors Go's per-partition goroutine model.
        // "spring-consumer-group" is distinct from Go's "go-consumer-group" so both apps
        // can independently read all 1000 messages from the start of the topic.
        @KafkaListener(topics = "benchmark-topic", groupId = "spring-consumer-group")
        public void consume(ConsumerRecord<String, String> record) {
            processRecord(record.value());
        }

        private void processRecord(String message) {
            long now = System.currentTimeMillis();
            // compareAndSet(0, now) is atomic: only the very first record sets firstAt.
            firstAt.compareAndSet(0, now);

            restClient.get()
                    .uri("http://localhost:9000/echo")
                    .retrieve()
                    .toBodilessEntity();

            long count = processed.incrementAndGet();
            lastAt.set(System.currentTimeMillis());

            if (count % 100 == 0) {
                log.info("Processed " + count + " messages...");
            }
            if (count == EXPECTED_MESSAGES) {
                log.info("DONE: processed " + count + " messages in "
                        + (lastAt.get() - firstAt.get()) + "ms");
            }
        }
    }
}
```

</details>

The structural parallel to the Go version is deliberate. The Kafka consumer uses `concurrency=5` to assign one listener container per partition. Each container processes its partition's messages one at a time — the listener returns before the next record arrives — while the 5 containers run concurrently. This is the same model as Go's per-partition goroutines: sequential within a partition, parallel across partitions. The HTTP handler follows the same pattern: each request lands on a virtual thread, makes a blocking outbound call, and the underlying platform thread is freed while waiting.

# How to Measure

With the infrastructure running (echo server, Kafka, pre-loaded messages), here's how I collected each number. Follow along and you should get comparable results on similar hardware.

## Build Time

I wanted a clean number here, so I cleared caches before timing each build. For Go that means no cached build artifacts; for Gradle I run `clean` first:

```bash
# Go
time go build -o app-go .

# Spring Boot Native (requires GraalVM JDK 25 on PATH)
time ./gradlew nativeCompile
```

## Startup Time

Both apps emit a "ready" log line as soon as they're accepting connections — I time from launch to that line:

```bash
# Go — watch for "ready at <timestamp>"
time ./app-go

# Spring Boot Native — watch for "Started Application in X seconds"
time ./build/native/nativeCompile/benchmark-spring
```

## API Throughput

Once the app is up and the echo server is accepting connections, I fire `hey` at both apps with the same command:

```bash
hey -z 30s -c 200 http://localhost:8080/api/process
```

## Kafka Drain

One thing to watch out for: `auto.offset.reset=earliest` only kicks in when the consumer group has **no committed offsets**. After the first run, the group has already committed all 1000 offsets to the end of the topic — on the next start, the consumer picks up right there and finds nothing. I reset the offset before each run (with the app stopped):

```bash
# Reset Go consumer group
docker exec $(docker compose ps -q kafka) \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group go-consumer-group \
  --reset-offsets --to-earliest \
  --topic benchmark-topic --execute

# Reset Spring consumer group
docker exec $(docker compose ps -q kafka) \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group spring-consumer-group \
  --reset-offsets --to-earliest \
  --topic benchmark-topic --execute
```

Then I start the app and wait for the "DONE" log line:

```bash
./app-go        # or ./build/native/nativeCompile/benchmark-spring
# Record time from "ready" to "DONE: processed 1000 messages in Xms"
```

# Results

| Metric                      | Go     | Spring Boot Native |
|-----------------------------|--------|--------------------|
| Build time (s)              | 2.569  | 72                 |
| Startup time (ms)           | 6      | 46                 |
| API p50 (ms)                | 0.0134 | 0.0136             |
| API p95 (ms)                | 0.2244 | 0.1652             |
| API p99 (ms)                | 1.0658 | 2.0249             |
| API throughput (req/s)      | 2623   | 2124               |
| Kafka drain (1000 msgs) (s) | 2.8    | 2.9                |

*These numbers are from my personal M3 Macbook Pro. Your results will vary — for reference, you can see see the [Casual Machine Perf Test](/posts/casual-machine-perf-test/) post for how much machine-to-machine differences affect GraalVM native compile and startup times.*

**What to expect directionally:** Go typically wins on build time and startup time. The throughput numbers should be competitive — both concurrency models solve the same problem with architecturally similar approaches.

# Analysis

## Build Time

Go wins this one decisively. `go build` completes in seconds. `nativeCompile` can take minutes.

The reason is structural, not a matter of toolchain maturity. GraalVM's native compilation performs a **points-to analysis** — a whole-program analysis that must examine every reachable class, method, and field to determine what code can possibly execute at runtime. This is fundamentally more work than what Go's compiler does. Go compiles packages independently and links them together. GraalVM has to see everything at once.

This cost is paid once, at build time, not at startup or runtime. But it matters in practice. If your CI pipeline runs `nativeCompile` on every push, you're adding minutes to every build. Go's compilation speed is one of its best-known features, and it earns that reputation here.

## Startup Time

Both are fast. Both are in the "ready before you notice" range. But Go is faster in absolute terms — we're talking single-digit milliseconds versus the tens or hundreds of milliseconds.

The gap matters at the extremes. If you're running serverless functions where cold start latency directly impacts user-facing response times, Go's sub-10ms startup is a genuine advantage. If you're running autoscalers that need to respond to traffic spikes as fast as possible, those hundreds of milliseconds add up when you're spinning up dozens of instances simultaneously.

For most long-running services that start once and run for weeks, both numbers are effectively zero. The startup time difference only matters when it matters — but when it matters, it really matters.

## API Throughput

This is where things get interesting, and where the numbers should challenge some assumptions.

With 10ms of simulated downstream latency per request, the **concurrency model** dominates the throughput result. The application code itself is trivial — receive request, make outbound call, return response. The question is: how efficiently can each runtime handle 200 concurrent requests that are all blocked on I/O?

Go's **goroutines** and Spring's **virtual threads** are designed to solve this exact problem in the same way. Both use **M:N scheduling** — many lightweight threads (goroutines or virtual threads) multiplexed onto a smaller number of OS threads. When a goroutine or virtual thread blocks on I/O, the underlying OS thread is freed to run another one. No thread sits idle waiting for the echo server to respond.

Where they differ is in implementation:

- **Go's runtime scheduler** is built into the Go runtime itself. It's been tuned since Go 1.0, handles goroutine creation, parking, and resumption, and manages its own set of OS threads. The scheduling is cooperative with preemption points inserted by the compiler.
- **JVM's virtual thread scheduler** is built into the JDK (since Java 21). It uses a ForkJoinPool of carrier (platform) threads and parks/resumes virtual threads when they block on I/O. It benefits from decades of JVM thread scheduling work but is newer as a lightweight-thread implementation.

The architectural similarity means the throughput numbers should be **competitive**. At 200 concurrent requests and 10ms latency, both should approach 20,000 req/s with p50 near 10ms — any runtime that can schedule 200 non-blocking I/O callbacks without queuing will hit that ceiling. If either app falls significantly short, the bottleneck is somewhere in the scheduling path.

## Kafka Drain

Both applications use the same strategy: one worker per partition, sequential within each partition. In Go, this is a goroutine per partition that loops through its records one at a time. In Spring, `concurrency=5` creates one listener container per partition; the listener method must return before the next record is dispatched on that partition.

With 5 partitions and 1000 pre-loaded messages (~200 messages per partition), each partition processes its records sequentially at 10ms each. The five partitions run concurrently, so total drain time should be roughly `200 × 10ms = ~2 seconds`. That's a concrete, observable number — you can watch the "processed N messages" log lines tick up every 50–100ms rather than having the whole 1000 messages vanish in a single burst.

This also preserves Kafka's per-partition ordering guarantee: record N on partition 2 is processed before record N+1 on partition 2, which is the contract most real consumer applications rely on.

Differences will come from the poll implementation and overhead:
- **franz-go** is a minimal, purpose-built Kafka client. It does exactly what you tell it and nothing more.
- **spring-kafka** wraps the official Apache Kafka Java client with Spring's listener container abstraction. There's more machinery involved — consumer group management, error handling, offset commit strategies — all handled by the framework.

That additional machinery adds some overhead, but it also adds features you'd otherwise build yourself. Whether that trade-off is worth it depends on your project, not this benchmark.

## Memory

Go binaries are small and RSS under load is typically lower than Spring native. A GraalVM native Spring Boot application still carries the Spring application context, reflection metadata (even if reduced by AOT processing), and the Substrate VM runtime. The JVM is gone, but the framework is still there.

I sampled RSS with `ps -o rss= -p <pid>` while `hey` was running at 200 concurrency:

|                     | Go   | Spring Boot Native |
|---------------------|------|--------------------|
| RSS under load (MB) | 59MB | 200MB              |

Go's lower memory baseline matters most in environments with tight container limits or when you're running many instances and paying per-MB. I'll fill this in once I capture both numbers — grab your own with `ps -o rss= -p $(pgrep app-go)` and `ps -o rss= -p $(pgrep benchmark-spring)` while load is running.

# When to Choose Go

- **Build toolchain simplicity.** No JDK toolchain, no native plugin, no build tool plugins. One command: `go build`. The binary works.
- **Startup is a hard constraint.** Sub-10ms cold starts for Lambda functions, CLI tools that need to feel instant.
- **Small binary size matters.** Go binaries are typically 10-20MB. Native Spring Boot binaries are larger. This compounds when you're optimizing container images.
- **You don't need the Spring ecosystem.** If you're not using Spring Data JPA, Spring Security, Spring Cloud, or any of the other Spring projects, you're paying the complexity cost of the framework without using the features that justify it.
- **Your team is comfortable with Go idioms.** Goroutines, channels, explicit error handling, composition over inheritance — Go has a distinctive style. If your team speaks that language, staying in it is the right call.

# When to Choose Spring Boot Native

- **You're already in the Java/Spring ecosystem.** Rewriting a working Spring Boot application in Go to save 2 minutes of build time is almost never the right trade-off. The real comparison for most teams is JVM Spring Boot vs native Spring Boot — and native gives you a 10x startup improvement over the JVM without rewriting application code.
- **You need Spring's libraries.** Spring Data JPA, Spring Security, Spring Cloud Gateway, Spring Batch — these are mature, well-tested libraries that solve hard problems. The Go equivalents are either less mature, less integrated, or don't exist.
- **Your team knows Java.** Maintaining expertise in two languages is expensive. If your team writes Java and doesn't want to also maintain Go services, native Spring Boot gives you native-binary performance without a language switch.
- **You want a path from JVM to native without rewriting.** The same `@RestController`, the same `@KafkaListener`, the same application code. Add the native plugin, run `nativeCompile`, and you have a native binary. The migration path is a build configuration change, not a rewrite.
- **GraalVM's build time is acceptable for your CI pipeline.** If you deploy once a day, 3 minutes of native compile is nothing. If you deploy 50 times a day, it's a different calculation.

# Conclusion

The comparison shows the real trade-off clearly. Go has a simpler path to native performance because it's *always* native — there's no opt-in, no special build plugin, no alternate compilation mode. Spring Boot Native shows how far the Java ecosystem has come toward closing that gap — the runtime throughput for goroutines vs virtual threads should be close, because both solve the same concurrency problem with architecturally similar approaches.

The build time difference is real and persistent. GraalVM's whole-program analysis is fundamentally more work than Go's package-level compilation, and no amount of caching or incremental compilation will make them equivalent. If `nativeCompile` taking minutes is a blocker for your CI pipeline, that's a genuine constraint regardless of how good the startup and runtime numbers look.

Neither is the wrong answer for every project. The point of running this benchmark is to replace intuition with data. "Go is faster" and "Spring Boot is too slow" are both oversimplifications that don't survive contact with actual measurements. The numbers help you make the decision based on what your project actually needs — build speed, startup latency, runtime throughput, ecosystem fit, team expertise — rather than vibes.
