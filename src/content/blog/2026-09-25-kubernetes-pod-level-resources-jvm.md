---
author: StevenPG
pubDatetime: 2026-09-25T17:00:00.000Z
title: "Pod-Level Resources in Kubernetes 1.37: Your JVM Thinks It Owns the Whole Pod"
slug: kubernetes-pod-level-resources-jvm
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - kubernetes
  - java
  - infrastructure
  - performance
description: Pod-level resources let a pod's containers share one CPU and memory budget. The kubelet then tells every unlimited container that the whole budget is its own, and a JVM with MaxRAMPercentage=75 believes it. A reproduction of the kernel OOM kill that follows, and the one-line fix.
---

## Table of Contents

[[toc]]

# The feature everyone with sidecars wanted

Kubernetes 1.37 shipped on August 26. One of the features in it that I think will get adopted fastest is
[pod-level resources](https://kubernetes.io/docs/tasks/configure-pod-container/assign-pod-level-resources/). It has
been beta and on by default since 1.34, and it keeps getting pieces around it; in-place resize of pod-level
resources is alpha in 1.37. Instead of guessing a limit for every container, you give the _pod_ a budget:

```yaml
apiVersion: v1
kind: Pod
spec:
  resources:
    requests: { cpu: "1", memory: 1Gi }
    limits: { cpu: "1", memory: 1Gi }
  containers:
    - name: app # no resources block
    - name: log-shipper # no resources block
```

Anyone who runs Envoy, a log shipper, an OpenTelemetry collector or a Vault agent next to their service knows why
this is attractive. The sidecar needs 30 MiB most of the time and 300 MiB during a burst. With per-container limits
you either over-provision it or it gets OOM-killed. With a pod-level budget, it borrows from whatever the app isn't using.

The question I wanted answered as a Java developer: **what does the JVM see?** The JVM sizes its heap, its GC and
`availableProcessors()` from cgroup limits. If the limit lives on the pod instead of the container, does the JVM
know about it?

The code is in
[DemosAndArticleContent/blog/kubernetes-pod-level-resources-jvm](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/kubernetes-pod-level-resources-jvm).

> **[DRAFT NOTE: kind run pending]** The results below come from a plain-Docker reproduction of the exact cgroup
> layout the KEP specifies, run twice with identical outcomes. The kind-on-1.37 version of the same four scenarios
> is in the repo but hasn't run yet (the sandbox I built it in can't start pod sandboxes). Confirm on the M3 before
> publishing.

# The JVM does see a limit. The wrong one.

My first guess was that the JVM would see _no_ limit and size itself against the whole node. The
[KEP](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/2837-pod-level-resource-spec) says
otherwise, and names the JVM specifically:

> "When container-level limit is not set, the pod-level limit is applied to each container's cgroup maximum value.
> This is because container-level limit is implied in this case, and some runtimes (like the Java runtime) rely on
> container-level cgroup maximum values for fine tuning their components."

So a JVM in an unlimited container reads `memory.max` = 1 GiB and `cpu.max` = 1 CPU from its own cgroup, and sizes
itself as if it were alone in a 1 CPU / 1 GiB container. That's a sensible default. But the sidecar reads the same
1 GiB from _its_ cgroup. Every container in the pod is told the whole budget is its own, and only the pod's
cgroup, one level up, knows they're sharing it.

That's fine until you combine it with the flag almost every production JVM image sets:

```
-XX:MaxRAMPercentage=75
```

Now the JVM plans a heap of 75% of the _pod_.

# Reproducing it

I wanted this failure reproducible without a cluster, so the project has two harnesses for the same four scenarios:

- **`scripts/run.sh`**: a kind cluster on `kindest/node:v1.37.0`, applying four Pod manifests.
- **`scripts/emulate-docker.sh`**: the same cgroup layout the KEP describes, built by hand in plain Docker. A parent
  cgroup holds the pod limit (`--cgroup-parent`), each container's own limit is set to the pod limit unless the
  scenario gives it one, and the kernel enforces it all the same way it would under the kubelet.

The app is a single-file Java probe on `eclipse-temurin:25-jdk` with `-XX:MaxRAMPercentage=75`. It prints what the
JVM decided and what the cgroup files say, then allocates heap in 16 MiB steps until something stops it. That
something is one of two very different things:

- **A Java `OutOfMemoryError`**: the heap ceiling was below the real limit. The app gets an exception it can log,
  `-XX:+HeapDumpOnOutOfMemoryError` works, and the incident is debuggable.
- **The kernel's OOM killer**: the heap ceiling was _above_ the real limit. The process is killed mid-allocation with
  exit 137. No stack trace, no heap dump, just `OOMKilled` in `kubectl describe`.

The "busy" sidecar writes 384 MiB into an in-memory `emptyDir`, which stands in for a log shipper's buffer during
a burst. A native-sidecar `startupProbe` holds the app back until it has.

| #   | Pod budget    | App container limit | Sidecar                       |
| --- | ------------- | ------------------- | ----------------------------- |
| 01  | none          | 1 CPU / 1 GiB       | 64 MiB limit, idle            |
| 02  | 1 CPU / 1 GiB | none                | no limit, idle                |
| 03  | 1 CPU / 1 GiB | none                | no limit, **holding 384 MiB** |
| 04  | 1 CPU / 1 GiB | **640 MiB**         | no limit, **holding 384 MiB** |

# Results

| #   | JVM saw         | Max heap | Outcome                                              |
| --- | --------------- | -------: | ---------------------------------------------------- |
| 01  | 1024 MiB, 1 CPU |  742 MiB | `OutOfMemoryError` after 688 MiB                     |
| 02  | 1024 MiB, 1 CPU |  742 MiB | `OutOfMemoryError` after 688 MiB                     |
| 03  | 1024 MiB, 1 CPU |  742 MiB | **killed by the kernel after 512 MiB, exit 137**     |
| 04  | 640 MiB, 1 CPU  |  464 MiB | `OutOfMemoryError` after 416 MiB, sidecar unaffected |

**Scenario 02 is the trap.** The pod-level migration looks like a success: same budget, same heap, same behavior as
before. You'd ship it. Then one day the log shipper buffers during a downstream outage, and scenario 03 happens in
production. The JVM had planned for 742 MiB of heap it never had. It got 512 MiB in, and the kernel killed it with
nothing in the logs.

The JVM wasn't wrong about its cgroup. Its cgroup really did say 1 GiB. The information it needed, "someone else is
using 384 MiB of this," lives one level up in a cgroup it has no reason to look at.

One more thing the probe showed: every one of these JVMs saw 1 CPU and, being JDK 25, quietly picked **SerialGC**. That's
the ergonomic rule [JDK 27 just removed](/posts/java-27-new-defaults-benchmark). A pod-level budget of 1 CPU puts you
right on that boundary.

# The fix: give the JVM its own limit

Scenario 04 is the pattern I'd use: **pod-level resources for the budget, and a container limit on the JVM only.**

```yaml
spec:
  resources:
    limits: { cpu: "1", memory: 1Gi } # the whole pod's budget
  containers:
    - name: app
      resources:
        limits: { memory: 640Mi } # what the JVM sizes itself from
    - name: log-shipper # no limit: bursts into whatever the app isn't using
```

The JVM sizes its heap from 640 MiB and fails cleanly if it outgrows that. The sidecar keeps the flexibility that
was the point of the feature. The pod still can't exceed 1 GiB. The alternatives are weaker:

- **Size the heap absolutely** (`-Xmx512m`, or `-XX:MaxRAM=640m`) and leave room for the sidecars. It works, but now
  the heap size lives in `JAVA_TOOL_OPTIONS` instead of next to the other resource numbers.
- **Lower `MaxRAMPercentage`** for pod-level pods. It's the weakest fix, because the right percentage depends on what
  the neighbors do, and that can change without anyone touching your deployment.

What _not_ to do is adopt pod-level resources as a pure refactor, deleting per-container limits and moving the numbers
up a level, on any pod that runs a JVM (or anything else that sizes itself from cgroups: Go with `GOMEMLIMIT`
derived from the limit, Node with a heap flag computed at startup, .NET). They'll all believe the pod is theirs.

# Where this sits with autoscaling

If you run the [KEDA/Prometheus setup from last month](/posts/kubernetes-autoscaling-prometheus-keda), pod-level
resources change nothing about scaling signals. They change what "a pod" can absorb before it dies. Kernel OOM kills
also reset a pod's warm-up, so under load you can get an autoscaler adding pods while the existing ones restart.
That's another reason to prefer the failure mode you can see, a Java `OutOfMemoryError` inside a container limit,
over the one you can't.

# Run it yourself

On a Linux host with Docker (as root):

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/kubernetes-pod-level-resources-jvm
sudo ./scripts/emulate-docker.sh
```

With kind (Docker Desktop is fine):

```bash
./scripts/run.sh
```
