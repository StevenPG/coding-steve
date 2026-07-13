---
author: StevenPG
pubDatetime: 2026-07-20T12:00:00.000Z
title: "HTTP/3 in Java 26's HttpClient: Working Code and a Real Benchmark"
slug: java-26-httpclient-http3
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - http3
  - quic
  - performance
description: Java 26 ships HTTP/3 support in the built-in HttpClient (JEP 517) — QUIC over UDP, no third-party libraries. Working code for every discovery mode, the gotchas around fallback behavior, and an HTTP/2 vs HTTP/3 latency benchmark you can run yourself.
---

# HTTP/3 in Java 26's HttpClient: Working Code and a Real Benchmark

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Java 26 (March 2026) shipped [JEP 517: HTTP/3 for the HTTP Client API](https://openjdk.org/jeps/517), which means the JDK's built-in `java.net.http.HttpClient` can now speak HTTP/3 — QUIC over UDP, TLS 1.3 built into the transport — with **zero third-party dependencies**. The QUIC implementation lives inside `java.net.http` itself.

There's remarkably little hands-on content about this yet: most coverage restates the JEP. So this post is the practical version — working code for every discovery mode, the fallback semantics that will confuse you if you don't know them, what you can't do yet, and a small HTTP/2 vs HTTP/3 latency benchmark with methodology you can reproduce.

Quick primer if HTTP/3 is fuzzy: HTTP/2 multiplexes streams over one **TCP** connection, which means one lost packet stalls *every* stream on the connection until it's retransmitted (TCP head-of-line blocking — the transport-level cousin of the HTTP-level HOL blocking that HTTP/2 itself solved). HTTP/3 replaces TCP with **QUIC over UDP**: each stream recovers from loss independently, the TLS 1.3 handshake is fused into the transport handshake (one round trip, zero for resumed connections), and connections survive network changes via connection IDs instead of the 4-tuple. On clean datacenter networks the difference is modest; on lossy or high-latency paths it's substantial. I went deeper on why HTTP/2 matters for RPC workloads in the [gRPC guide](/posts/ultimate-guide-spring-grpc) — HTTP/3 is the next turn of that crank. (No, gRPC-over-HTTP/3 is not standardized yet.)

## The Minimum Viable HTTP/3 Request

```java
import java.net.URI;
import java.net.http.*;
import java.net.http.HttpResponse.BodyHandlers;

public class Http3Hello {
    public static void main(String[] args) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_3)
                .build();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://cloudflare-quic.com/"))
                .build();

        HttpResponse<String> response = client.send(request, BodyHandlers.ofString());

        System.out.println("Status:   " + response.statusCode());
        System.out.println("Protocol: " + response.version()); // HTTP_3 ... hopefully
    }
}
```

```bash
java Http3Hello.java
# Status:   200
# Protocol: HTTP_3
```

`HttpClient.Version` gains an `HTTP_3` constant, and that's the whole opt-in. But — and this is the first gotcha — **setting the version does not guarantee HTTP/3 is used.** Print `response.version()` while you're developing. You will be surprised how often the answer is `HTTP_2`, and the next section explains why.

## Discovery Modes: The Part Everyone Gets Wrong

A client can't know in advance that a server speaks HTTP/3 — QUIC lives on UDP, often on a different port, and firewalls eat UDP for lunch. The standard mechanism is **Alt-Svc**: the server advertises `alt-svc: h3=":443"` on a response delivered over HTTP/1.1 or HTTP/2, and clients upgrade *subsequent* connections.

JEP 517 exposes this via a new request option, `HttpOption.H3_DISCOVERY`, with three `Http3DiscoveryMode` values:

| Mode | Behavior | Use when |
|---|---|---|
| `ALT_SVC` (default) | First request(s) go over HTTP/1.1 or HTTP/2. If the server advertises `h3` via Alt-Svc, later requests use HTTP/3. | General internet clients. Safe everywhere, but your *first* request is never HTTP/3. |
| `HTTP_3_URI_ONLY` | Attempt QUIC directly at the request's host:port. Fails if the server isn't listening on QUIC there — no TCP fallback. | You control the server and know it speaks HTTP/3 on that authority. Also: benchmarks. |
| `ANY` | Race/attempt both; use what works, preferring an existing connection. | You want HTTP/3 opportunistically, including on the first request, but with a fallback. |

```java
HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create("https://api.internal.example:4433/health"))
        .setOption(HttpOption.H3_DISCOVERY,
                   HttpOption.Http3DiscoveryMode.HTTP_3_URI_ONLY)
        .build();
```

The failure mode that will cost you an afternoon: you point a default-configured (`ALT_SVC`) client at your own HTTP/3-only test server, and every request fails — because the client is trying to make an initial TCP connection that nothing is listening for. It never gets far enough to discover the QUIC endpoint. For servers you control, set `HTTP_3_URI_ONLY` explicitly.

The reverse also bites: in `ALT_SVC` mode against a big CDN, a one-shot CLI tool will *never* use HTTP/3, because it never lives long enough to make the second request. The Alt-Svc cache belongs to the `HttpClient` instance — reuse the client (you should be doing this anyway; it's the same rule as connection reuse in my [gRPC channel discussion](/posts/ultimate-guide-spring-grpc)).

Async works exactly as before, and HTTP/3 requests can share the client with HTTP/2 requests:

```java
CompletableFuture<HttpResponse<String>> future =
        client.sendAsync(request, BodyHandlers.ofString());
```

## Verifying What Actually Happened

Three tools, in the order I reach for them:

```java
// 1. In code - per response
System.out.println(response.version());

// 2. JDK HTTP client debug logging - shows QUIC handshake, Alt-Svc processing
// -Djdk.httpclient.HttpClient.log=requests,headers,quic

// 3. On the wire - QUIC is UDP, so filter for it
// sudo tcpdump -i any 'udp port 443'
```

If `tcpdump` shows TCP where you expected UDP, work through: Is the discovery mode right? Does anything on the path (Docker port mapping! `-p 443:443` publishes TCP only — you need `-p 443:443/udp` too) forward UDP? Is a corporate firewall dropping UDP 443? That last one is the reason `ANY`/`ALT_SVC` exist — treat HTTP/3 on the open internet as an optimization, never a requirement.

## What You Can't Do (Mid-2026 Edition)

Honest limitations list, because the JEP is a first release:

- **No HTTP/3 in `HttpServer`** — this is client-only. For serving HTTP/3 from the JVM you're looking at Netty's incubator QUIC transport or a proxy (Caddy, nginx, Envoy) terminating HTTP/3 in front of your app. Spring Boot's embedded servers do not serve HTTP/3 today.
- **WebSocket stays on TCP** — no WebTransport / WebSocket-over-HTTP/3.
- **Proxies:** HTTP/3 requests won't go through HTTP proxies (there's no MASQUE support); configured proxies effectively force a downgrade.
- **UDP path quality is your problem** — QUIC in userspace historically costs more CPU per byte than kernel-optimized TCP; for high-throughput bulk transfer inside one datacenter, HTTP/2 may still win. Measure (below).

## The Benchmark: HTTP/2 vs HTTP/3 Latency

I can't stand benchmark posts with numbers that were never actually measured, so this section follows the same rules as my [Go vs Spring Boot benchmark](/posts/go-vs-spring-boot-native-benchmark): real code, real methodology, and the results table filled in from runs on my own hardware (M3 MacBook Pro) before this publishes.

> **[DRAFT NOTE — numbers pending]** The tables below are placeholders until I run the final benchmark pass on the M3. The code and commands are complete and runnable as written.

### Setup

Server: **Caddy**, because it serves HTTP/1.1, HTTP/2, and HTTP/3 simultaneously on the same port with zero configuration effort, and it's a single binary.

```text
# Caddyfile
localhost:4443 {
    root * ./www
    file_server
    respond /api/ping `{"pong":true}` 200
}
```

```bash
# 1KB and 1MB payloads for two workload shapes
mkdir -p www && head -c 1024 /dev/urandom > www/small.bin && head -c 1048576 /dev/urandom > www/large.bin
caddy run
```

Client: one Java program, both protocols, same code path. Each run: 50 warmup requests, then 500 measured requests, recording wall time per request; we report p50/p95/p99. Sequential requests measure *latency*; a second mode fires 50 concurrent requests via virtual threads to measure multiplexing behavior under loss.

```java
import java.net.URI;
import java.net.http.*;
import java.net.http.HttpResponse.BodyHandlers;
import java.util.*;
import java.util.concurrent.*;

public class H2vsH3Bench {
    public static void main(String[] args) throws Exception {
        var version = HttpClient.Version.valueOf(args[0]); // HTTP_2 or HTTP_3
        var url = URI.create(args[1]);                     // e.g. https://localhost:4443/small.bin
        int warmup = 50, runs = 500;

        var builder = HttpClient.newBuilder().version(version);
        var client = builder.build();

        var reqBuilder = HttpRequest.newBuilder().uri(url);
        if (version == HttpClient.Version.HTTP_3) {
            // We control the server; skip Alt-Svc discovery entirely
            reqBuilder.setOption(HttpOption.H3_DISCOVERY,
                    HttpOption.Http3DiscoveryMode.HTTP_3_URI_ONLY);
        }
        var request = reqBuilder.build();

        for (int i = 0; i < warmup; i++) client.send(request, BodyHandlers.discarding());

        long[] samples = new long[runs];
        for (int i = 0; i < runs; i++) {
            long t0 = System.nanoTime();
            var resp = client.send(request, BodyHandlers.discarding());
            samples[i] = System.nanoTime() - t0;
            if (resp.version() != version)
                throw new IllegalStateException("Protocol fell back to " + resp.version());
        }
        Arrays.sort(samples);
        System.out.printf("%s p50=%.2fms p95=%.2fms p99=%.2fms%n", version,
                samples[runs / 2] / 1e6, samples[(int) (runs * 0.95)] / 1e6,
                samples[(int) (runs * 0.99)] / 1e6);
    }
}
```

Note the fallback guard — the benchmark *fails loudly* if a request silently downgrades, because otherwise you're comparing HTTP/2 with itself. (Local trust: run with `-Djdk.internal.httpclient.disableHostnameVerification` only if you must; better is adding Caddy's local CA to a throwaway truststore.)

The interesting run adds **packet loss**, because loss is where HTTP/3's independent stream recovery earns its keep. On Linux:

```bash
# Add 2% loss and 20ms delay on loopback (Linux)
sudo tc qdisc add dev lo root netem loss 2% delay 20ms
# ... run benchmarks ...
sudo tc qdisc del dev lo root
```

(On macOS the equivalent is `dnctl`/`pfctl` pipes; the repo README covers both.)

### Results

**Clean localhost, 1KB payload, sequential (500 requests):**

| Protocol | p50 | p95 | p99 |
|---|---|---|---|
| HTTP/2 | *TBD* | *TBD* | *TBD* |
| HTTP/3 | *TBD* | *TBD* | *TBD* |

**20ms delay + 2% loss, 1KB payload, sequential:**

| Protocol | p50 | p95 | p99 |
|---|---|---|---|
| HTTP/2 | *TBD* | *TBD* | *TBD* |
| HTTP/3 | *TBD* | *TBD* | *TBD* |

**20ms delay + 2% loss, 1MB payload, 50 concurrent streams:**

| Protocol | p50 | p95 | p99 | Total wall time |
|---|---|---|---|---|
| HTTP/2 | *TBD* | *TBD* | *TBD* | *TBD* |
| HTTP/3 | *TBD* | *TBD* | *TBD* | *TBD* |

What to expect from the shape of the results (and what published QUIC research consistently shows): near-parity on the clean run — possibly HTTP/2 slightly ahead, since userspace QUIC pays CPU overhead that a loss-free loopback never lets it recoup — and a widening HTTP/3 advantage at the tail (p95/p99) as loss and concurrency increase, because a lost TCP segment stalls all 50 HTTP/2 streams while QUIC streams recover independently. If my measured numbers contradict that shape, the analysis section will say so — that's the fun part.

The full benchmark code is available at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent).

## Should You Use It?

- **Calling public CDN-backed APIs from long-lived services:** yes — default `ALT_SVC` mode, free tail-latency improvement on bad networks, automatic fallback. Low risk.
- **Service-to-service inside a datacenter:** probably not yet. Clean low-latency networks neutralize QUIC's advantages, you pay userspace-QUIC CPU, and your service mesh probably can't proxy it anyway.
- **Mobile/consumer-facing backends-for-frontends calling upstream:** strong yes — this is QUIC's home turf (lossy networks, connection migration).
- **Anything requiring an HTTP proxy:** no, it'll downgrade.

The API design deserves credit: because it's the same `HttpClient` you already use, adopting HTTP/3 is a builder line and a request option — and un-adopting it is deleting them.

## Resources

- [JEP 517: HTTP/3 for the HTTP Client API](https://openjdk.org/jeps/517)
- [HTTP/3 Support in JDK 26 — Inside Java](https://inside.java/2025/10/22/http3-support/)
- [Http3DiscoveryMode Javadoc (JDK 26)](https://docs.oracle.com/en/java/javase/26/docs/api/java.net.http/java/net/http/HttpOption.Http3DiscoveryMode.html)
- [RFC 9114 (HTTP/3)](https://www.rfc-editor.org/rfc/rfc9114) / [RFC 9000 (QUIC)](https://www.rfc-editor.org/rfc/rfc9000)
- [The Ultimate Guide to gRPC with Spring Boot 4.1](/posts/ultimate-guide-spring-grpc) (the HTTP/2 deep-dive companion)
- [GraalVM Native Spring Boot vs Go — Build, Boot, and Benchmark](/posts/go-vs-spring-boot-native-benchmark) (benchmark methodology)
