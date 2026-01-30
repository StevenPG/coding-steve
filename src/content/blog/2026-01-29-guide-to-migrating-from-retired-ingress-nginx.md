---
author: StevenPG
pubDatetime: 2026-01-29T12:00:00.000Z
title: Guide to Migrating From Retired Ingress Nginx
slug: guide-to-migrating-from-retired-ingress-nginx
featured: true
ogImage: /assets/default-og-image.png
tags:
  - kubernetes
  - devops
  - gateway-api
  - infrastructure
description: A comprehensive guide to migrating from the retiring ingress-nginx controller to the Kubernetes Gateway API, covering implementation options like Traefik, NGINX Gateway Fabric, Envoy Gateway, and Istio.
---

# Guide to Migrating From Retired Ingress Nginx

## Table of Contents

[[toc]]

## Introduction

If you're a DevOps engineer maintaining Kubernetes clusters, you've likely heard the news: ingress-nginx is being retired in March 2026. For many of us, this isn't just an inconvenience - it's a significant undertaking that requires careful planning and execution.

I get it. You've spent time configuring ingress-nginx, tuning its annotations, setting up TLS termination, and building automation around it. Now you're being told to migrate to something new on someone else's timeline. This guide is here to help you navigate that transition with as little pain as possible (and also for me to use as reference at my job when I have to do this for dozens of applications, including a very not-well-documented UDP tunnel...)

The good news? The Kubernetes Gateway API represents a genuine improvement in how we handle ingress traffic. The concepts are cleaner, the API is more expressive, and the ecosystem of implementations gives you real choice. The bad news? We all still have to do the migration.

Let's walk through what's changing, why, and how to get your clusters onto a supported solution before the deadline.

## What is Ingress Nginx and How You're Probably Using It

Before we talk about migration, let's establish a baseline. Ingress-nginx is (was?) the most popular ingress controller in the Kubernetes ecosystem. It wraps the battle-tested NGINX reverse proxy and integrates it with Kubernetes through the Ingress resource.

If you're running ingress-nginx, your setup probably looks something like this:

```yaml
# A typical ingress-nginx Ingress resource
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-application
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls-secret
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 80
```

You might also be using:

- **Annotations** for NGINX-specific configuration (rate limiting, CORS, custom headers)
- **ConfigMaps** for global NGINX settings
- **Custom snippets** for advanced NGINX configuration
- **TCP/UDP services** exposed through ConfigMaps
- **Multiple ingress controllers** for different environments or traffic classes

The more customization you've done, the more work you'll have ahead. But don't worry - we'll cover strategies for all of these scenarios.

## Why is ingress-nginx Being Retired?

The [official announcement from the Kubernetes project](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) explains the reasoning, but here's the practical summary:

**The Ingress API has fundamental limitations.** The Ingress resource was designed years ago and hasn't aged well. It lacks support for:
- Traffic splitting and canary deployments (natively)
- Header-based routing
- Request/response manipulation
- Protocol-specific configuration (gRPC, WebSocket)
- Clear separation between infrastructure and application concerns

**Annotations became a crutch.** Every ingress controller implemented its own annotation scheme to work around Ingress limitations. This led to:
- Vendor lock-in through proprietary annotations
- No portability between controllers
- Configuration sprawl that's hard to audit

**Gateway API is the future.** The Kubernetes project has invested heavily in Gateway API as the successor to Ingress. It addresses all the limitations above with a clean, extensible design.

**Maintenance burden.** The ingress-nginx project has struggled with maintainer capacity. Rather than let it languish, the decision was made to retire it and direct users toward actively maintained Gateway API implementations.

### What "Retired" Actually Means

Let's be clear about the timeline:

| Date | What Happens |
|------|--------------|
| November 2025 | Retirement announced |
| March 2026 | Final release, security patches only |
| September 2026 | End of security patches |

After March 2026, you won't get new features. After September 2026, you won't get security fixes. You can technically keep running it forever, but you'll be accumulating technical debt and security risk.

## What is the Gateway API?

The [Gateway API](https://gateway-api.sigs.k8s.io/) is a collection of Kubernetes resources that provide a more expressive and extensible way to configure ingress traffic. It's developed by the Kubernetes SIG-Network community and is designed to be the long-term replacement for the Ingress resource.

### Core Concepts

Gateway API introduces a clear separation of concerns through three main resource types:

**GatewayClass** - Defines the controller implementation (similar to IngressClass)
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: example-gateway-class
spec:
  controllerName: example.com/gateway-controller
```

**Gateway** - Represents the actual load balancer/proxy infrastructure
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: example-gateway
  namespace: gateway-system
spec:
  gatewayClassName: example-gateway-class
  listeners:
    - name: http
      port: 80
      protocol: HTTP
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: example-cert
```

**HTTPRoute** (and other Route types) - Defines how traffic is routed to services
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: example-route
spec:
  parentRefs:
    - name: example-gateway
      namespace: gateway-system
  hostnames:
    - "app.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api-service
          port: 8080
```

### Why This Design is Better

The separation might seem like more YAML at first, but it enables:

1. **Role-based access control** - Platform teams manage GatewayClass and Gateway resources, application teams manage Routes
2. **Multi-tenancy** - Multiple teams can attach Routes to shared Gateways without stepping on each other
3. **Portability** - Routes work across different Gateway implementations with minimal changes
4. **Extensibility** - New route types (GRPCRoute, TCPRoute, UDPRoute) can be added without changing the core API

## Comparing Ingress Nginx with Gateway API Concepts

Let's map the concepts you know from ingress-nginx to their Gateway API equivalents:

| Ingress Nginx Concept | Gateway API Equivalent | Notes |
|-----------------------|------------------------|-------|
| IngressClass | GatewayClass | Defines which controller handles resources |
| Ingress Controller (deployment) | Gateway | The actual proxy/load balancer |
| Ingress resource | HTTPRoute, GRPCRoute, TCPRoute, etc. | Routing rules |
| `nginx.ingress.kubernetes.io/*` annotations | Route filters, Policy resources | Native API instead of annotations |
| TLS secret reference | Gateway listener TLS config | Cleaner TLS configuration |
| Rewrite rules | HTTPRoute URLRewrite filter | Built into the API |
| Rate limiting annotations | BackendTrafficPolicy (impl-specific) | Varies by implementation |
| Custom NGINX snippets | Implementation-specific CRDs | No direct equivalent |

### What's Harder in Gateway API

Let's be honest - some things that were easy with annotations are more verbose in Gateway API:

- **Simple redirects** require explicit filter configuration
- **Custom headers** need RequestHeaderModifier filters
- **Implementation-specific features** may require additional CRDs

### What's Easier in Gateway API

- **Traffic splitting** is a first-class feature
- **Header-based routing** just works
- **Cross-namespace routing** has clear permission models
- **Multi-protocol gateways** are straightforward

## Converting from Ingress Nginx to Gateway API

You have two approaches: manual conversion or using a migration tool.

### Manual Conversion

For smaller deployments or when you want precise control, manual conversion is straightforward. Here's a typical ingress-nginx resource and its Gateway API equivalent:

**Before (Ingress):**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

**After (Gateway API):**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
  namespace: gateway-system
spec:
  gatewayClassName: <your-implementation>
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: app.example.com
      tls:
        mode: Terminate
        certificateRefs:
          - name: app-tls
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-app
spec:
  parentRefs:
    - name: my-gateway
      namespace: gateway-system
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: api-service
          port: 8080
```

### Using ingress2gateway

For larger deployments, the [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway) tool can automate much of the conversion:

```bash
# Install ingress2gateway
go install github.com/kubernetes-sigs/ingress2gateway@latest

# Convert all Ingress resources in a namespace
kubectl get ingress -n my-namespace -o yaml | ingress2gateway print

# Convert and apply directly
kubectl get ingress -n my-namespace -o yaml | ingress2gateway print | kubectl apply -f -
```

**Caveats with ingress2gateway:**
- Doesn't handle all annotations (especially custom snippets)
- May require manual adjustment for complex configurations
- Review output before applying - don't blindly trust automated conversion

## Choosing Your Gateway API Implementation

Here's where the real decision-making happens. You have several excellent options, each with different strengths.

### Implementation Comparison

| Feature | Traefik | NGINX Gateway Fabric | Envoy Gateway | Istio Gateway |
|---------|---------|---------------------|---------------|---------------|
| Maturity | High | Medium | Medium | High |
| Gateway API Conformance | Full | Partial | Full | Full |
| gRPC Support | Yes | Yes | Yes | Yes |
| UDP Routes | Yes | No | Yes | Yes |
| Learning Curve | Low | Low (if coming from NGINX) | Medium | High |
| Additional Features | Middleware, Let's Encrypt | NGINX familiarity | Envoy ecosystem | Full service mesh |
| Resource Overhead | Low | Low | Medium | High |

### Traefik

[Traefik](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/providers/kubernetes/kubernetes-gateway/) is an excellent choice if you want a straightforward migration path with minimal operational overhead.

**Pros:**
- Full Gateway API conformance
- Automatic Let's Encrypt certificate management
- Excellent dashboard for debugging
- Low resource footprint
- Active community and commercial support

**Cons:**
- Different mental model from NGINX
- Middleware configuration is Traefik-specific

**Installation:**
```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --set "providers.kubernetesGateway.enabled=true"
```

<!-- TODO: Add your Traefik sample configuration here -->

### NGINX Gateway Fabric

[NGINX Gateway Fabric](https://docs.nginx.com/nginx-gateway-fabric/) is the official NGINX-backed Gateway API implementation. If your team is comfortable with NGINX concepts, this might be the smoothest transition.

**Pros:**
- Familiar NGINX under the hood
- Backed by F5/NGINX Inc.
- Good documentation
- Lower learning curve for NGINX users

**Cons:**
- [Doesn't support UDPRoute](https://docs.nginx.com/nginx-gateway-fabric/overview/gateway-api-compatibility/)
- Newer project, still maturing
- Some advanced features require NGINX Plus

**Installation:**
```bash
kubectl apply -f https://github.com/nginx/nginx-gateway-fabric/releases/download/v1.5.0/crds.yaml
kubectl apply -f https://github.com/nginx/nginx-gateway-fabric/releases/download/v1.5.0/nginx-gateway.yaml
```

**Important Note:** If you're using UDP services with ingress-nginx, NGINX Gateway Fabric is not a direct replacement. You'll need to choose a different implementation or maintain a separate solution for UDP traffic.

<!-- TODO: Add your NGINX Gateway Fabric sample configuration here -->

### Envoy Gateway

[Envoy Gateway](https://gateway.envoyproxy.io/) brings the power of Envoy proxy with a focus on simplicity and Gateway API compliance.

**Pros:**
- Full Gateway API conformance
- Envoy's battle-tested data plane
- Excellent observability out of the box
- Strong community backing (CNCF)

**Cons:**
- Envoy configuration can be complex to debug
- Slightly higher resource usage
- Younger project

**Installation:**
```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace
```

<!-- TODO: Add your Envoy Gateway sample configuration here -->

### Istio Gateway

[Istio](https://istio.io/latest/docs/tasks/traffic-management/ingress/gateway-api/) provides Gateway API support as part of its service mesh functionality. Choose this if you're already using Istio or plan to adopt service mesh capabilities.

**Pros:**
- Full Gateway API support
- Integrated with Istio service mesh features (mTLS, observability, traffic management)
- Mature, battle-tested in production
- Extensive feature set

**Cons:**
- Significant operational complexity
- Higher resource overhead
- Overkill if you just need ingress
- Steeper learning curve

**Installation:**
```bash
# Install Istio with Gateway API support
istioctl install --set profile=minimal
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml
```

<!-- TODO: Add your Istio Gateway sample configuration here -->

### My Recommendation

For most teams migrating from ingress-nginx:

1. **Start with Traefik** if you want the easiest path forward with minimal operational overhead
2. **Choose NGINX Gateway Fabric** if your team knows NGINX well and you don't need UDP routes
3. **Pick Envoy Gateway** if you want strong Envoy ecosystem integration and full conformance
4. **Go with Istio** only if you're already invested in service mesh or have specific requirements that justify the complexity

## Step-by-Step Migration Tutorial

Let's walk through a complete migration from ingress-nginx to Gateway API using [PLACEHOLDER: chosen implementation]. This tutorial assumes you have a working Kubernetes cluster with ingress-nginx currently deployed.

### Prerequisites

- Kubernetes cluster (1.26+)
- kubectl configured
- Helm 3.x installed
- Existing ingress-nginx deployment

### Step 1: Audit Your Current Ingress Configuration

First, let's see what we're working with:

```bash
# List all Ingress resources
kubectl get ingress --all-namespaces

# Export all Ingress resources for analysis
kubectl get ingress --all-namespaces -o yaml > current-ingress.yaml

# Check for annotation usage
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[].metadata.annotations | keys[]' | \
  sort | uniq -c | sort -rn
```

Document any custom annotations, snippets, or ConfigMap customizations you're using.

### Step 2: Install Gateway API CRDs

```bash
# Install Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Verify CRDs are installed
kubectl get crds | grep gateway
```

### Step 3: Deploy Your Chosen Gateway Implementation

<!-- TODO: Add specific installation steps for your chosen implementation -->

```bash
# [PLACEHOLDER: Installation commands]
```

### Step 4: Create Your Gateway Resource

<!-- TODO: Add your Gateway resource configuration -->

```yaml
# [PLACEHOLDER: Gateway configuration]
```

### Step 5: Convert Your Routes

<!-- TODO: Add HTTPRoute examples -->

```yaml
# [PLACEHOLDER: HTTPRoute configuration]
```

### Step 6: Test the New Configuration

```bash
# Test HTTP endpoint
curl -v http://your-gateway-ip/api/health

# Test HTTPS endpoint
curl -v https://app.example.com/api/health

# Test with specific headers
curl -v -H "X-Custom-Header: test" https://app.example.com/api/test
```

### Step 7: Verify gRPC (if applicable)

<!-- TODO: Add gRPC testing examples -->

```bash
# Test gRPC endpoint
grpcurl -plaintext your-gateway-ip:443 list
```

### Step 8: Migrate Traffic

Once testing is complete, you can migrate traffic:

**Option A: DNS Cutover**
1. Update DNS to point to the new Gateway's external IP
2. Monitor for errors
3. Roll back DNS if issues arise

**Option B: Gradual Migration with Traffic Splitting**
If both controllers are running, use weighted DNS or an external load balancer to gradually shift traffic.

### Step 9: Decommission ingress-nginx

After successful migration:

```bash
# Remove ingress-nginx
helm uninstall ingress-nginx -n ingress-nginx

# Clean up old Ingress resources (optional, after verification)
kubectl delete ingress --all-namespaces --all
```

## Complete Working Example

Here's a complete example demonstrating HTTP routing, TLS termination, and path-based routing with [PLACEHOLDER: chosen implementation].

<!-- TODO: Add complete working example with all resources -->

```yaml
# [PLACEHOLDER: Complete example configuration]
```

### Testing the Example

```bash
# Deploy the example
kubectl apply -f example-gateway-setup.yaml

# Get the Gateway IP
export GATEWAY_IP=$(kubectl get gateway example-gateway -o jsonpath='{.status.addresses[0].value}')

# Test the frontend
curl http://$GATEWAY_IP/
# Expected: Response from frontend-service

# Test the API
curl http://$GATEWAY_IP/api/health
# Expected: Response from api-service

# Test with HTTPS
curl -k https://$GATEWAY_IP/api/health
# Expected: Same response, over HTTPS
```

## Troubleshooting Common Issues

### Route Not Attaching to Gateway

**Symptom:** HTTPRoute exists but traffic isn't being routed.

**Check:**
```bash
kubectl describe httproute my-route
```

Look for conditions in the status. Common issues:
- `parentRef` namespace doesn't match Gateway namespace
- Gateway listener doesn't accept routes from the Route's namespace
- Hostname doesn't match Gateway listener

### TLS Certificate Not Working

**Symptom:** HTTPS connections fail or show wrong certificate.

**Check:**
- Secret exists in the correct namespace
- Secret is type `kubernetes.io/tls`
- Gateway has permission to reference the secret (ReferenceGrant if cross-namespace)

### 404 Errors

**Symptom:** All requests return 404.

**Check:**
- Path matching type (Exact vs PathPrefix)
- Hostname matching
- Backend service exists and has endpoints

### Gateway Stuck in "Pending"

**Symptom:** Gateway never gets an external IP.

**Check:**
- GatewayClass exists and is accepted
- LoadBalancer service is being created
- Cloud provider quotas/limits

## Summary

Migrating from ingress-nginx to Gateway API is not optional - the retirement timeline is real and the clock is ticking. But this migration is also an opportunity to adopt a cleaner, more powerful API for managing ingress traffic.

**Key takeaways:**

1. **Audit your current setup** before starting migration
2. **Choose an implementation** that matches your team's expertise and requirements
3. **Test thoroughly** before cutting over production traffic
4. **Don't wait** - start planning and testing now

The Gateway API ecosystem is mature enough for production use. The tooling exists, the documentation is solid, and the community is active. You've got this.

## Resources

- [Official ingress-nginx Retirement Announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [Gateway API Documentation](https://gateway-api.sigs.k8s.io/)
- [Gateway API Guides](https://gateway-api.sigs.k8s.io/guides/)
- [ingress2gateway Tool](https://github.com/kubernetes-sigs/ingress2gateway)
- [Kubernetes Ingress Controllers List](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [Traefik Kubernetes Gateway Provider](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/providers/kubernetes/kubernetes-gateway/)
- [NGINX Gateway Fabric](https://docs.nginx.com/nginx-gateway-fabric/)
- [NGINX Gateway Fabric API Compatibility](https://docs.nginx.com/nginx-gateway-fabric/overview/gateway-api-compatibility/)
- [Envoy Gateway](https://gateway.envoyproxy.io/)
- [Istio Gateway API Support](https://istio.io/latest/docs/tasks/traffic-management/ingress/gateway-api/)
