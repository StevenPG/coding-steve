---
author: StevenPG
pubDatetime: 2026-03-20T12:00:00.000Z
title: Casual Machine Performance Test
slug: casual-machine-perf-test
featured: false
ogImage: /assets/default-og-image.png
tags:
  - gradle
  - java
description: Just a fun little comparison of a group of machines and how they handle Java and GraalVM native images.
---

# Java Performance Showdown: JDK vs. GraalVM Native Image Across the Silicon Spectrum (Spoiler: Apple's M-Series Shines)

Ever wondered how your machine *really* stacks up when it comes to Java performance? We're not talking about hitting
that absolute peak, hyper-optimized, once-in-a-blue-moon benchmark. Nah, this is about real-world, "let's run it a
couple of times and see what's what" kind of performance. We're looking for those ballpark differences that tell a story
about the raw power – or lack thereof – under the hood.

The goal is simple: get a feel for the uplift between different systems, with a special curiosity about how Apple's
M-series MacBooks are changing the game. We're pitting standard JDK compilation and runtime against the lean, mean,
ahead-of-time compiled GraalVM Native Image.

*NOTE* This article is updated when someone I know (or myself) acquires a new machine.

**The Ground Rules**

To keep things fair and focused on pure CPU grunt, we made sure to rerun any initial Gradle runs. Why? Because nobody
wants their benchmark tainted by Gradle downloading itself or pulling a mountain of dependencies. We're interested in
processing power, plain and simple.

### These were the instructions given to some friends who had the machines required to flesh out this benchmark:

For this experiment, you'll want your `JAVA_HOME` pointing to a GraalVM JDK.

**The Test Bench Commands:**

* **GraalVM Native Image:** `./gradlew clean nativeRun`
    * We're looking for two key lines in the output:
        * `Finished generating 'demo' in Xm Xs.` (This is your Native Compile Time)
        * `Started DemoApplication in Y.YYYs seconds` (This is your Native Startup Time)
* **Standard JDK:**
    * `./gradlew clean compileJava` (The output `BUILD SUCCESSFUL in ZZZms` is your JDK Compile Time)
    * `./gradlew clean bootRun` (The line `Started DemoApplication in A.AAAs seconds` is your JDK Startup Time)

**The Contenders & The Results:**

Let's dive into the numbers. We've got a diverse lineup, from old Intel MacBooks to modern M-series Machines, and even a
couple of Linux and Windows machines thrown in for good measure.

| System           | JDK Compile Time (ms) | JDK Startup Time (s) | Native Compile Time | Native Startup Time (ms) | Spec Notes                   | OS                  |
|------------------|-----------------------|----------------------|---------------------|--------------------------|------------------------------|---------------------|
| 2015 Macbook Pro | 3000                  | 3.849                | 436s (7m 16s)       | 320                      |                              | MacOS               |
| 2020 Lemur Pro   | 4000                  | 8.052                | 657s (10m 57s)      | 938                      | System76, i5 10210U 4c 40GB  | Ubuntu Server 21.04 |
| 2019 Macbook Pro | 2000                  | 3.786                | 230s (3m 50s)       | 413                      | 2.6GHz 6c i7                 | MacOS               |
| M1 Pro           | 1000                  | 2.071                | 140s (2m 20s)       | 207                      | M1 Pro 8c 32GB               | MacOS               |
| M2 Air           | 1000                  | 1.687                | 205s (3m 25s)       | 180                      | M2 16GB                      | MacOS               |
| M2 Pro           | *N/A*                 | *N/A*                | *N/A*               | *N/A*                    | Couldn't get my hands on one | MacOS               |
| M3 Pro           | 650                   | 1.490                | 79s (1m 19s)        | 205                      | M3 Pro 12c 36GB (6p,6e)      | MacOS               |
| M3 Max           | 620                   | 1.429                | 66s (1m 6s)         | 204                      | M3 Max 16c 48GB              | MacOS               |
| M4 Mac Mini      | 650                   | 1.253                | 125s (2m 5s)        | 158                      | M4 10c 32GB (4p,6e)          | MacOS               |
| M4 Pro           | 333                   | 1.304                | 68s (1m 8s)         | 189                      | M4 Pro 14c 48GB (10p,4e)     | MacOS               |
| M5 Max           | 450ms	                | 1.196s               | 59s (59s)           | 129                      | M5 Max 18c 48GB (12p,6e)     | MacOS               |
| ITX Computer     | 1000                  | 2.410                | 186s (2m 46s)       | 172                      | Ryzen 5700g 8c 16t 32GB      | Pop!_OS 22.04 LTS   |
| Dell 5560        | 1460                  | 3.465                | 217s (3m 37s)       | 277                      | Intel i7 32GB                | Windows 11 Pro      |

*Note: Data for the M2 Pro was not available.*

**Dissecting the Data: The Apple M-Series Uplift is Real**

Let's be frank, the numbers speak volumes, especially when we zoom in on the Apple silicon.

**JDK Performance:**

* **Compile Times:** Even before looking at Apple silicon, the Intel machines tell an interesting story on their own.
  The Lemur Pro (4-core i5) tops out at a painful 4000ms, the 2015 MBP sits at 3000ms, the 2019 MBP (6-core i7) gets
  down to 2000ms, and the Dell 5560 is the best of the Intel bunch at 1460ms — a **2.7x spread** just within the Intel
  camp. Then the M-series walks in and blows the curve: the M1 Pro cuts it to 1000ms, the M3 generation pushes to
  ~620-650ms, and the M4 Pro hits a blistering 333ms. That's a **6x improvement** over the 2019 MBP and a **4.4x
  improvement** over the best-performing Intel machine we tested. The M5 Max lands at 450ms — notably, a step *back*
  from the M4 Pro's 333ms, which is a curious result likely reflecting the tradeoff between core count and single-thread
  clock speed between those two chips.
* **Startup Times:** The Intel spread here is equally dramatic. The Lemur Pro's 8.052s startup is the outlier —
  more than **double** any other Intel machine in the test, a clear sign that its 4-core i5 is the bottleneck. The 2015
  and 2019 MBPs cluster around 3.8s, with the Dell 5560 posting the best Intel result at 3.465s. The M-series pulls
  well clear: M1 Pro at 2.071s, M3 generation at ~1.4s, and the M5 Max now leading the pack at 1.196s. That's a
  **2.9x improvement** over the 2019 MBP and a **3.2x improvement** over the top Intel result in startup time.

**GraalVM Native Image Performance:**

This is where things get *really* interesting due to the ahead-of-time compilation.

* **Native Compile Times:** This is where the Intel machines really show their age — and their variance. The Lemur Pro
  grinds away for a brutal 657 seconds (nearly 11 minutes). The 2015 MBP takes 436s. Then there's an interesting jump:
  the 2019 MBP (230s) and Dell 5560 (217s) are nearly tied, suggesting later Intel generations made real strides here
  — but the **3x spread** from best to worst Intel is hard to ignore. The M-series makes all of that moot: M1 Pro
  at 140s, M3 Pro down to 79s, M3 Max at 66s. The M5 Max crosses a notable threshold, coming in at **59 seconds** —
  the first machine in our dataset to complete native compilation in under a minute. That's a **~3.9x improvement**
  over the 2019 MBP and a full **11x faster** than the Lemur Pro. The M4 Mac Mini with its 4 performance cores shows a
  respectable 125s, confirming even the non-Pro M4 chips are no slouch.
* **Native Startup Times:** GraalVM's party trick is near-instantaneous startup, but the spread here is worth examining.
  The Lemur Pro is again the outlier at 938ms — more than **3x slower** than the Dell 5560 (277ms), and double the
  2019 MBP (413ms). Interestingly, the 2019 MBP's native startup (413ms) is actually *slower* than the 2015 MBP
  (320ms), which likely reflects measurement variance or OS-level differences rather than a genuine regression. On the
  M-series side, M1 Pro hit 207ms, the M2 Air 180ms, and the M5 Max now leads at a crisp **129ms** — a **3.2x
  improvement** over the 2019 MBP and a remarkable **7.3x improvement** over the Lemur Pro.

**Apple Silicon Through the Generations:**

* **M1 Pro to M3 Pro:**
    * JDK Compile: 1000ms → 650ms (1.54x faster)
    * JDK Startup: 2.071s → 1.490s (1.39x faster)
    * Native Compile: 140s → 79s (1.77x faster)
    * Native Startup: 207ms → 205ms (negligible difference, likely hitting other limits)
* **M3 Pro to M4 Pro:**
    * JDK Compile: 650ms → 333ms (1.95x faster)
    * JDK Startup: 1.490s → 1.304s (1.14x faster)
    * Native Compile: 79s → 68s (1.16x faster)
    * Native Startup: 205ms → 189ms (1.08x faster)
* **M4 Pro to M5 Max:**
    * JDK Compile: 333ms → 450ms (**M5 Max is slower here** — a curious result, possibly reflecting the M4 Pro's
      higher single-thread clock speed vs the M5 Max's broader core count)
    * JDK Startup: 1.304s → 1.196s (1.09x faster)
    * Native Compile: 68s → 59s (1.15x faster)
    * Native Startup: 189ms → 129ms (**1.46x faster** — the standout gain at this step)

The M4 Pro remains king for raw JDK compile speed in our dataset. But the M5 Max reclaims ground in native startup,
which is the more practically impactful metric for production workloads.

**The Classic Upgrade Path: 2019 MacBook Pro → M3 Max → M5 Max**

This is probably the most relatable progression — someone who's been holding onto a solid Intel MacBook and wondering
just how much they've been leaving on the table. Here's the full picture:

* **2019 MBP → M3 Max:**
    * JDK Compile: 2000ms → 620ms (**3.2x faster**)
    * JDK Startup: 3.786s → 1.429s (**2.65x faster**)
    * Native Compile: 230s → 66s (**3.5x faster**)
    * Native Startup: 413ms → 204ms (**2x faster**)
* **2019 MBP → M5 Max:**
    * JDK Compile: 2000ms → 450ms (**4.4x faster**)
    * JDK Startup: 3.786s → 1.196s (**3.2x faster**)
    * Native Compile: 230s → 59s (**3.9x faster**)
    * Native Startup: 413ms → 129ms (**3.2x faster**)
* **M3 Max → M5 Max (skipping a generation):**
    * JDK Compile: 620ms → 450ms (1.4x faster)
    * JDK Startup: 1.429s → 1.196s (1.2x faster)
    * Native Compile: 66s → 59s (1.1x faster)
    * Native Startup: 204ms → 129ms (**1.6x faster** — the clear highlight of this hop)

The 2019-to-M3 Max jump is massive across the board. Going M3 Max to M5 Max brings more modest gains in compile
throughput, but native startup continues to see meaningful improvement. If you're on a 2019 Intel Mac, the upgrade
argument is overwhelming regardless of which generation you land on. If you're already on M3 Max, you're getting
diminishing but still real returns — with native startup being the metric that benefits the most.

**What About the Non-Apple Camp?**

* The **ITX Computer (Ryzen 5700g)** puts in a very strong showing, especially in native compilation (186s) and native
  startup (172ms), beating out the M1 Pro and M2 Air in native compile time and being very competitive in native
  startup. Its JDK compile time (1000ms) is on par with the M1 Pro and M2 Air. This shows that modern desktop CPUs can
  definitely compete, especially in raw compilation throughput.
* The **2020 Lemur Pro (System76, Intel i5 10th gen)**, while a capable machine for its time, clearly shows its age and
  core count limitations against the newer silicon, particularly in the lengthy native compile times (657s).
* The **Dell 5560 (Intel i7)** performs respectably, landing somewhere between the older Intel MacBooks and the early
  M-series chips in most tests. Its native compile time (217s) is better than the 2019 Intel MacBook Pro, showcasing
  improvements in later Intel generations before the M-series took a dominant lead.

**Drawing Conclusions: The Ballpark Figures**

1. **Apple's M-Series is a Game Changer for Java Devs:** The performance uplift from Intel-based Macs to the M-series
   (M1 through M5) is undeniable across both standard JDK tasks and GraalVM Native Image workflows. The Intel machines
   themselves span a **2.7x–3x spread** just within their own camp, and yet even the best-performing Intel machine
   tested is blown out of the water by any M-series chip from M3 onward.
2. **Generational Gains Continue, But Shift in Character:** Early M-series generations (M1 → M3) delivered broad
   improvements everywhere. Later hops (M4 → M5) show more targeted gains — native startup in particular keeps
   improving, while raw JDK compile speed appears to favor the M4 Pro's architecture over the M5 Max's higher core
   count.
3. **GraalVM Native Image is Blazing Fast (Especially Startup):** The startup times for native-compiled applications are
   in a different league from standard JDK startup — milliseconds versus seconds. The M5 Max's 129ms native startup is
   the new bar. While native compilation takes longer upfront, the runtime benefits are undeniable for latency-sensitive
   workloads.
4. **M-Series Excels at Native Compilation Too:** While the Ryzen 5700g showed strong native compilation, the higher-end
   M3, M4, and M5 chips (Pro/Max) are leading the pack. The M5 Max crossing under 60 seconds for native compilation is
   a new milestone in our dataset.
5. **M-Series Air vs. Pro/Max:** The M2 Air holds its own against older i7s and even the M1 Pro in JDK tasks, but the
   Pro and Max variants pull ahead in the heavier native compilation workloads. The M4 Mac Mini shows that even
   non-Pro M4 chips are formidable. The upgrade decision increasingly comes down to whether native compile time matters
   in your daily workflow.

**The Bottom Line:**

If you're looking for a ballpark understanding, Apple's M-series MacBooks, particularly the M3 and M4 generations, offer
a stellar Java development experience. They provide substantial uplifts in both traditional JDK workflows and when
diving into the world of GraalVM Native Images. While powerful desktop CPUs like the Ryzen 5700g can hold their own,
especially in Linux environments, the efficiency and performance packed into Apple's custom silicon for laptops (and now
the Mac Mini) are hard to ignore.

The evolution is clear, and the speed is real. Happy coding!