# TODO

Outstanding work for the July/August 2026 draft post series (all currently `draft: true`).
Flip each post to `draft: false` only after its checklist is complete.

## Benchmark posts — numbers must be measured before publishing

### `2026-07-20-java-26-httpclient-http3.md`
- [x] Push the `H2vsH3Bench` benchmark code + Caddyfile to [DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent) and update the repo link in the post to the exact subdirectory — [PR #13](https://github.com/StevenPG/DemosAndArticleContent/pull/13) (merge it, then smoke-run on JDK 26)
- [ ] Run the benchmark on the M3 MacBook Pro (JDK 26) and fill in all three `*TBD*` results tables:
  - Clean localhost, 1KB sequential
  - 20ms delay + 2% loss, 1KB sequential
  - 20ms delay + 2% loss, 1MB × 50 concurrent
- [x] Document the macOS `dnctl`/`pfctl` loss-injection commands in the demo repo README (post references it) — in PR #13
- [ ] Update/remove the "what to expect" paragraph if measured results contradict the predicted shape
- [ ] Remove the `[DRAFT NOTE — numbers pending]` callout

### `2026-07-29-java-26-aot-cache-zgc-leyden-benchmarks.md`
- [x] Build the Spring Boot 4.1 benchmark app (webmvc + JPA/H2 + actuator + training profile `CommandLineRunner`) and push to DemosAndArticleContent — [PR #13](https://github.com/StevenPG/DemosAndArticleContent/pull/13) (merge it, then `./gradlew bootJar` smoke-run on JDK 26)
- [ ] Run 10× per configuration on the M3 (JDK 26 Temurin) and fill in the `*TBD*` tables:
  - JDK 26: G1 / ZGC / Serial, cache on vs off
  - ZGC across JDK 25 vs 26 (object layer inactive vs active)
  - Cache file size + RSS at readiness
- [x] Verify the readiness-probe wrapper script measures what the post claims (curl poll at 5ms) — `scripts/measure-startup.sh` in PR #13, includes `-Xlog:aot` cache-engagement check
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

## September 2026 "what's new" series (all `draft: true`)

Each post has a companion project in DemosAndArticleContent with its own PR. Merge the PR before publishing
the post: the posts link to `tree/main/blog/...` paths that only resolve after merge. Container runs in each
project are shape-only; the posts' `*TBD*` tables need the M3 numbers.

### `2026-09-15-java-27-new-defaults-benchmark.md` — [PR #25](https://github.com/StevenPG/DemosAndArticleContent/pull/25)
- [x] `./scripts/fetch-jdks.sh && (cd bench-app && ./gradlew bootJar) && python3 scripts/benchmark.py measure` on the M3; fill both `*TBD*` tables
- [x] Reconcile "What to look for" with the M3 run: now "What the numbers say" (M3: G1 18.5% slower than Serial on 1 CPU, Serial +37% on 2 CPUs, compact headers -14.5% live set but throughput +13% to -20%)
- [x] Remove the `[DRAFT NOTE]` callout
- [x] Final correctness pass; `draft: false` (merge DemosAndArticleContent PR #25 before this branch deploys, or the repo link 404s)

### `2026-09-17-spring-ai-2-mcp-server-ops-toolbox.md` — [PR #26](https://github.com/StevenPG/DemosAndArticleContent/pull/26)
- [ ] Connect Claude Code (`claude mcp add --transport http ...`) and the MCP Inspector to the demo; neither client was run yet
- [ ] Replace the `[DRAFT NOTE]` with a real Claude Code transcript against the flaky `/api/orders` endpoint

### `2026-09-21-python-3-15-lazy-imports-free-threading.md` — [PR #27](https://github.com/StevenPG/DemosAndArticleContent/pull/27)
- [ ] After 3.15.0 final (Oct 1): `./scripts/setup.sh && python3 scripts/bench.py all` on the M3; fill the startup, threads and JIT `*TBD*` tables
- [ ] Update interpreter versions in the post (currently 3.15.0rc2); remove the `[DRAFT NOTE]`

### `2026-09-25-postgres-19-repack-concurrently.md` — [PR #28](https://github.com/StevenPG/DemosAndArticleContent/pull/28)
- [ ] Re-run `python3 scripts/repack_bench.py run --rows 8000000` on the M3 against 19 RC/GA (bump the image tag in `compose.yaml`); fill the `*TBD*` table
- [ ] Re-run `sql/whats-new-19.sql` on GA — confirm GROUP BY ALL / FOR PORTION OF / SQL/PGQ are still absent before publishing that section

### `2026-09-19-typescript-7-go-compiler-benchmark.md` — [PR #29](https://github.com/StevenPG/DemosAndArticleContent/pull/29)
- [x] `npm install && python3 scripts/bench.py prepare && python3 scripts/bench.py run` on the M3; fill the three `*TBD*` tables
- [x] Check the "native vs parallel" split holds with more cores — M3 (12 cores): native 3.1–3.9x, parallel 1.4–2.0x, total 5.5–6.8x; added the `--checkers 1` and exit-code (2 → 1) findings
- [x] Final correctness pass; `draft: false` (merge DemosAndArticleContent PR #29 before this deploys, or the repo link 404s)

### `2026-09-23-kubernetes-pod-level-resources-jvm.md` — [PR #30](https://github.com/StevenPG/DemosAndArticleContent/pull/30)
- [ ] (Optional, post-publish) Run `./scripts/run.sh` (kind, Kubernetes 1.37) on the M3 — it could not run in the build sandbox; confirm the kubelet sets the unlimited container's `memory.max` to the pod limit and that scenario 03 ends in `OOMKilled`
- [ ] Record the `PodLevelResources` feature stage that `run.sh` prints; adjust the post's intro wording if needed
- [x] Published on the Docker emulation results (`draft: false`); draft note replaced with a methodology note. Merge DemosAndArticleContent PR #30 before this deploys.

### Found along the way (not fixed — this blog repo)
- [ ] `tsconfig.json` uses `baseUrl` + bare `paths`: `tsc` 6 errors (TS5101) and 7 errors (TS5090). Fix: drop `baseUrl`, prefix paths with `./src/` (see DemosAndArticleContent `blog/typescript-7-go-compiler-benchmark/patches/coding-steve.tsconfig.json`), then check `npm run build`
- [ ] 3 remaining type errors after `astro sync`: `Buffer` not assignable to `BodyInit` in `og.png.ts`, `posts/[slug]/index.png.ts`, `projects/[slug]/index.png.ts`. (A fourth, in `rss.xml.ts`, was a live bug — every RSS item linked to `/posts/undefined/` — and is fixed on this branch.)
