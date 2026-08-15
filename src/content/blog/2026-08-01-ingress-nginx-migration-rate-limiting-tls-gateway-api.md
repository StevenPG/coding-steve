---
author: StevenPG
pubDatetime: 2026-08-01T12:00:00.000Z
title: "Ingress-NGINX Migration Part 2: Rate Limiting, TLS, and the Annotations That Don't Map"
slug: ingress-nginx-migration-rate-limiting-tls-gateway-api
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - kubernetes
  - devops
  - gateway-api
  - infrastructure
description: The follow-up to my ingress-nginx migration guide — how to replicate limit-rps rate limiting, cert-manager TLS automation, CORS, custom headers, and the other nginx.ingress.kubernetes.io annotations that have no one-line Gateway API equivalent, in Traefik, NGINX Gateway Fabric, and Envoy Gateway.
---

# Ingress-NGINX Migration Part 2: Rate Limiting, TLS, and the Annotations That Don't Map

## Table of Contents

[[toc]]

## Introduction

My [Guide to Migrating From Retired Ingress Nginx](/posts/guide-to-migrating-from-retired-ingress-nginx) covered the big picture: why ingress-nginx is retired (final release March 2026, security patches end this September), what the Gateway API is, and how to stand up Traefik, NGINX Gateway Fabric, or Envoy Gateway with basic HTTPRoutes. If you haven't done that part, start there.

This is Part 2, for the wall everyone hits next. `ingress2gateway` converts your hosts, paths, and backends — and then stops, because a huge fraction of real-world ingress behavior lived in **annotations**, and annotations were never a standard. `nginx.ingress.kubernetes.io/limit-rps` has no universal Gateway API equivalent; it has *three different* equivalents depending on which implementation you chose. That mapping — annotation by annotation, implementation by implementation — is this post. It's the reference I wanted at work while migrating dozens of applications; now it exists.

Throughout: **Traefik** (v3.6+), **NGINX Gateway Fabric** (NGF), and **Envoy Gateway** — the same three implementations from Part 1.

## The Mapping Table

The at-a-glance version, then each row in depth:

| ingress-nginx annotation | Gateway API standard? | Traefik | NGINX Gateway Fabric | Envoy Gateway |
|---|---|---|---|---|
| `limit-rps` / `limit-rpm` / `limit-burst-multiplier` | ❌ policy per impl | `Middleware` (rateLimit) | `RateLimitPolicy` | `BackendTrafficPolicy` (local or global) |
| `limit-connections` | ❌ | `Middleware` (inFlightReq) | — (NGINX Plus features vary) | `ClientTrafficPolicy` / connection limits |
| cert-manager `cluster-issuer` | ✅-ish (works on Gateway) | same annotation, on Gateway | same annotation, on Gateway | same annotation, on Gateway |
| `force-ssl-redirect` | ✅ `RequestRedirect` filter | native | native | native |
| `enable-cors` + `cors-allow-*` | ❌ | `Middleware` (headers/cors) | — (Snippets/native NGINX config) | `SecurityPolicy` (cors) |
| `configuration-snippet` / `server-snippet` | ❌ nothing generic | Traefik CRDs, maybe | `SnippetsFilter` | Envoy patches via `EnvoyPatchPolicy` |
| `whitelist-source-range` | ❌ | `Middleware` (ipAllowList) | — | `SecurityPolicy` (authorization) |
| `proxy-body-size` | ❌ | `Middleware` (buffering) | `ClientSettingsPolicy` | `ClientTrafficPolicy` |
| `proxy-read-timeout` etc. | 🔶 HTTPRoute `timeouts` (standard!) | native | native | native + `BackendTrafficPolicy` |
| `rewrite-target` | ✅ `URLRewrite` filter | native | native | native |
| `ssl-redirect` per-path, auth-url, canary-* | varies | see sections below | | |

Legend: ✅ = standard Gateway API, ❌ = implementation-specific resource required, 🔶 = standard but recently added (check your CRD versions).

The pattern to internalize: the Gateway API deliberately standardized *routing* and left *traffic policy* to implementation-specific **policy attachment** CRDs that target a Gateway, HTTPRoute, or backend by reference. So you're not looking for a magic annotation anymore; you're looking for each vendor's policy resource and attaching it.

## Rate Limiting: Replacing limit-rps

The ingress-nginx original, for reference:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "10"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"  # burst = 50
    nginx.ingress.kubernetes.io/limit-rpm: "600"
```

Semantics worth remembering while porting: ingress-nginx keyed on **client IP** by default, applied the limit **per NGINX replica** (not cluster-wide!), and returned **503** on limit (configurable). Those three details are where migrations silently change behavior — several implementations return the more-correct **429**, and some offer *global* (cluster-wide) limiting that ingress-nginx never had. Decide what you actually want before translating blindly.

### Traefik

Rate limiting is a `Middleware`, referenced from the route via an `ExtensionRef` filter:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: api-ratelimit
  namespace: my-namespace
spec:
  rateLimit:
    average: 10      # sustained req/s (limit-rps equivalent)
    burst: 50        # bucket size (rps * burst-multiplier)
    sourceCriterion:
      ipStrategy:
        depth: 1     # trust the last hop's X-Forwarded-For entry
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: my-namespace
spec:
  parentRefs:
    - name: gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: ExtensionRef
          extensionRef:
            group: traefik.io
            kind: Middleware
            name: api-ratelimit
      backendRefs:
        - name: my-service
          port: 8080
```

Token-bucket semantics, returns **429**, per-replica by default (like ingress-nginx; Traefik supports Redis-backed distributed limiting if you need cluster-wide).

### NGINX Gateway Fabric

NGF grew a dedicated `RateLimitPolicy` that attaches to a Gateway, HTTPRoute, or GRPCRoute — the closest one-to-one feel to the old annotations, since it's the same NGINX `limit_req` machinery underneath:

```yaml
apiVersion: gateway.nginx.org/v1alpha1
kind: RateLimitPolicy
metadata:
  name: api-ratelimit
  namespace: my-namespace
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  rateLimit:
    local:
      requests: 10
      timeUnit: second
      burst: 50
```

Check the field names against the NGF version you deploy — this API is young and has iterated (`v1alpha1` means what it says). Behavior matches classic NGINX: leaky-bucket `limit_req`, per-pod enforcement.

### Envoy Gateway

`BackendTrafficPolicy`, with the important choice between **local** (per-proxy-pod, ingress-nginx-like) and **global** (cluster-wide, backed by Envoy's Rate Limit Service + Redis):

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-ratelimit
  namespace: my-namespace
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  rateLimit:
    type: Local
    local:
      rules:
        - limit:
            requests: 10
            unit: Second
```

Global limiting swaps `type: Global` and requires deploying the rate limit service (the Envoy Gateway Helm chart can manage it) plus Redis — real infrastructure, but it buys you the thing the annotation never could: one limit across all replicas, keyed on any header/IP/route descriptor combination. If your old `limit-rps` was actually load-bearing capacity protection (not just abuse throttling), global is probably what you always wanted.

### Validating whichever you chose

```bash
# 15 rapid requests; watch for the cutoff and WHICH status code comes back
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code} " http://$GW_IP/api/get
done; echo
# ingress-nginx returned 503 by default - if clients special-cased that, 429 is a behavior change
```

## TLS: cert-manager Without Ingress Annotations

Part 1 showed TLS config moving from the Ingress + Secret into Gateway **listeners**. The follow-up question everyone has: *does my cert-manager automation still work?* Yes — cert-manager has first-class Gateway API support, and it's the same annotation you already know, just on the Gateway:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: my-issuer     # ← same as before
spec:
  gatewayClassName: traefik
  listeners:
    - name: https
      hostname: my-host.com
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: my-host-tls    # cert-manager creates/renews this Secret
```

Requirements and gotchas, learned the annoying way:

1. **Enable the feature** — cert-manager's Gateway API support is behind a flag: `--enable-gateway-api` on the controller (Helm: `config.enableGatewayAPI=true`), and cert-manager must start *after* the Gateway API CRDs exist or it disables the integration.
2. cert-manager watches Gateways with the annotation and generates a `Certificate` **per listener** that has `hostname` + `tls.certificateRefs` set. No hostname on the listener → no certificate.
3. **HTTP01 solvers work** — cert-manager creates a temporary HTTPRoute for `/.well-known/acme-challenge/` attached to your Gateway. Your Gateway therefore needs an HTTP (port 80) listener for solving; don't lock it to HTTPS-only until after issuance, or use DNS01.
4. The Secret must live in the **Gateway's namespace** (or be reachable via `ReferenceGrant`). If your old setup had per-app Ingresses each minting certs in app namespaces, consolidating to a shared Gateway *centralizes* cert management — usually an improvement, but it changes who owns renewal alerts.
5. Wildcard via DNS01 + one listener often replaces a dozen per-host certificates from the Ingress era. Fewer moving parts; do it if your issuer supports it.

### force-ssl-redirect

Standard API, no vendor anything — an HTTP listener whose only route redirects:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: gateway-system
spec:
  parentRefs:
    - name: gateway
      sectionName: http          # attach ONLY to the port-80 listener
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

`sectionName` is the trick people miss: it pins the redirect route to the HTTP listener so it can't shadow your real HTTPS routes. (Leave room for the ACME solver route from the cert-manager section — cert-manager's solver route matches more specifically, so they coexist.)

## The Rest of the Greatest Hits

### CORS (`enable-cors`, `cors-allow-origin`, ...)

- **Traefik:** `Middleware` with `headers.accessControlAllowOriginList`, etc., attached via `ExtensionRef` exactly like the rate-limit example.
- **Envoy Gateway:** `SecurityPolicy` with a `cors:` block targeting the route — the cleanest of the three.
- **NGF:** no dedicated CORS resource at time of writing; options are handling CORS in the application (honestly correct for APIs anyway — Spring's `@CrossOrigin`/`CorsConfigurationSource` beats proxy-level CORS for debuggability) or NGF's `SnippetsFilter`.

### Custom headers (`configuration-snippet` header blocks)

Standard API covers most of it now — the `RequestHeaderModifier` and `ResponseHeaderModifier` filters on HTTPRoute rules (set/add/remove). If your snippet was only `more_set_headers`, you migrate to *standard* Gateway API and delete a vendor dependency. Win.

### IP allowlisting (`whitelist-source-range`)

- **Traefik:** `Middleware` → `ipAllowList.sourceRange: [10.0.0.0/8, ...]`.
- **Envoy Gateway:** `SecurityPolicy` → `authorization` rules with `clientCIDRs` and a default-deny.
- **NGF:** not exposed as a first-class policy yet; use `SnippetsFilter` (`allow`/`deny` directives) or push it to `loadBalancerSourceRanges` on the Gateway's Service if the boundary can be L4.

Cloud caveat that predates Gateway API and survives it: client IP fidelity depends on `externalTrafficPolicy: Local` or proxy-protocol on the LB, or every allowlist decision is made against your cloud LB's SNAT address. Test with a real external client, not from inside the cluster.

### Body size and timeouts (`proxy-body-size`, `proxy-read-timeout`)

Timeouts got standardized — `HTTPRoute.spec.rules[].timeouts.request` / `timeouts.backendRequest` — and all three implementations honor them; this is one of the rare annotations that maps to *pure standard* API. Body size limits remain per-implementation: Traefik `buffering` middleware (`maxRequestBodyBytes`), NGF `ClientSettingsPolicy` (`body.maxSize`), Envoy Gateway `ClientTrafficPolicy`. If you had `proxy-body-size: "0"` (unlimited, for that one file-upload service), make it explicit in the new world rather than inheriting a default that's smaller than your uploads — this is a top-three source of post-migration incident tickets.

### Snippets: the escape hatch that isn't coming back

If you're relying on `server-snippet`/`configuration-snippet` for arbitrary NGINX config, understand that the Gateway API ecosystem considers this an anti-feature (the ingress-nginx CVE history — remember IngressNightmare — is substantially a snippets story, and most managed clusters had snippets disabled anyway). NGF's `SnippetsFilter` exists but is deliberately narrow and admin-gated; Envoy's `EnvoyPatchPolicy` can do nearly anything to the xDS config and is equally deliberately alarming to use. For each snippet, the migration question is not "how do I port this" but "which policy CRD or application-level feature replaces the *need* for this." In my dozens-of-apps migration, every snippet fell into: headers (→ standard filters), auth subrequests (→ `SecurityPolicy`/forward-auth middleware), rate/conn limits (→ above), or cargo cult (→ delete).

## A Worked Example: Full Before/After

Everything above in one artifact — the fully-annotated production Ingress from Part 1's opening, translated for Envoy Gateway:

<details>
<summary>Before: one Ingress, six annotations</summary>

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: my-namespace
  annotations:
    cert-manager.io/cluster-issuer: my-issuer
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    nginx.ingress.kubernetes.io/limit-rps: "10"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
    nginx.ingress.kubernetes.io/whitelist-source-range: "203.0.113.0/24"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [my-host.com]
      secretName: my-tls
  rules:
    - host: my-host.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service: { name: my-service, port: { number: 8080 } }
```
</details>

<details>
<summary>After: Gateway + HTTPRoutes + three policies (Envoy Gateway)</summary>

```yaml
# Gateway (platform team) — TLS + cert-manager
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: my-issuer
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes: { namespaces: { from: All } }
    - name: https
      hostname: my-host.com
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs: [{ name: my-host-tls }]
      allowedRoutes: { namespaces: { from: All } }
---
# HTTPS redirect (platform team)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: gateway-system
spec:
  parentRefs: [{ name: gateway, sectionName: http }]
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect: { scheme: https, statusCode: 301 }
---
# App route (app team)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: my-namespace
spec:
  parentRefs: [{ name: gateway, namespace: gateway-system, sectionName: https }]
  hostnames: [my-host.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /api } }]
      backendRefs: [{ name: my-service, port: 8080 }]
---
# Rate limit (app team)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-ratelimit
  namespace: my-namespace
spec:
  targetRefs:
    - { group: gateway.networking.k8s.io, kind: HTTPRoute, name: api-route }
  rateLimit:
    type: Local
    local:
      rules:
        - limit: { requests: 10, unit: Second }
---
# IP allowlist (app team)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: api-allowlist
  namespace: my-namespace
spec:
  targetRefs:
    - { group: gateway.networking.k8s.io, kind: HTTPRoute, name: api-route }
  authorization:
    defaultAction: Deny
    rules:
      - action: Allow
        principal: { clientCIDRs: ["203.0.113.0/24"] }
---
# Body size (platform team, per-gateway)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: body-limit
  namespace: gateway-system
spec:
  targetRefs:
    - { group: gateway.networking.k8s.io, kind: Gateway, name: gateway }
  connection:
    bufferLimit: 20Mi
```
</details>

Yes, it's more YAML. It's also auditable YAML: `kubectl get backendtrafficpolicy,securitypolicy -A` now answers "what rate limits and allowlists exist in this cluster" — a question the annotation era answered with `grep` and hope. Each policy has a `status` block telling you whether it actually attached, which is worth more than it sounds the first time a typo'd `targetRef` silently no-ops... check `kubectl describe` on every policy after applying. Always.

## Migration Order of Operations

For each annotated Ingress, my working sequence across those dozens of apps:

1. Inventory the annotations (`kubectl get ingress -A -o json | jq -r '.items[].metadata.annotations | keys[]' | sort | uniq -c | sort -rn` — from Part 1).
2. Classify each: **standard filter** (headers, redirect, rewrite, timeouts) / **policy CRD** (rate limit, CORS, allowlist, body size) / **cert-manager** (annotation moves to Gateway) / **snippet** (redesign or delete).
3. Port routes first, verify traffic, *then* layer policies one at a time with a `curl` validation for each (the loop above for rate limits; an out-of-range client for allowlists; an oversized POST for body limits).
4. Watch status codes change: 503→429 on limits, and per-replica→global semantics if you opted into global limiting. Update client retry logic and alerting accordingly.

## Summary

- Routing was standardized; **traffic policy is implementation-specific by design** — the annotation you're missing is now a policy CRD attached to your Gateway or HTTPRoute.
- `limit-rps` → Traefik `Middleware`, NGF `RateLimitPolicy`, Envoy Gateway `BackendTrafficPolicy` — and note the 503→429 status change and the per-replica vs global decision the old annotation never let you make.
- cert-manager works with Gateway API using the **same `cluster-issuer` annotation, on the Gateway**, behind the `--enable-gateway-api` flag; HTTP01 solving needs a port-80 listener.
- Headers, redirects, rewrites, and (newly) timeouts are pure standard API — migrate those and delete vendor coupling.
- Snippets don't port; each one gets redesigned into a policy or deleted. That's a feature.

## Resources

- [Guide to Migrating From Retired Ingress Nginx](/posts/guide-to-migrating-from-retired-ingress-nginx) (Part 1)
- [Gateway API — Policy Attachment](https://gateway-api.sigs.k8s.io/reference/policy-attachment/)
- [Traefik RateLimit Middleware](https://doc.traefik.io/traefik/middlewares/http/ratelimit/)
- [NGINX Gateway Fabric Rate Limit Policy](https://docs.nginx.com/nginx-gateway-fabric/traffic-management/rate-limit/)
- [Envoy Gateway Rate Limiting](https://gateway.envoyproxy.io/latest/concepts/rate-limiting/)
- [cert-manager Gateway API usage](https://cert-manager.io/docs/usage/gateway/)
- [HTTPRoute Timeouts (GEP-1742)](https://gateway-api.sigs.k8s.io/geps/gep-1742/)
