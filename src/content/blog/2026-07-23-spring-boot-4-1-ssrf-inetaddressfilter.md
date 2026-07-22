---
author: StevenPG
pubDatetime: 2026-07-23T12:00:00.000Z
title: "SSRF Hardening in Spring Boot 4.1 with InetAddressFilter"
slug: spring-boot-4-1-ssrf-inetaddressfilter
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - security
  - ssrf
description: Spring Boot 4.1's InetAddressFilter blocks SSRF at the HTTP client layer — one bean protects RestClient, RestTemplate, and WebClient. How to block cloud metadata endpoints (169.254.169.254) and internal ranges, why the filter must run after DNS resolution, and how to test it.
---

# SSRF Hardening in Spring Boot 4.1 with InetAddressFilter

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. If you're here because a pentest report or audit finding says something like *"the application fetches user-supplied URLs without restricting destination addresses (SSRF)"* — you're in the right place, and Spring Boot 4.1 finally gives you a first-party fix: **`InetAddressFilter`**. One bean, and every auto-configured HTTP client in your application refuses to connect to the addresses you block.

This post covers what SSRF actually is, why the naive URL-string validation everyone writes first is broken, how `InetAddressFilter` works for both blocking (`RestClient`/`RestTemplate`) and reactive (`WebClient`) clients, and how to verify it with tests you can show the auditor.

## SSRF in Two Minutes

Server-Side Request Forgery is when an attacker convinces *your server* to make an HTTP request on their behalf. Anywhere your application fetches a URL that a user influences — webhook registration, "import from URL" features, PDF/image fetchers, OpenGraph link previews, integrations that accept a callback address — is a candidate.

The attacker doesn't ask for `https://example.com`. They ask for:

```text
http://169.254.169.254/latest/meta-data/iam/security-credentials/   ← AWS credentials
http://metadata.google.internal/computeMetadata/v1/                 ← GCP equivalent
http://10.0.4.17:8080/actuator/env                                  ← your internal services
http://localhost:6379/                                              ← whatever else is listening
```

The metadata endpoint is the crown jewel: on a misconfigured cloud instance, one SSRF request returns temporary IAM credentials, and from there it's not your app that's compromised, it's your account. The Capital One breach (2019) was this exact chain. IMDSv2 (which requires a PUT-then-token dance) mitigates it on AWS — *if* it's enforced — but defense in depth says the request should never leave your process at all.

## Why Your URL Validator Doesn't Work

Every team's first attempt is string checking, and every string check has the same class of bypass:

```java
// ❌ All of these "validations" are broken
if (url.contains("169.254.169.254")) reject();   // http://[::ffff:169.254.169.254]/
if (host.equals("localhost")) reject();          // http://127.0.0.1, http://127.1, http://0.0.0.0
if (host.startsWith("10.")) reject();            // http://0x0a000001/ (hex for 10.0.0.1)
                                                 // http://2852039166/ (decimal IP)
if (isPublicIp(InetAddress.getByName(host))) ok(); // ← DNS rebinding: resolves public NOW,
                                                   //   resolves 169.254.169.254 when fetched
```

The last one is the important lesson: **checking the address and then making the request are two separate DNS resolutions**, and an attacker-controlled DNS server can answer them differently (DNS rebinding). Plus redirects: the validated URL can 302 to an internal one, and your HTTP client happily follows.

The correct place to enforce a destination policy is **inside the client, at connection time, against the actually-resolved address**. That's exactly what `InetAddressFilter` is.

## InetAddressFilter: The API

Spring Boot 4.1 introduces `org.springframework.boot.http.client.InetAddressFilter` — a functional interface deciding, per resolved address, whether a connection is allowed. When a bean of this type exists, Boot's HTTP client autoconfiguration applies it to the clients it builds: `RestClient` (via `RestClient.Builder`), `RestTemplate` (via `RestTemplateBuilder`), and the reactive `WebClient` connector. Requests to a rejected address fail fast with a filtered-host exception instead of leaving the network.

Here's a production-shaped filter blocking the standard internal ranges:

```java
import org.springframework.boot.http.client.InetAddressFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.InetAddress;

@Configuration
public class SsrfHardeningConfig {

    @Bean
    InetAddressFilter internalAddressBlockingFilter() {
        return address -> !isForbidden(address);
    }

    private boolean isForbidden(InetAddress address) {
        // Covers 127.0.0.0/8 and ::1
        if (address.isLoopbackAddress()) return true;
        // Covers 169.254.0.0/16 (cloud metadata lives here) and fe80::/10
        if (address.isLinkLocalAddress()) return true;
        // Covers RFC 1918: 10/8, 172.16/12, 192.168/16 (and fc00::/7 unique-local)
        if (address.isSiteLocalAddress()) return true;
        // 0.0.0.0 / ::
        if (address.isAnyLocalAddress()) return true;
        // Multicast has no business in an outbound HTTP call
        if (address.isMulticastAddress()) return true;
        // IPv4-mapped IPv6 sneaking internal v4 through (::ffff:10.0.0.1)
        byte[] raw = address.getAddress();
        if (raw.length == 16 && isV4Mapped(raw)) {
            return isForbiddenV4(raw[12] & 0xff, raw[13] & 0xff);
        }
        return false;
    }

    private boolean isV4Mapped(byte[] raw) {
        for (int i = 0; i < 10; i++) if (raw[i] != 0) return false;
        return (raw[10] & 0xff) == 0xff && (raw[11] & 0xff) == 0xff;
    }

    private boolean isForbiddenV4(int b0, int b1) {
        return b0 == 10 || b0 == 127
                || (b0 == 169 && b1 == 254)
                || (b0 == 172 && b1 >= 16 && b1 <= 31)
                || (b0 == 192 && b1 == 168);
    }
}
```

A few things worth noticing:

- The JDK's `InetAddress` predicate methods (`isLoopbackAddress()`, `isLinkLocalAddress()`, `isSiteLocalAddress()`) do the heavy lifting and handle both IPv4 and IPv6 — this is the part hand-rolled string checks always miss. `169.254.169.254` is link-local, so the metadata endpoint is covered by `isLinkLocalAddress()` without ever writing the magic IP in your code.
- Because the filter receives a **resolved `InetAddress`**, DNS rebinding and "decimal IP" obfuscation are irrelevant — whatever the hostname resolved to is what gets checked.
- The filter is deny-by-predicate; keep it *boring*. Cleverness in security filters is where bypasses live.

### Wiring: What's Covered Automatically and What Isn't

Covered by autoconfiguration when the bean exists:

```java
// RestClient built from the auto-configured builder — covered
@Service
class WebhookNotifier {
    private final RestClient restClient;
    WebhookNotifier(RestClient.Builder builder) {   // inject Boot's builder
        this.restClient = builder.build();
    }
}

// WebClient built from the auto-configured builder — covered (reactive path)
@Service
class LinkPreviewService {
    private final WebClient webClient;
    LinkPreviewService(WebClient.Builder builder) { // inject Boot's builder
        this.webClient = builder.build();
    }
}
```

**Not covered**: clients you construct by hand (`RestClient.create()`, `WebClient.create()`, raw `new RestTemplate()`, a bare JDK `HttpClient`, OkHttp instantiated directly). The upgrade task, then, is a codebase grep:

```bash
grep -rn "RestClient.create\|WebClient.create\|new RestTemplate(" src/main/java
```

Every hit is either (a) refactored to inject Boot's builder, or (b) consciously exempted and documented. This grep list is also exactly what your auditor wants to see.

If you followed my [OAuth2 web clients guide](/posts/ultimate-guide-spring-web-clients-oauth2), the good news is that pattern already injects Boot's builders everywhere — the filter composes cleanly with OAuth2 client configuration since both hang off the same builder chain.

### Redirects

Because the filter runs at connection time *per connection*, a redirect chain is checked at every hop: an allowed public URL that 302s to `http://169.254.169.254/` fails when the client tries to connect to the redirect target. This closes the classic "validate the first URL, follow the redirect blind" hole with no extra code. (Belt-and-suspenders: consider `HttpClient.Redirect.NEVER` semantics for URL-fetching features and surface redirects to the caller instead.)

## Testing It

Security configuration without tests regresses silently. Two layers of test earn their keep:

```java
@SpringBootTest
class SsrfHardeningTest {

    @Autowired RestClient.Builder builder;

    @ParameterizedTest
    @ValueSource(strings = {
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8080/actuator/env",
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://[::1]/",
            "http://[::ffff:10.0.0.1]/"
    })
    void blocksInternalDestinations(String url) {
        RestClient client = builder.build();
        assertThatThrownBy(() ->
                client.get().uri(url).retrieve().toBodilessEntity())
            .hasRootCauseInstanceOf(
                org.springframework.boot.http.client.FilteredInetAddressException.class);
    }

    @Test
    void allowsPublicDestinations() {
        // WireMock on a public-looking hostname isn't practical; instead assert
        // the filter bean's decision directly for a known-public address
        assertThat(filter.test(InetAddress.getByName("93.184.216.34"))).isTrue();
    }
}
```

(Adjust the exception assertion to the exact type your Boot version throws — check the root cause chain in the first failing run; wrapping differs between the blocking and reactive stacks.)

The second layer is a **canary in staging**: a scheduled job that actually attempts `http://169.254.169.254/` through a production-configured client and alerts if the request *succeeds*. Config regressions (someone swaps a builder for `WebClient.create()` during a refactor) get caught in hours instead of at the next pentest.

## Defense in Depth: The Rest of the Checklist

`InetAddressFilter` is the application-layer control. The finding in your audit closes fully when it's paired with:

1. **IMDSv2 enforced** (AWS: `HttpTokens=required` on the instance/launch template) or workload identity (GKE/EKS) so metadata credentials aren't a one-request prize.
2. **Egress network policy** — Kubernetes `NetworkPolicy` or security groups restricting where pods can connect. The app filter stops your HTTP clients; network policy stops *everything else* (a compromised dependency doesn't use your beans). If you run Gateway API infrastructure, this belongs in the same review as your [ingress migration](/posts/guide-to-migrating-from-retired-ingress-nginx).
3. **Allowlists over blocklists where the feature permits** — a webhook feature that only ever calls three partner APIs should allowlist those hosts at the application layer; the address filter then backstops DNS games.
4. **No secrets in `/actuator/env`** — if SSRF does reach an actuator endpoint, sanitization should already have happened. My [actuator guide](/posts/ultimate-guide-spring-boot-actuator) covers locking that down.

## Upgrading Notes

- `InetAddressFilter` requires **Spring Boot 4.1** — it's one of the release's headline security features alongside first-party gRPC. Full upgrade rundown in [Spring Boot 4.0 → 4.1: What's New and What Breaks](/posts/spring-boot-4-1-whats-new-what-breaks).
- On 4.0 or 3.5 and can't upgrade yet? The same *architecture* (filter at connect time, post-resolution) can be hand-built: a custom `HttpClient`/connector with an address-checking DNS resolver for Reactor Netty, or an Apache HttpClient `HttpRoutePlanner`. It's ~100 lines per client stack and you'll delete it at 4.1 — which is itself a decent argument for scheduling the upgrade.

## Summary

- SSRF is an *address* problem, not a *URL string* problem — enforcement belongs at connection time, after DNS resolution, which is exactly where `InetAddressFilter` sits.
- One bean covers every auto-configured `RestClient`, `RestTemplate`, and `WebClient`; hand-rolled clients are the remaining audit surface, and a grep finds them.
- Lean on `InetAddress`'s own predicates (loopback, link-local, site-local) instead of enumerating magic IPs — they cover IPv6 and the metadata endpoint for free.
- Test the block with a parameterized test over the classic bypass payloads, and keep a canary running.
- Pair it with IMDSv2 and egress policy and you can close the finding with a straight face.

## Resources

- [Spring Boot 4.1 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.1-Release-Notes)
- [InetAddressFilter API docs](https://docs.spring.io/spring-boot/api/java/org/springframework/boot/http/client/InetAddressFilter.html)
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [AWS IMDSv2 documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- [Spring Boot 4.0 → 4.1: What's New and What Breaks](/posts/spring-boot-4-1-whats-new-what-breaks) (my upgrade guide)
- [The Ultimate Guide to Spring Web Clients + OAuth2](/posts/ultimate-guide-spring-web-clients-oauth2)
- [The Ultimate Guide to Spring Boot Actuator](/posts/ultimate-guide-spring-boot-actuator)
