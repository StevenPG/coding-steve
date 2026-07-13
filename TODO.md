# TODO

Outstanding work for the July/August 2026 draft post series (all currently `draft: true`).
Flip each post to `draft: false` only after its checklist is complete.

## Benchmark posts — numbers must be measured before publishing

### `2026-07-20-java-26-httpclient-http3.md`
- [ ] Push the `H2vsH3Bench` benchmark code + Caddyfile to [DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent) and update the repo link in the post to the exact subdirectory
- [ ] Run the benchmark on the M3 MacBook Pro (JDK 26) and fill in all three `*TBD*` results tables:
  - Clean localhost, 1KB sequential
  - 20ms delay + 2% loss, 1KB sequential
  - 20ms delay + 2% loss, 1MB × 50 concurrent
- [ ] Document the macOS `dnctl`/`pfctl` loss-injection commands in the demo repo README (post references it)
- [ ] Update/remove the "what to expect" paragraph if measured results contradict the predicted shape
- [ ] Remove the `[DRAFT NOTE — numbers pending]` callout

### `2026-07-29-java-26-aot-cache-zgc-leyden-benchmarks.md`
- [ ] Build the Spring Boot 4.1 benchmark app (webmvc + JPA/H2 + actuator + training profile `CommandLineRunner`) and push to DemosAndArticleContent
- [ ] Run 10× per configuration on the M3 (JDK 26 Temurin) and fill in the `*TBD*` tables:
  - JDK 26: G1 / ZGC / Serial, cache on vs off
  - ZGC across JDK 25 vs 26 (object layer inactive vs active)
  - Cache file size + RSS at readiness
- [ ] Verify the readiness-probe wrapper script measures what the post claims (curl poll at 5ms)
- [ ] Reconcile the "expected ~40% band" analysis text with actual results
- [ ] Remove the `[DRAFT NOTE — numbers pending]` callout

## Fact-checks against fast-moving APIs

- [ ] `2026-08-01` (ingress part 2): spot-check NGF `RateLimitPolicy` field names (`v1alpha1`, `spec.rateLimit.local.*`) against the deployed NGF version — API is young and has iterated
- [ ] `2026-08-01`: spot-check Envoy Gateway `BackendTrafficPolicy` / `SecurityPolicy` / `ClientTrafficPolicy` shapes against the current release; verify `ClientTrafficPolicy.connection.bufferLimit` is the right body-size knob
- [ ] `2026-07-23` (SSRF): confirm the exact exception type thrown for filtered addresses (post guesses `FilteredInetAddressException` — check the root-cause chain on a real Boot 4.1 run, blocking vs reactive may differ) and fix the test snippet
- [ ] `2026-07-23`: verify the `spring.http.clients.cookie-handling` property name mentioned in the 4.1 post against release notes/docs
- [ ] `2026-07-11` (Undertow): sanity-check the property mapping table against Boot 4.x `server.tomcat.*`/`server.jetty.*` docs (esp. Jetty accesslog + form-keys rows)
- [ ] `2026-07-14` (pinning): confirm `-Djdk.tracePinnedThreads` removal detail and JFR pin-event threshold (20ms default) on JDK 25

## Content follow-ups

- [ ] `2026-07-26` (JEP 525): when structured concurrency finalizes (expected late 2026), update the post for the final API, bump `modDatetime`, remove the maintenance note
- [ ] Migration guide (`2026-02-16`) references `/posts/spring-compat-cheatsheet` — confirm that post/slug exists or fix the link
- [ ] Consider `featured: true` for 1–2 of the strongest posts once published (Undertow and 4.0→4.1 are the likely search winners)
- [ ] Add OG images per post if moving away from `/assets/default-og-image.png`

## Publishing sequence

- [ ] Review each post's voice/claims, then flip `draft: false` in pubDatetime order:
  1. 07-11 Undertow ClassNotFoundException
  2. 07-14 Virtual thread pinning 2026
  3. 07-17 Spring Boot 4.0 → 4.1
  4. 07-20 HTTP/3 in Java 26 (after benchmarks)
  5. 07-23 SSRF InetAddressFilter
  6. 07-26 Structured concurrency JEP 525
  7. 07-29 AOT cache + ZGC (after benchmarks)
  8. 08-01 Ingress-NGINX part 2
- [ ] Posts dated in the future relative to publish day: either confirm the site build hides future-dated posts or adjust `pubDatetime` at publish time
- [ ] The three updated older posts (migration guide, Leyden, ingress part 1) already have `modDatetime` bumps matching their new companion posts — verify the "Update" callout links resolve once the drafts go live
