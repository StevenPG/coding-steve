---
author: StevenPG
pubDatetime: 2026-08-29T12:00:00.000Z
title: "Autoscaling Kubernetes on Prometheus Metrics with KEDA (Not CPU)"
slug: kubernetes-autoscaling-prometheus-keda
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - kubernetes
  - keda
  - autoscaling
  - prometheus
  - observability
  - performance
description: CPU-based autoscaling is a proxy for the thing you actually care about. Here's how to scale a Spring Boot service on real Prometheus metrics with KEDA — including the load-testing methodology to derive your threshold instead of guessing it.
---

# Autoscaling Kubernetes on Prometheus Metrics with KEDA (Not CPU)

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This one picks up where [Spring Boot + Prometheus + Grafana](/posts/spring-boot-prometheus-grafana) left off: you have metrics, you have dashboards, and now you want the cluster to *act* on them.

Almost every Kubernetes autoscaling tutorial ends at `targetCPUUtilizationPercentage: 80`. That works, in the sense that a smoke detector works when you point it at a candle. It fires on a signal that is *correlated* with the thing you care about, at a delay, with a correlation that quietly breaks the moment your service becomes I/O bound, gets a thread-pool change, or moves to a different instance type.

This post covers the alternative: scaling on the metrics you already collect, with [KEDA](https://keda.sh/), and — the part nobody writes down — how to derive the threshold number from an actual load test instead of picking a round number and hoping.

## Why CPU Is the Wrong Signal

Not "bad." Wrong. Specifically:

**Most services aren't CPU bound.** A typical Spring Boot service spends its time waiting: on Postgres, on a downstream HTTP call, on Kafka. Under a traffic spike that saturates a connection pool, latency goes vertical while CPU sits at 30%. The HPA sees a healthy service. Your users see timeouts.

**CPU is a lagging, laundered signal.** Load arrives, queues build, threads block, *then* CPU eventually rises. You're scaling on the echo of the problem.

**The number is unfalsifiable.** Ask why the target is 80% and you'll get "it's the default" or "70 felt too aggressive." Nobody can tell you what 80% CPU means in requests per second, which means nobody can tell you whether the autoscaler will keep up with Black Friday.

**It doesn't survive a code change.** Add a cache and CPU-per-request drops; your 80% target now means twice the traffic per pod. Nothing alerts you that your scaling policy silently changed.

Compare that to scaling on `http_server_requests_seconds_count`: the signal moves the instant traffic moves, it's the same unit your capacity plan uses, and you can state your policy as a sentence a product manager understands — *"we add a pod for every 85 requests per second."*

CPU targets aren't useless, and I still set one. But as a **backstop**, not the primary control loop. More on that later.

## The Mental Model (60 Seconds)

KEDA does not replace the HPA. This is the single most common misconception and it makes everything else confusing until it clicks.

1. You create a **ScaledObject** — a KEDA CRD naming a Deployment and one or more **triggers**.
2. KEDA's operator **creates and owns a real HorizontalPodAutoscaler** for you (named `keda-hpa-<scaledobject-name>`).
3. KEDA runs a **metrics adapter** that serves Kubernetes' External Metrics API. Every `pollingInterval` it runs your PromQL against Prometheus and caches the answer.
4. The HPA asks the metrics API for that value on its own cycle and does the arithmetic it always does.
5. Below the activation threshold, KEDA steps *outside* the HPA and scales the Deployment to zero directly — the HPA can't do zero.

So: KEDA is a *metrics source and an on/off switch* bolted onto the standard HPA. Everything you know about HPA behavior, stabilization windows, and scaling policies still applies, and `kubectl describe hpa` is still your best debugging tool.

## KEDA vs. prometheus-adapter

The older path to custom-metric scaling is [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter): you install it, write cluster-wide discovery rules that translate Prometheus series into custom metrics, and then reference those metrics from a hand-written HPA.

| | KEDA | prometheus-adapter |
|---|---|---|
| Where the query lives | In the ScaledObject, next to the app | In cluster-wide adapter config |
| Who edits it | The team that owns the service | Whoever owns the platform ConfigMap |
| Reload after a change | None | Restart the adapter |
| Scale to zero | Yes | No |
| Multiple/mixed sources | 70+ scalers, combinable | Prometheus only |
| Auth to Prometheus | `TriggerAuthentication` CRD | Adapter-level flags |

The deciding factor for me is the first row. With prometheus-adapter, adding a scaling rule for one service means a pull request against a shared ConfigMap and an adapter restart that touches every autoscaler in the cluster. With KEDA, the scaling policy lives in the service's own manifests, gets reviewed by the people who own the service, and takes effect on apply.

prometheus-adapter is still a reasonable choice if you're already running it happily and don't need scale-to-zero. For everything else, KEDA (a CNCF graduated project) is the current default answer.

## Step 1: Make the App Emit Something Worth Scaling On

Two dependencies, per the [earlier post](/posts/spring-boot-prometheus-grafana):

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")
}
```

Then the config that matters for autoscaling:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  metrics:
    tags:
      application: ${spring.application.name}
  observations:
    key-values:
      application: ${spring.application.name}
  prometheus:
    metrics:
      export:
        step: 15s
```

`http_server_requests_seconds_count` exists out of the box — that's your RPS signal, and it's enough to start.

If you also want latency (you will, as a guardrail), you need bucket data. Percentile *summaries* can't be aggregated across pods, so ask for a histogram:

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 100ms,250ms,500ms,1s,2s
```

`percentiles-histogram: true` emits `http_server_requests_seconds_bucket`, which is what `histogram_quantile()` needs. The explicit `slo` list adds buckets at boundaries you care about — quantile estimates are only as good as the nearest bucket edge, so put edges near your SLO. Note that this multiplies your series count per endpoint; if cardinality is a concern, enable it for `http.server.requests` only, not globally.

Make sure `step` and your Prometheus `scrape_interval` agree (15s is a good default for autoscaling — 60s scrapes add a full minute of blindness to your reaction time).

## Step 2: Install KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm upgrade --install keda kedacore/keda \
  --namespace keda --create-namespace \
  --version 2.20.2 \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

Those last two flags export KEDA's *own* metrics. Turn them on now — when a ScaledObject misbehaves at 2am, `keda_scaler_errors_total` and `keda_scaler_metrics_value` are the difference between a diagnosis and a guess.

Verify three deployments come up:

```bash
kubectl get pods -n keda
# keda-operator                        1/1  Running
# keda-operator-metrics-apiserver      1/1  Running
# keda-admission-webhooks              1/1  Running

kubectl get apiservice v1beta1.external.metrics.k8s.io
# NAME                              SERVICE                                  AVAILABLE
# v1beta1.external.metrics.k8s.io   keda/keda-operator-metrics-apiserver     True
```

If that APIService isn't `AVAILABLE`, nothing else in this post will work. It's also worth knowing that only **one** External Metrics API provider can be registered per cluster — if you already run prometheus-adapter with external metrics enabled, they conflict, and you have to pick one.

## Step 3: The First ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: checkout
  namespace: prod
spec:
  scaleTargetRef:
    name: checkout
  minReplicaCount: 3
  maxReplicaCount: 40
  pollingInterval: 15
  cooldownPeriod: 300
  triggers:
    - type: prometheus
      name: rps_per_pod
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc:9090
        query: |
          sum(rate(http_server_requests_seconds_count{
            namespace="prod", service="checkout", uri!~"/actuator.*"
          }[1m]))
        threshold: "85"
```

Apply it and KEDA builds the HPA:

```bash
kubectl get scaledobject,hpa -n prod
# NAME                        SCALETARGETKIND      READY  ACTIVE
# scaledobject.keda.sh/checkout  apps/v1.Deployment   True   True
#
# NAME                             REFERENCE             TARGETS
# horizontalpodautoscaler/keda-hpa-checkout  Deployment/checkout   340/85 (avg)
```

A few things in that YAML are load-bearing:

**`uri!~"/actuator.*"`** — exclude health checks. Kubelet probes every few seconds per pod, so as you scale up, probe traffic scales up with you. Left in, it's a slow positive feedback loop that inflates your own scaling signal.

**`[1m]` rate window** — needs at least two scrapes to produce a value, so it must be ≥ 2× your scrape interval. At a 15s scrape, `[1m]` gives four samples: responsive, but smoothed enough not to chase a single slow scrape. Don't go below `[45s]` on 15s scrapes; you'll get NaN gaps that read as "no load."

**`sum(...)` with no `by`** — the trigger query *must* return a single scalar. A vector with multiple elements is an error, and KEDA will report the ScaledObject as failing rather than scale on a random element.

**`minReplicaCount: 3`** — not 1. See the fallback section; this is also your blast radius when a metric goes wrong.

### The Threshold Semantics That Bite Everyone

Notice the query returns *total* RPS across the whole service, but the threshold is 85 and we said "85 RPS per pod." That's not a mistake, and it's the single most misread part of KEDA.

Triggers default to `metricType: AverageValue`, which means the HPA divides your query result by the current replica count before comparing:

```
desiredReplicas = ceil(currentReplicas × (queryResult / currentReplicas) / threshold)
                = ceil(queryResult / threshold)
```

So with a total-RPS query and `AverageValue`, **the threshold is a per-pod number** and the math works out to exactly what you want: 340 RPS ÷ 85 = 4 pods.

The alternative is `metricType: Value`, where the raw query result is compared to the threshold with no division. That's what you need for any metric that **isn't** additive across pods — a p95 latency, a cache hit ratio, a queue depth you've already normalized. Dividing a p95 by the replica count produces a number with no physical meaning, and it will scale you into the ground.

The rule: **if the metric doubles when traffic doubles at fixed replica count, use `AverageValue`. If it doesn't, use `Value`.** Rates and counts are additive. Percentiles, ratios, and averages are not.

## Step 4: Deriving the Threshold (The Part Everyone Skips)

`threshold: "85"` above is a real number from a real test, and this is the section that makes this post worth writing. The methodology is three steps: **pin one pod, ramp load until it breaks, back off by your headroom factor.**

### Pin One Pod

You're measuring the capacity of a *single* replica, so remove every other variable:

```bash
kubectl annotate scaledobject checkout -n prod autoscaling.keda.sh/paused=true
kubectl scale deployment checkout -n prod --replicas=1
```

That annotation is the right way to freeze things — KEDA stops acting but leaves the ScaledObject in place, so you don't delete and recreate the HPA mid-test. Do this in staging with production-like data volumes; a 10k-row test database will give you a saturation point that's a fantasy.

### Ramp Until It Breaks

The critical choice here is the k6 executor. Use `ramping-arrival-rate`, **not** `ramping-vus`:

```javascript
// load-test.js
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    find_the_knee: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 2000,
      stages: [
        { target: 25,  duration: "2m" },
        { target: 50,  duration: "2m" },
        { target: 75,  duration: "2m" },
        { target: 100, duration: "2m" },
        { target: 125, duration: "2m" },
        { target: 150, duration: "2m" },
        { target: 200, duration: "2m" },
      ],
    },
  },
  thresholds: {
    // Informational: we want to SEE the breach, not abort on it.
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: false }],
  },
};

export default function () {
  const res = http.post(
    `${__ENV.TARGET}/api/checkout`,
    JSON.stringify({ cartId: `cart-${__VU}-${__ITER}` }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, { "status is 2xx": r => r.status >= 200 && r.status < 300 });
}
```

Why arrival rate matters: `ramping-vus` holds *concurrency* constant, so when the service slows down, your load generator politely slows down with it. The offered load drops exactly when you need it to keep climbing, and the saturation point hides. `ramping-arrival-rate` holds *requests per second* constant regardless of how long they take — which is how real traffic behaves. Real users don't throttle themselves because your p95 went up.

Give each stage a flat 2-minute hold. You need enough steady state at each level for JIT to warm, connection pools to settle, and your `[1m]` rate window to actually converge.

```bash
k6 run -e TARGET=https://checkout.staging.internal load-test.js
```

### Read the Knee Off the Graph

While it runs, watch these two in Grafana:

```promql
# Offered load, per pod
sum(rate(http_server_requests_seconds_count{service="checkout", uri!~"/actuator.*"}[1m]))

# p95 latency
histogram_quantile(0.95,
  sum by (le) (rate(http_server_requests_seconds_bucket{service="checkout", uri!~"/actuator.*"}[1m]))
)
```

You're looking for the **knee**: the RPS value where p95 stops being flat and turns upward. Below the knee, added load costs you almost nothing in latency — there's spare capacity in the queues. Above it, each additional request per second costs disproportionately more latency, because you've hit a hard limit somewhere (usually a connection pool or the thread pool, rarely CPU).

Say p95 sits at 90ms flat through 100 RPS, is 130ms at 125, and 400ms at 150. Your knee is around 120 RPS. Take the **last rate that held your SLO**, not the last rate that didn't error — a pod serving 150 RPS at 400ms p95 is "up" and failing.

Also watch CPU during this run. If CPU is at 45% when latency goes vertical, you have just proven, on your own service, why the CPU target was never going to work. That graph is worth screenshotting for the next planning meeting.

### Apply Headroom

Never set the threshold at the knee. Between the metric moving and a new pod serving traffic, you have a lag budget:

| Stage | Typical |
|---|---|
| Prometheus scrape interval | 15s |
| `rate([1m])` window smoothing | ~30s effective |
| KEDA `pollingInterval` | 15s |
| HPA stabilization + sync | 15–60s |
| Pod schedule + image + JVM start + readiness | 30–90s |

That's **roughly two minutes** from "traffic arrives" to "new pod serving." Existing pods absorb everything in that window, so the threshold has to leave room for the spike to grow during it.

```
threshold = knee × headroom_factor
```

Start at **0.7**. With a knee of 120: `120 × 0.7 = 84` → round to **85**. Use 0.5–0.6 for spiky traffic or slow-starting pods (a JVM with a cold code cache is very slow at 0s), and 0.8 for smooth, predictable load with fast startup.

Two ways to buy headroom back other than lowering the threshold: cut startup time (AOT cache, CDS, smaller images, a real readiness probe that doesn't lie), and pre-warm with a `scheduledJob`-style floor before known spikes. Both are cheaper than running at 0.5 all day.

### Re-run It

Put this in CI on a schedule, quarterly at minimum. The knee is a property of your code, and your code changes. When a release moves the knee by 30%, you want a diff, not an incident.

## Step 5: A Second Trigger as a Guardrail

RPS is the right primary signal, but it assumes every request costs the same. When a downstream dependency degrades, RPS stays flat while your pods fill up with blocked threads. So add latency as a *guardrail* — a trigger that only fires when something is wrong.

```yaml
  triggers:
    - type: prometheus
      name: rps_per_pod
      metricType: AverageValue          # additive → per-pod threshold
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc:9090
        query: |
          sum(rate(http_server_requests_seconds_count{
            namespace="prod", service="checkout", uri!~"/actuator.*"
          }[1m]))
        threshold: "85"

    - type: prometheus
      name: p95_latency
      metricType: Value                 # NOT additive → absolute comparison
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc:9090
        query: |
          histogram_quantile(0.95, sum by (le) (
            rate(http_server_requests_seconds_bucket{
              namespace="prod", service="checkout", uri!~"/actuator.*"
            }[2m])
          ))
        threshold: "0.4"
        ignoreNullValues: "true"
```

By default, **KEDA takes the maximum** of what each trigger independently asks for. Under normal load the latency trigger asks for fewer replicas than the RPS trigger and is invisible; when latency degrades without a traffic increase, it takes over.

Note the details: `metricType: Value` for the latency trigger (per the additive rule above), a wider `[2m]` window because quantiles are noisy, and `ignoreNullValues: "true"` so a gap in the bucket series reads as "no signal" rather than an error.

**A latency guardrail can make things worse and you should know when.** If latency is high because your database is saturated, adding pods adds connections and deepens the hole. Cap it: `maxReplicaCount` should be a number your downstreams can actually survive, and if your dependency is the bottleneck, the right answer is a circuit breaker, not more replicas.

### When Max Isn't the Combination You Want

For anything other than "take the max," use `scalingModifiers` (KEDA 2.13+), which evaluates a formula over your named triggers:

```yaml
spec:
  advanced:
    scalingModifiers:
      formula: "max(rps_per_pod, p95_latency)"
      target: "1"
      activationTarget: "1"
      metricType: AverageValue
```

The formula language supports `max`, `min`, `ceil`, `floor`, `abs`, arithmetic, and a nil-coalescing `??` operator that's genuinely useful for degradation: `primary_metric ?? backup_metric ?? 8` uses the primary, falls through to the backup if the primary trigger has exceeded its failure threshold, and lands on a literal 8 if everything is broken.

Start without `scalingModifiers`. Default max-of-triggers is right most of the time, and a formula is one more thing to get wrong at 2am.

## Step 6: Stop It From Flapping

Everything here is standard HPA behavior, passed through KEDA:

```yaml
spec:
  cooldownPeriod: 300
  advanced:
    restoreToOriginalReplicaCount: true
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Percent
              value: 100
              periodSeconds: 30
            - type: Pods
              value: 4
              periodSeconds: 30
          selectPolicy: Max
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 20
              periodSeconds: 60
```

The asymmetry is the whole point. **Scale up fast and cheap** — `stabilizationWindowSeconds: 0` reacts immediately, and doubling (or +4 pods, whichever is larger) handles a genuine spike in two intervals. A pod you didn't need costs you cents. **Scale down slow and cautious** — a 5-minute window means the HPA uses the highest recommendation from the last 5 minutes, so a brief lull can't dump capacity right before the next wave. 20% per minute takes 40 pods down to 3 over about 12 minutes, which is plenty fast for a cost line and slow enough to be safe.

`restoreToOriginalReplicaCount: true` means deleting the ScaledObject returns the Deployment to its manifest replica count instead of freezing it wherever the autoscaler left it. Set it; the alternative is a confusing incident later.

## Step 7: What Happens When Prometheus Is Down

This is the objection to metric-based autoscaling, and it has a real answer. Without one, a Prometheus outage means your scaler goes blind, and "blind" defaults to bad.

```yaml
spec:
  minReplicaCount: 3
  maxReplicaCount: 40
  fallback:
    failureThreshold: 3
    replicas: 10
    behavior: currentReplicasIfLower
```

After 3 consecutive failed polls (~45s at a 15s interval), KEDA stops trying to be clever. `behavior: currentReplicasIfLower` is the setting I'd argue for: hold at the current replica count, but raise it to 10 if you happen to be scaled below that. You neither collapse to minimum during a metrics outage nor blindly jump to 10 pods when you were already comfortably running 25.

Pick `replicas` to be roughly your p90 steady-state count — enough to serve a normal day without the metrics that would tell you otherwise.

Two more layers worth having:

**Keep a CPU-based HPA target as the backstop.** Add a `cpu` trigger with a deliberately high target (say 85%). It never fires during normal operation because the RPS trigger scales first, but if your PromQL breaks in a way that returns a legitimate-looking small number, CPU still catches a genuinely melting pod. This is the correct use of CPU: a dumb, always-available floor under a smart signal.

**Alert on the scaler itself.**

```promql
# The scaler is erroring
sum by (scaledObject) (rate(keda_scaler_errors_total[5m])) > 0

# Pinned at max for 15 minutes — you've hit the ceiling, not the demand
kube_horizontalpodautoscaler_status_current_replicas
  == on(horizontalpodautoscaler, namespace)
kube_horizontalpodautoscaler_spec_max_replicas
```

The second one matters more than people expect. A service pinned at `maxReplicaCount` is a service whose autoscaler has stopped autoscaling, and it usually looks fine on a latency dashboard right up until it doesn't.

## The Gotcha List

Things that cost me time, in rough order of how often they come up:

- **Query returns a vector, not a scalar.** `sum()` without `by`, always. Test in the Prometheus UI first — if the result table has more than one row, KEDA will fail.
- **`AverageValue` on a non-additive metric.** Latency, ratios, and averages need `metricType: Value`. This one is silent and destructive.
- **Actuator traffic in the query.** Filter `uri!~"/actuator.*"` or your probes become part of your scaling signal.
- **Scrape interval > rate window.** Produces NaN, which with `ignoreNullValues: "true"` reads as zero load, which scales you down under load.
- **`minReplicaCount: 0` without an `activationThreshold`.** Scale-to-zero is governed by the activation threshold, not the scaling threshold. Set `activationThreshold` above your idle noise floor or you'll thrash between 0 and 1 forever — and remember the first request after zero pays your full cold start.
- **Missing PodDisruptionBudget.** Aggressive scale-down plus a node drain can take out more pods than you meant. `minAvailable` is not optional in production.
- **Two HPAs on one Deployment.** If a hand-written HPA already targets it, KEDA refuses to take over unless you set `scaledobject.keda.sh/transfer-hpa-ownership: "true"` — and having both fight is worse than either alone.
- **No resource `requests` on the pod.** Not KEDA's problem directly, but a Deployment without requests gets scheduled badly, and your carefully derived per-pod capacity number becomes fiction the moment two replicas land on the same noisy node.

## Debugging Order

When it doesn't scale, go in this order and stop at the first thing that's wrong:

```bash
# 1. Does the query return one number, in the Prometheus UI?
#    (Paste the trigger query verbatim. Most bugs die here.)

# 2. Is the ScaledObject healthy?
kubectl describe scaledobject checkout -n prod
#    Look at Conditions: Ready=True, Active=True.

# 3. Is KEDA serving the metric to Kubernetes?
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/prod/s0-prometheus" | jq

# 4. What does the HPA think?
kubectl describe hpa keda-hpa-checkout -n prod
#    Events explain every decision it made and why it didn't make others.

# 5. What is KEDA actually reading?
kubectl logs -n keda deploy/keda-operator --tail=100 | grep checkout
```

Nine times out of ten it's step 1 — a label that doesn't exist in production, or a query that returns two rows because a `by` clause snuck in.

## Where I'd Start

If you're staring at a fleet of CPU-scaled services and wondering where to begin: pick the one service where you've had a scaling-related incident, run the k6 ramp against one pod in staging, and look at where CPU sits when latency goes vertical. That single graph will tell you more about your autoscaling than any amount of reading, this post included.

Then wire up one ScaledObject with one RPS trigger and a `fallback`. Add the latency guardrail after you trust the first one. Resist doing all of it at once — the failure modes are much easier to recognize one at a time.

---

**References**

- [KEDA documentation](https://keda.sh/docs/2.20/) — [ScaledObject spec](https://keda.sh/docs/2.20/reference/scaledobject-spec/), [Prometheus scaler](https://keda.sh/docs/2.20/scalers/prometheus/)
- [Kubernetes HPA scaling behavior](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#configurable-scaling-behavior)
- [k6 arrival-rate executors](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/)
- [Micrometer distribution summaries and histograms](https://docs.micrometer.io/micrometer/reference/concepts/histogram-quantiles.html)
