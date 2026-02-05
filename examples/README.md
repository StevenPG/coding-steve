# Gateway API Test Examples

Companion examples for the blog post **"Guide to Migrating From Retired Ingress Nginx."**

These examples demonstrate four Gateway API implementations routing traffic to a shared
httpbin echo server. Each implementation is self-contained and independently testable.
They should **not** run concurrently -- test one at a time and teardown before moving to the next.

## Directory Structure

```
examples/
  common/httpbin.yaml              # Shared httpbin Deployment + Service
  traefik/                         # Traefik Gateway API implementation
  nginx-gateway-fabric/            # NGINX Gateway Fabric implementation
  envoy-gateway/                   # Envoy Gateway implementation
  istio/                           # Istio Gateway implementation
```

Each implementation folder contains:
- `gateway.yaml` -- GatewayClass (if needed) and Gateway resource
- `httproutes.yaml` -- Three HTTPRoute examples demonstrating different routing patterns

## What the HTTPRoutes Demonstrate

All four implementations test the same three routing patterns:

| Route | Match | Rewrite | Tests |
|-------|-------|---------|-------|
| `httpbin-get` | Exact `/api/get` | -> `/get` | Exact path match + full path rewrite |
| `httpbin-anything` | Prefix `/api/anything` | -> `/anything` | Prefix match + prefix rewrite |
| `httpbin-header-canary` | Header `X-Test-Route: canary` + Prefix `/api` | -> `/headers` | Header-based routing |

The HTTPRoute YAML is nearly identical across implementations -- only `parentRefs` differs.
This demonstrates Gateway API's portability promise.

## Prerequisites

- A local Kubernetes cluster: [kind](https://kind.sigs.k8s.io/) (recommended) or minikube
- `kubectl` v1.26+
- [Helm](https://helm.sh/) 3.x
- `curl` (for testing)

### Create a kind Cluster

```bash
kind create cluster --name gateway-test
```

### Install Gateway API CRDs

All four implementations require the Gateway API CRDs:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml
```

Verify:

```bash
kubectl get crds | grep gateway
# Expected: gatewayclasses, gateways, httproutes, referencegrants
```

## Deploy the Test Application

Deploy httpbin (shared across all implementations):

```bash
kubectl apply -f common/httpbin.yaml
```

Verify the pod is running:

```bash
kubectl get pods -l app=httpbin
# NAME                       READY   STATUS    RESTARTS   AGE
# httpbin-xxxxxxxxxx-xxxxx   1/1     Running   0          30s

kubectl get svc httpbin
# NAME      TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)   AGE
# httpbin   ClusterIP   10.96.xxx.xxx   <none>        80/TCP    30s
```

---

## Implementation 1: Traefik

### Install Traefik

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --set "providers.kubernetesGateway.enabled=true"
```

Wait for the controller to be ready:

```bash
kubectl wait --timeout=2m -n traefik deployment/traefik --for=condition=Available
```

Verify the GatewayClass was created:

```bash
kubectl get gatewayclass
# NAME      CONTROLLER                      ACCEPTED
# traefik   traefik.io/gateway-controller   True
```

### Deploy Gateway Resources

```bash
kubectl apply -f traefik/gateway.yaml
kubectl apply -f traefik/httproutes.yaml
```

Verify:

```bash
kubectl get gateway traefik-gateway
kubectl get httproute
```

### Test with Port-Forward

```bash
# Start port-forward in the background
kubectl port-forward -n traefik svc/traefik 8080:80 &

# Exact path routing
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/get | head -20
# Expected: JSON response from httpbin /get endpoint

# Path prefix matching
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/anything/hello
# Expected: JSON response from httpbin /anything/hello endpoint

# Header-based routing
curl -s -H "Host: httpbin.example.com" -H "X-Test-Route: canary" http://localhost:8080/api/headers
# Expected: JSON response from httpbin /headers, showing your custom header

# Stop port-forward
kill %1
```

### Teardown Traefik

```bash
kubectl delete -f traefik/httproutes.yaml
kubectl delete -f traefik/gateway.yaml
helm uninstall traefik -n traefik
kubectl delete namespace traefik
```

---

## Implementation 2: NGINX Gateway Fabric

### Install NGINX Gateway Fabric

```bash
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --version 2.4.0 \
  --wait
```

Verify the GatewayClass was created:

```bash
kubectl get gatewayclass
# NAME    CONTROLLER                                   ACCEPTED
# nginx   gateway.nginx.org/nginx-gateway-controller   True
```

### Deploy Gateway Resources

```bash
kubectl apply -f nginx-gateway-fabric/gateway.yaml
kubectl apply -f nginx-gateway-fabric/httproutes.yaml
```

Verify:

```bash
kubectl get gateway ngf-gateway
kubectl get httproute
```

### Test with Port-Forward

The NGINX Gateway Fabric creates a service for the gateway. Find it:

```bash
kubectl get svc -n nginx-gateway
# Look for the service associated with your gateway
```

```bash
# Port-forward to the NGF service (adjust service name if needed)
kubectl port-forward -n nginx-gateway svc/ngf-nginx-gateway-fabric 8080:80 &

# Exact path routing
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/get | head -20

# Path prefix matching
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/anything/hello

# Header-based routing
curl -s -H "Host: httpbin.example.com" -H "X-Test-Route: canary" http://localhost:8080/api/headers

# Stop port-forward
kill %1
```

### Teardown NGINX Gateway Fabric

```bash
kubectl delete -f nginx-gateway-fabric/httproutes.yaml
kubectl delete -f nginx-gateway-fabric/gateway.yaml
helm uninstall ngf -n nginx-gateway
kubectl delete namespace nginx-gateway
```

---

## Implementation 3: Envoy Gateway

### Install Envoy Gateway

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.6.3 \
  --namespace envoy-gateway-system \
  --create-namespace

kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available
```

### Deploy Gateway Resources

Note: Envoy Gateway requires an explicit GatewayClass (included in `gateway.yaml`).
The Gateway lives in the `envoy-gateway-system` namespace, and the HTTPRoutes
reference it cross-namespace via `parentRefs.namespace`.

```bash
kubectl apply -f envoy-gateway/gateway.yaml
kubectl apply -f envoy-gateway/httproutes.yaml
```

Wait for the gateway to be programmed:

```bash
kubectl wait --timeout=2m -n envoy-gateway-system \
  gateway/eg-gateway --for=condition=Programmed
```

Verify:

```bash
kubectl get gateway -n envoy-gateway-system eg-gateway
kubectl get httproute
```

### Test with Port-Forward

Envoy Gateway auto-provisions a service for the gateway. Find it:

```bash
kubectl get svc -n envoy-gateway-system
# Look for a service matching your gateway name
```

```bash
# Port-forward (adjust service name based on kubectl get svc output above)
kubectl port-forward -n envoy-gateway-system \
  svc/envoy-envoy-gateway-system-eg-gateway-http 8080:80 &

# Exact path routing
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/get | head -20

# Path prefix matching
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/anything/hello

# Header-based routing
curl -s -H "Host: httpbin.example.com" -H "X-Test-Route: canary" http://localhost:8080/api/headers

# Stop port-forward
kill %1
```

### Teardown Envoy Gateway

```bash
kubectl delete -f envoy-gateway/httproutes.yaml
kubectl delete -f envoy-gateway/gateway.yaml
helm uninstall eg -n envoy-gateway-system
kubectl delete namespace envoy-gateway-system
```

---

## Implementation 4: Istio Gateway

### Install Istio

```bash
helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

# Install Istio base (CRDs)
helm install istio-base istio/base \
  --namespace istio-system \
  --create-namespace \
  --wait

# Install istiod (control plane)
helm install istiod istio/istiod \
  --namespace istio-system \
  --wait
```

Verify the GatewayClass was created:

```bash
kubectl get gatewayclass
# NAME    CONTROLLER                    ACCEPTED
# istio   istio.io/gateway-controller   True
```

### Deploy Gateway Resources

Istio will auto-provision a Deployment and Service for the Gateway resource.

```bash
kubectl apply -f istio/gateway.yaml
kubectl apply -f istio/httproutes.yaml
```

Wait for the gateway to be programmed:

```bash
kubectl wait --timeout=2m gateway/istio-gateway --for=condition=Programmed
```

Verify:

```bash
kubectl get gateway istio-gateway
kubectl get httproute

# Check the auto-provisioned service
kubectl get svc
# Look for istio-gateway-istio (pattern: <gateway-name>-<gatewayclass-name>)
```

### Test with Port-Forward

```bash
# Port-forward to the auto-provisioned service
kubectl port-forward svc/istio-gateway-istio 8080:80 &

# Exact path routing
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/get | head -20

# Path prefix matching
curl -s -H "Host: httpbin.example.com" http://localhost:8080/api/anything/hello

# Header-based routing
curl -s -H "Host: httpbin.example.com" -H "X-Test-Route: canary" http://localhost:8080/api/headers

# Stop port-forward
kill %1
```

### Teardown Istio

```bash
kubectl delete -f istio/httproutes.yaml
kubectl delete -f istio/gateway.yaml
helm uninstall istiod -n istio-system
helm uninstall istio-base -n istio-system
kubectl delete namespace istio-system
```

---

## Full Cleanup

Remove the test application and Gateway API CRDs:

```bash
kubectl delete -f common/httpbin.yaml
kubectl delete -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml
```

Or just delete the entire kind cluster:

```bash
kind delete cluster --name gateway-test
```

---

## Troubleshooting

### Gateway Stuck in "Pending" / Never Gets an Address

On kind/minikube, Gateways will not get an external IP. This is expected -- use port-forward.

```bash
kubectl describe gateway <name>
# Check the status conditions for errors
```

### HTTPRoute Not Routing Traffic (404)

1. Verify `parentRefs.name` matches the Gateway name exactly
2. Verify the Gateway listener allows routes from the HTTPRoute's namespace
3. Check the HTTPRoute status:

```bash
kubectl describe httproute <name>
# Look for "Accepted" and "ResolvedRefs" conditions
```

### httpbin Pod Not Running

```bash
kubectl get pods -l app=httpbin
kubectl describe pod -l app=httpbin
kubectl logs -l app=httpbin
```

Common issues:
- Image pull failure -- ensure `kong/httpbin` is accessible
- Readiness probe failing -- wait a few seconds for startup

### Port-Forward Already in Use

```bash
# Kill existing port-forward
kill %1

# Or use a different local port
kubectl port-forward ... 9090:80
```

### Service Name Mismatch for Port-Forward

Each implementation creates services with different naming conventions. If the documented service name doesn't work:

```bash
# List all services to find the right one
kubectl get svc --all-namespaces | grep -i gateway
```
