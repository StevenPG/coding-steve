---
author: StevenPG
pubDatetime: 2025-11-15T12:00:00.000Z
title: Convert Nginx Ingress to Gateway API with Traefik
slug: convert-nginx-ingress-gateway-api-traefik
featured: true
draft: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - devops
description: With Nginx Ingress being retired, users need to move to the new Gateway API using an available implementation. For this post, we're migrating to Traefik!
---
# Converting from Nginx Ingress to Traefik: Navigating the Gateway API Migration

## Table of Contents

- [What is Ingress Nginx](#what-is-ingress-nginx-and-how-am-i-using-it)
- [Why is it Being Retired/What Does it Being Retired Mean](#why-is-it-being-retiredwhat-does-it-being-retired-mean)
- [What is the Gateway API](#what-is-the-gateway-api)
- [Comparing Nginx Ingress Concepts with Gateway API Concepts](#comparing-nginx-ingress-concepts-with-gateway-api-concepts)
- [Converting from Nginx Ingress to Gateway Manually](#converting-from-nginx-ingress-to-gateway-manually)
- [Converting Using a Tool like ingress2gateway](#converting-using-a-tool-like-ingress2gateway)
- [What to Choose: Comparing Implementations and Choosing Traefik](#what-to-choose-comparing-implementations-and-choosing-traefik)
- [Example Kubernetes Cluster with Real-World Examples](#example-kubernetes-cluster-with-real-world-examples)

## What is Ingress Nginx

For years, Ingress Nginx has been the go-to solution for managing HTTP and HTTPS routing in Kubernetes clusters. If you're like me, you've probably been using it to expose services to the outside world, handle SSL termination, and manage traffic routing based on hostnames and paths.

In my current setup, I've been relying on Ingress Nginx for:

- **SSL/TLS termination** with automatic certificate management via cert-manager
- **Path-based routing** to different microservices
- **Host-based routing** for multi-tenant applications
- **Load balancing** across multiple pods
- **Rate limiting and basic authentication** for API endpoints

A typical Ingress resource in my cluster looks something like this:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rate-limit: "100"
spec:
  tls:
  - hosts:
    - api.myapp.com
    secretName: api-tls
  rules:
  - host: api.myapp.com
    http:
      paths:
      - path: /api/v1
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
```

It's been reliable, well-documented, and has served me well. But times are changing.

## Why is it Being Retired/What Does it Being Retired Mean

The Kubernetes community announced in November 2024 that **Ingress Nginx will be retired in March 2026**. This doesn't mean it stops working overnight, but it does mean:

- **No new features** will be developed after March 2026
- **Security patches and bug fixes** will continue for a limited time
- **Community support** will gradually decline
- **Cloud providers** will eventually phase out managed Ingress Nginx offerings

The retirement is driven by the maturation of the **Gateway API**, which provides a more flexible, extensible, and role-oriented approach to traffic management in Kubernetes. The Ingress API, while functional, has limitations:

- **Limited expressiveness** for complex routing scenarios
- **Annotation-heavy configuration** that varies between implementations
- **Single resource type** that handles multiple concerns
- **Lack of clear separation** between infrastructure and application concerns

The Gateway API addresses these limitations with a more modern, structured approach that better reflects how traffic management works in practice.

## What is the Gateway API

The Gateway API is the next-generation standard for service networking in Kubernetes. Think of it as "Ingress 2.0" - it provides the same core functionality but with a much more flexible and expressive model.

Key concepts in the Gateway API:

### GatewayClass
Defines the type of Gateway (like nginx, traefik, istio). This is similar to the old `kubernetes.io/ingress.class` annotation but as a proper resource.

### Gateway
Represents the actual load balancer/proxy instance. This is where you configure listeners (ports, protocols, TLS).

### HTTPRoute
Defines routing rules for HTTP traffic. This replaces the `spec.rules` section of Ingress resources.

### ReferenceGrant
Allows cross-namespace references for security.

The Gateway API follows a **role-oriented** design:

- **Infrastructure providers** manage GatewayClass and Gateway resources
- **Cluster operators** configure Gateways
- **Application developers** create Routes

This separation of concerns makes it much clearer who is responsible for what, and allows for better security boundaries.

## Comparing Nginx Ingress Concepts with Gateway API Concepts

Let me break down how the familiar Nginx Ingress concepts map to the Gateway API:

| Nginx Ingress | Gateway API | Description |
|---------------|-------------|-------------|
| IngressClass | GatewayClass | Defines the controller implementation |
| Ingress | HTTPRoute + Gateway | Routing rules + load balancer config |
| `spec.tls` | Gateway listeners | TLS termination configuration |
| `spec.rules[].host` | HTTPRoute hostname matching | Host-based routing |
| `spec.rules[].http.paths[]` | HTTPRoute path matching | Path-based routing |
| Annotations | Native fields | Configuration options |

Here's a side-by-side comparison of the same routing configuration:

**Nginx Ingress approach:**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: api.myapp.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
```

**Gateway API approach:**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-app-route
spec:
  parentRefs:
  - name: my-gateway
  hostnames:
  - api.myapp.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: api-service
      port: 8080
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /
```

The Gateway API version is more verbose but also more explicit and flexible.

## Converting from Nginx Ingress to Gateway Manually

Converting manually gives you full control over the migration process. Here's my step-by-step approach:

### Step 1: Install a Gateway API Controller

First, choose and install a Gateway API-compatible controller. For this example, I'll use Traefik:

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --set experimental.gatewayAPI.enabled=true
```

### Step 2: Create a GatewayClass

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: traefik
spec:
  controllerName: traefik.io/gateway-controller
```

### Step 3: Convert Your Ingress to Gateway + HTTPRoute

Taking my earlier Nginx Ingress example, here's the conversion:

**Gateway resource:**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
spec:
  gatewayClassName: traefik
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
      - name: api-tls
```

**HTTPRoute resource:**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-app-route
spec:
  parentRefs:
  - name: my-gateway
  hostnames:
  - api.myapp.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
    backendRefs:
    - name: api-service
      port: 8080
```

### Step 4: Test and Validate

Before removing the old Ingress, test the new Gateway API resources:

```bash
kubectl get gateway
kubectl get httproute
kubectl describe httproute my-app-route
```

## Converting Using a Tool like ingress2gateway

For complex setups with many Ingress resources, manual conversion can be tedious. The `ingress2gateway` tool automates much of this process:

### Installation

```bash
go install sigs.k8s.io/ingress2gateway@latest
```

### Basic Usage

```bash
# Convert all Ingress resources in current namespace
ingress2gateway print

# Convert specific Ingress
kubectl get ingress my-app-ingress -o yaml | ingress2gateway print

# Output to file
ingress2gateway print > gateway-resources.yaml
```

### Advanced Usage with Provider-Specific Options

```bash
# Convert with specific Gateway API features
ingress2gateway print \
  --gateway-class-name=traefik \
  --gateway-name=my-gateway \
  --providers=traefik
```

The tool handles most common scenarios but may require manual tweaking for complex annotations or provider-specific features.

## What to Choose: Comparing Implementations and Choosing Traefik

When migrating from Nginx Ingress, you have several Gateway API implementations to choose from:

### Available Options

1. **Traefik** - Feature-rich, great for complex routing
2. **Istio Gateway** - Service mesh integration, advanced traffic management
3. **Nginx Gateway Fabric** - NGINX's official Gateway API implementation
4. **Envoy Gateway** - Envoy-based, CNCF project
5. **Kong Gateway** - API management focused

### Why I Chose Traefik

After evaluating the options, I settled on Traefik for several reasons:

**Pros:**
- **Excellent Gateway API support** with frequent updates
- **Automatic service discovery** reduces configuration overhead
- **Built-in dashboard** for monitoring and debugging
- **Rich middleware ecosystem** for auth, rate limiting, etc.
- **Strong community** and documentation
- **UDP routing support** (unlike Nginx Gateway Fabric currently)

**Considerations:**
- Learning curve if coming from pure Nginx
- Resource usage can be higher than nginx

### Traefik Gateway API Configuration

Here's how to set up Traefik with Gateway API support:

```yaml
# values.yaml for Helm installation
experimental:
  gatewayAPI:
    enabled: true
providers:
  kubernetesGateway:
    enabled: true
service:
  type: LoadBalancer
```

Install with:

```bash
helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --values values.yaml
```

## Example Kubernetes Cluster with Real-World Examples

Let me show you a complete working example that demonstrates various Gateway API features with Traefik.

### Complete Setup

**1. GatewayClass and Gateway:**

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: traefik
spec:
  controllerName: traefik.io/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: main-gateway
spec:
  gatewayClassName: traefik
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
      - name: wildcard-tls
```

**2. Sample Applications:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-v1
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api-v1
  template:
    metadata:
      labels:
        app: api-v1
    spec:
      containers:
      - name: api
        image: nginx:alpine
        ports:
        - containerPort: 80
        volumeMounts:
        - name: config
          mountPath: /usr/share/nginx/html
      volumes:
      - name: config
        configMap:
          name: api-v1-config
---
apiVersion: v1
kind: Service
metadata:
  name: api-v1-service
spec:
  selector:
    app: api-v1
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-v1-config
data:
  index.html: |
    {"version": "v1", "message": "Hello from API v1"}
```

**3. HTTPRoutes with Advanced Routing:**

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
spec:
  parentRefs:
  - name: main-gateway
  hostnames:
  - api.example.com
  rules:
  # API v1 with rate limiting
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
    - headers:
      - name: X-API-Version
        value: v1
    backendRefs:
    - name: api-v1-service
      port: 80
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /
  
  # Health check endpoint
  - matches:
    - path:
        type: Exact
        value: /health
    backendRefs:
    - name: api-v1-service
      port: 80
    filters:
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: X-Health-Check
          value: "true"
```

**4. GRPC Route Example:**

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: GRPCRoute
metadata:
  name: grpc-api
spec:
  parentRefs:
  - name: main-gateway
  hostnames:
  - grpc.example.com
  rules:
  - matches:
    - method:
        service: user.UserService
        method: GetUser
    backendRefs:
    - name: grpc-service
      port: 9090
```

### Testing the Setup

**HTTP API Tests:**

```bash
# Basic API call
curl -H "Host: api.example.com" http://localhost/api/v1
# {"version": "v1", "message": "Hello from API v1"}

# Header-based routing
curl -H "Host: api.example.com" \
     -H "X-API-Version: v1" \
     http://localhost/api/v1
     
# Health check
curl -H "Host: api.example.com" http://localhost/health
```

**GRPC Tests:**

```bash
# Using grpcurl
grpcurl -H "host: grpc.example.com" \
        -plaintext localhost:443 \
        user.UserService/GetUser
```

**Monitoring and Debugging:**

Traefik provides an excellent dashboard for monitoring your Gateway API resources:

```bash
# Port forward to access dashboard
kubectl port-forward -n traefik svc/traefik 9000:9000

# Access dashboard at http://localhost:9000
```

The dashboard shows:
- Gateway status and listeners
- HTTPRoute configurations
- Backend service health
- Real-time traffic metrics
- Error rates and response times

### Migration Validation

To ensure your migration was successful, verify:

1. **All routes are working** - Test each endpoint
2. **SSL certificates** are properly configured
3. **Performance metrics** match or exceed previous setup
4. **Monitoring and logging** are functioning
5. **Cleanup old resources** once confident in the new setup

```bash
# Remove old Ingress resources
kubectl delete ingress my-app-ingress

# Verify Gateway API resources
kubectl get gatewayclass,gateway,httproute
```

## Conclusion

Migrating from Nginx Ingress to the Gateway API with Traefik has been a positive experience overall. While it requires some initial learning and setup time, the benefits are clear:

- **More expressive routing rules** without annotation hell
- **Better separation of concerns** between infrastructure and applications
- **Future-proof architecture** aligned with Kubernetes' direction
- **Enhanced observability** and debugging capabilities

The March 2026 retirement timeline gives us plenty of time to plan and execute the migration thoughtfully. Whether you choose to migrate manually for full control or use automated tools like `ingress2gateway`, the key is to start planning now and test thoroughly.

For my infrastructure, Traefik has proven to be an excellent choice, offering the flexibility and features needed for modern service networking while maintaining the simplicity that made Nginx Ingress so popular.

The Gateway API represents the future of service networking in Kubernetes, and embracing it now positions your infrastructure for continued success in the cloud-native ecosystem.
