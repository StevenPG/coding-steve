---
author: StevenPG
pubDatetime: 2024-09-29T12:00:00.000Z
title: Jdk 23 Streams - How To Use Gather Operations
slug: jdk23-streams-gather
featured: false
# TODO replace ogImage
ogImage: /assets/default-og-image.png
tags:
  - software
  - spring boot
  - java
description: An article on how to use the Gather stream operation in JDK23
---

# It's finally here! JDK 23

<sub><sup>Just kidding, this isn't an LTS release</sup></sub>

The next LTS release that will include all of the changes in JDK 23 (assuming Gatherers make the cut) is JDK 25 and 
that won't be available until September 2025. When that happens, all of the links on this page will be updated for JDK 25.

This post is a simple overview of the new [java.util.stream.Gatherer][gatherer-javadoc] and related classes that have been added
as part of JDK 23. These operations are incredibly powerful and right away, I wasn't able to find
a good resource on the web that helped me understand.

SO, in keeping with this site, I intend to write up a simple article that I (and others!) can reference
in the future when we need to understand something about this new non-terminating stream capability!

There are two libraries being developed that contain common use-cases for gatherers. I'm sure these libraries 
will continue to grow as more use-cases are identified. I don't recommend including them by default, but using the
code as inspiration for your own gatherers OR pulling in the dependency when needed seems like a good move for most of us!

Here are the libraries:

https://github.com/pivovarit/more-gatherers

https://github.com/jhspetersson/packrat

### Let's get to demo-ing!

We can install Java 23 quickly using Sdkman! using `sdk install java 23-tem`

The link to the release notes for Jdk23 are right here: [https://openjdk.org/projects/jdk/23][openjdk23]

This feature is a pretty powerful addition for anyone that's been
leveraging Java Streams heavily for stream processing!

Specifically for Gatherers, the JEP is right over here: [https://openjdk.org/jeps/473][jeps473]

## JEP-473

Stream Gatherers is a preview API delivered in JDK 22 that's in preview again
in JDK 23. Gatherers allow for stream pipelines to transform
data through intermediate operations instead of needing to perform
a terminating operation and generate a new stream.

Today, if we want to process a list of elements, then perform an operation on the entire list,
and then continue processing the list, we'd have to do it like this:

```java
void main(String[] args) {
    var mylist = Stream.of(1,2,3)
            .map(integer -> integer + 10)
            .collect(Collectors.toList());
    // We can't perform any operations on the full list
    // So we have to terminate the stream and spin up
    // a new one, just to perform this simple operation
    mylist.remove(1);
    var myListMinusFirstElement = mylist.stream()
            .map(integer -> integer + 20)
            .toList();
    System.out.println(myListMinusFirstElement);
}
```

```bash
$ java --enable-preview demo
[31, 33]
```

With Gatherers, we're able to do this in a cleaner way by
doing our extra processing in an intermediate method!

Ok before you look at this, it's not really `cleaner` per-say, but
it's a good example of how powerful these operations can really be!

```java
void main(String[] args) {

    Supplier<AtomicInteger> initializer = () -> new AtomicInteger(0);

    // Integrator
    // 1 <AtomicInteger> – the type of state used by this integrator 
    // 2 <Integer> – the type of elements this integrator consumes 
    // 3 <Integer> – the type of results this integrator can produce
    Gatherer.Integrator<AtomicInteger, Integer, Integer> integrator =
            (state, element, downstream) -> {
                int index = state.getAndIncrement();
                // We want to simply remove the second element from the list
                if (index != 1) {
                    downstream.push(element);
                }
                return true;
            };

    var mylist = Stream.of(1, 2, 3)
            .map(integer -> integer + 10)
            .gather(Gatherer.ofSequential(initializer, integrator))
            .map(integer -> integer + 20)
            .toList();
    System.out.println(mylist);
}
```

```bash
 $ javac demo.java --enable-preview -source 23
 $ java --enable-preview demo
 [31, 33]
```

From this simple example, we can see how extemely powerful this operation can be, allowing us
to bring in ANY state and mutate it, while also making filtering decisions. Since we can define
the output type, we can also perform mapping operations... Which is an excellent pivot into the next topic!

## Gatherer Operations

First, a quick terminology overview:

Streams begin with a source (Stream.of() or myList.stream(), for example). Sources are followed by intermediate operations
such as map, filter, flatMap, etc. Finally, there is a terminating operation that closes the stream and emits a final object.

There are simple terminating stream operators such as .toList or .toSet. However, Gatherers are similar to .collect. .collect
is a terminating stream operation, but it allows you to override a Collector and control the output of the stream.

### Three Gatherer Functions

Gatherers are designed to transform elements in a one-to-one, one-to-many, many-to-one or many-to-many fashion.

#### Initializer

The initializer function sets up a mechanism for storing data while
processing stream elements. A gatherer can use this to store the
current element and compare it to incoming elements, emitting only
the larger one. This effectively combines two input elements into one
output element.

#### Integrator

The integrator is responsible for processing incoming elements and 
producing new output based on the current data and internal state. 
It can terminate the process prematurely, such as a gatherer that 
stops searching for the largest integer once it finds Integer.MAX_VALUE.

#### Finisher

The finisher function is executed once all input elements have been 
processed. It can analyze the collected data and generate a final output. 
For example, a gatherer searching for a specific element might throw an 
exception if it's not found when the finisher is called.

##### Examples

This is an example of a basic mapping integrator.

```java
// C is the type being consumed, P is the type being produced
Integrator<Void, C, P> integrator =
        (state, element, downstream) -> {
            // we can ignore the state for a simple mapper
            var result = someMapperFunction.apply(element);
            // We emit the result to the next iteration after applying the mapping
            downstream.push(result);
            // Continue to process items in the stream
            return true;
        };
Gatherer.of(integrator);
```

Next, here is an example recreating the `.limit` stream operation, that uses an integrator and initializer

```java
import java.util.concurrent.atomic.AtomicInteger;

Supplier<AtomicInteger> initializer = () -> new AtomicInteger(0);
Integrator<AtomicInteger, Integer, Integer> integrator =
        (state, element, downstream) -> {
            // Edit our state for the current index
            int currIndex = state.getAndIncrement();
            // Only push through results if within the stream size
            if(currIndex < someStreamSize) {
                downstream.push(element);
            }
            // Return whether the next index will be within stream size
            return currIndex + 1 < someStreamSize;
        };
Gatherer.ofSequential(initializer, integrator);
```

## Built-In Gatherers

The following are built-in gatherers in the [java.util.stream.Gatherers][gatherers-javadoc] class:

[fold][fold] is a stateful many-to-one gatherer which constructs an aggregate 
incrementally and emits that aggregate when no more input elements exist.

[mapConcurrent][mapConcurrent] is a stateful one-to-one gatherer which invokes a supplied 
function for each input element concurrently, up to a supplied limit.

[scan][scan] is a stateful one-to-one gatherer which applies a supplied function 
to the current state and the current element to produce the next element, 
which it passes downstream.

[windowFixed][windowFixed] is a stateful many-to-many gatherer which groups input 
elements into lists of a supplied size, emitting the windows 
downstream when they are full.

[windowSliding][windowSliding] is a stateful many-to-many gatherer which groups input 
elements into lists of a supplied size. After the first window, each 
subsequent window is created from a copy of its predecessor by dropping 
the first element and appending the next element from the input stream..

[soby-chako]: https://github.com/sobychacko
[openjdk23]: https://openjdk.org/projects/jdk/23/
[jeps473]: https://openjdk.org/jeps/473
[gatherer-javadoc]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherer.html
[gatherers-javadoc]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html
[windowFixed]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html#windowFixed(int)
[windowSliding]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html#windowSliding(int)
[fold]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html#fold(java.util.function.Supplier,java.util.function.BiFunction)
[scan]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html#scan(java.util.function.Supplier,java.util.function.BiFunction)
[mapConcurrent]: https://docs.oracle.com/en/java/javase/23/docs/api/java.base/java/util/stream/Gatherers.html#mapConcurrent(int,java.util.function.Function)
