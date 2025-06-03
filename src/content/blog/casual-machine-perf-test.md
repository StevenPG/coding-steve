---
author: StevenPG
pubDatetime: 2025-05-06T12:00:00.000Z
title: Casual Machine Performance Test
slug: casual-machine-perf-test
featured: false
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - gradle
  - java
description: Just a fun little comparison of a group of machines and how they handle Java and GraalVM native images.
---

# Java Performance Showdown: JDK vs. GraalVM Native Image Across the Silicon Spectrum (Spoiler: Apple's M-Series Shines)

Ever wondered how your machine *really* stacks up when it comes to Java performance? We're not talking about hitting that absolute peak, hyper-optimized, once-in-a-blue-moon benchmark. Nah, this is about real-world, "let's run it a couple of times and see what's what" kind of performance. We're looking for those ballpark differences that tell a story about the raw power – or lack thereof – under the hood.

The goal is simple: get a feel for the uplift between different systems, with a special curiosity about how Apple's M-series MacBooks are changing the game. We're pitting standard JDK compilation and runtime against the lean, mean, ahead-of-time compiled GraalVM Native Image.

**The Ground Rules**

To keep things fair and focused on pure CPU grunt, we made sure to rerun any initial Gradle runs. Why? Because nobody wants their benchmark tainted by Gradle downloading itself or pulling a mountain of dependencies. We're interested in processing power, plain and simple.

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

Let's dive into the numbers. We've got a diverse lineup, from old Intel MacBooks to modern M-series Machines, and even a couple of Linux and Windows machines thrown in for good measure.

| System           | JDK Compile Time (ms) | JDK Startup Time (s) | Native Compile Time | Native Startup Time (ms) | Spec Notes                   | OS                    |
|------------------|-----------------------|----------------------|---------------------|--------------------------|------------------------------|-----------------------|
| 2015 Macbook Pro | 3000                  | 3.849                | 436s (7m 16s)       | 320                      |                              | MacOS                 |
| 2020 Lemur Pro   | 4000                  | 8.052                | 657s (10m 57s)      | 938                      | System76, i5 10210U 4c 40GB  | Ubuntu Server 21.04   |
| 2019 Macbook Pro | 2000                  | 3.786                | 230s (3m 50s)       | 413                      | 2.6GHz 6c i7                 | MacOS                 |
| M1 Pro           | 1000                  | 2.071                | 140s (2m 20s)       | 207                      | M1 Pro 8c 32GB               | MacOS                 |
| M2 Air           | 1000                  | 1.687                | 205s (3m 25s)       | 180                      | M2 16GB                      | MacOS                 |
| M2 Pro           | *N/A*                 | *N/A*                | *N/A*               | *N/A*                    | Couldn't get my hands on one | MacOS                 |
| M3 Pro           | 650                   | 1.490                | 79s (1m 19s)        | 205                      | M3 Pro 12c 36GB (6p,6e)      | MacOS                 |
| M3 Max           | 620                   | 1.429                | 66s (1m 6s)         | 204                      | M3 Max 16c 48GB              | MacOS                 |
| M4 Mac Mini      | 650                   | 1.253                | 125s (2m 5s)        | 158                      | M4 10c 32GB (4p,6e)          | MacOS                 |
| M4 Pro           | 333                   | 1.304                | 68s (1m 8s)         | 189                      | M4 Pro 14c 48GB (10p,4e)     | MacOS                 |
| ITX Computer     | 1000                  | 2.410                | 186s (2m 46s)       | 172                      | Ryzen 5700g 8c 16t 32GB      | Pop!_OS 22.04 LTS     |
| Dell 5560        | 1460                  | 3.465                | 217s (3m 37s)       | 277                      | Intel i7 32GB                | Windows 11 Pro        |

*Note: Data for the M2 Pro was not available.*

**Dissecting the Data: The Apple M-Series Uplift is Real**

Let's be frank, the numbers speak volumes, especially when we zoom in on the Apple silicon.

**JDK Performance:**

* **Compile Times:** The jump from the Intel-based MacBooks to the M-series is stark. The 2019 MacBook Pro (2.6GHz 6c i7) clocked in at 2000ms. The M1 Pro halved that to 1000ms. The M3 Pro and Max pushed it further down to ~650ms, and the M4 Pro delivered a blistering 333ms! That's roughly a **6x improvement** in JDK compile time from a high-end 2019 Intel MacBook Pro to an M4 Pro MacBook. Even the M2 Air holds its own impressively against older Intel i7s.
* **Startup Times:** Similar story here. The 2019 Intel MBP started our demo app in 3.786 seconds. The M1 Pro cut this to 2.071s. The M3 generation brought this down to the ~1.4s range, and the M4 Mac Mini dipped to 1.253s, with the M4 Pro around 1.304s. This represents an approximate **2.9x speedup** in startup time from the 2019 Intel to the M4 Pro.

**GraalVM Native Image Performance:**

This is where things get *really* interesting due to the ahead-of-time compilation.

* **Native Compile Times:** This is a CPU-intensive task, and the M-series chips flex their muscles. The 2019 Intel MBP took 230 seconds (3m 50s). The M1 Pro slashed this to 140s (2m 20s). The M3 Pro brought it down to a swift 79s (1m 19s), and the M3 Max edged it out slightly at 66s (1m 6s). The M4 Pro is right there with the M3 Max at 68s (1m 8s). This is a **~3.5x improvement** in native compilation time from the 2019 Intel MBP to the M3 Max/M4 Pro. The M2 Air, while very capable for its class, shows that more cores and potentially different architecture in the Pro/Max chips make a difference in these longer, heavier tasks compared to the M1 Pro (205s vs 140s). However, the M4 Mac Mini with its 4 performance cores shows a very respectable 125s.
* **Native Startup Times:** This is GraalVM's party trick – near-instantaneous startup. While all native images are fast, we still see differences. The 2019 Intel MBP started in 413ms. The M1 Pro achieved 207ms. The M2 Air impressed with 180ms. The M3 generation hovered around 205ms, and the M4 Mac Mini hit a remarkable 158ms, with the M4 Pro at 189ms. This represents an uplift of roughly **2.2x to 2.6x** from the 2019 Intel MBP to the M4 generation.

**Comparing Across the M-Series Generations:**

* **M1 Pro to M3 Pro:**
  * JDK Compile: 1000ms down to 650ms (1.54x faster)
  * JDK Startup: 2.071s down to 1.490s (1.39x faster)
  * Native Compile: 140s down to 79s (1.77x faster)
  * Native Startup: 207ms to 205ms (negligible difference, likely hitting other limits)
* **M3 Pro to M4 Pro:**
  * JDK Compile: 650ms down to 333ms (1.95x faster)
  * JDK Startup: 1.490s to 1.304s (1.14x faster)
  * Native Compile: 79s down to 68s (1.16x faster)
  * Native Startup: 205ms to 189ms (1.08x faster)

The M4 Pro shows a significant jump in JDK compilation over the M3 Pro. Native compilation and startup times are seeing smaller, but still present, gains with each M-series iteration, suggesting these were already highly optimized.

**What About the Non-Apple Camp?**

* The **ITX Computer (Ryzen 5700g)** puts in a very strong showing, especially in native compilation (186s) and native startup (172ms), beating out the M1 Pro and M2 Air in native compile time and being very competitive in native startup. Its JDK compile time (1000ms) is on par with the M1 Pro and M2 Air. This shows that modern desktop CPUs can definitely compete, especially in raw compilation throughput.
* The **2020 Lemur Pro (System76, Intel i5 10th gen)**, while a capable machine for its time, clearly shows its age and core count limitations against the newer silicon, particularly in the lengthy native compile times (657s).
* The **Dell 5560 (Intel i7)** performs respectably, landing somewhere between the older Intel MacBooks and the early M-series chips in most tests. Its native compile time (217s) is better than the 2019 Intel MacBook Pro, showcasing improvements in later Intel generations before the M-series took a dominant lead.

**Drawing Conclusions: The Ballpark Figures**

1.  **Apple's M-Series is a Game Changer for Java Devs:** The performance uplift from Intel-based Macs to the M-series (M1, M2, M3, and now M4) is undeniable and significant across both standard JDK tasks and GraalVM Native Image compilation/startup. If you're a Java developer on a Mac, the M-series offers a substantially better experience.
2.  **Generational Gains in M-Series are Consistent:** Each new M-chip generation (Pro and Max variants in particular) continues to offer noticeable improvements, especially in CPU-bound tasks like compilation. The M4 Pro's JDK compile time is particularly impressive.
3.  **GraalVM Native Image is Blazing Fast (Especially Startup):** The startup times for native-compiled applications are in a different league compared to standard JDK startup. We're talking milliseconds versus seconds. While native compilation takes longer, the runtime benefits can be huge for certain applications.
4.  **M-Series Excels at Native Compilation Too:** While the Ryzen 5700g showed strong native compilation, the higher-end M3 and M4 chips (Pro/Max) are leading the pack in our dataset, making the wait for a native binary significantly shorter.
5.  **M-Series Air vs. Pro/Max:** While the M2 Air is incredibly capable and often matches or beats older i7s and even the M1 Pro in some JDK tasks and native startup, the "Pro" and "Max" versions of the M-chips with more performance cores and potentially higher memory bandwidth show their strength in the more demanding native compilation tasks. The M4 Mac Mini with its 4 performance cores, however, shows that even the non-Pro/Max M4 chips are very potent.

**The Bottom Line:**

If you're looking for a ballpark understanding, Apple's M-series MacBooks, particularly the M3 and M4 generations, offer a stellar Java development experience. They provide substantial uplifts in both traditional JDK workflows and when diving into the world of GraalVM Native Images. While powerful desktop CPUs like the Ryzen 5700g can hold their own, especially in Linux environments, the efficiency and performance packed into Apple's custom silicon for laptops (and now the Mac Mini) are hard to ignore.

The evolution is clear, and the speed is real. Happy coding!