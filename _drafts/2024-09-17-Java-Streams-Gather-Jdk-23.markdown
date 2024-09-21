---
layout: post
title:  "Jdk 23 Streams - Using Gather"
toc: true
date: 2024-09-17 12:00:00 -0500
categories:
- software
- java
---

# It's finally here! JDK 23
TODO - make small XXXTODOXXX

Just kidding, this isn't an LTS release

The next LTS release that will include all of the changes in JDK 23 is XXXTODOXXX and 
that won't be available until XXXTODOXXX

We can install Java 23 quickly using Sdkman! using `sdk install java 23-tem`

The link to the release notes for Jdk23 are right here: https://openjdk.org/projects/jdk/23/

But this article is going to focus on a pretty powerful addition for anyone that's been
leveraging Java Streams heavily for stream processing!

Specifically Gatherers, the JEP is right over here: https://openjdk.org/jeps/473

## JEP-473

Stream Gatherers is a preview API delivered in JDK 22 that's in preview again
in JDK 23. Gatherers allow for stream pipelines to transform
data through intermediate operations instead of needing to perform
a terminating operation and generate a new stream.

Today, if we want to process a list of elements, then perform an operation on the entire list,
and then continue processing the list, we'd have to do it like this:

```java
TODO - add an example here
```
With Gatherers, we're able to do this in a cleaner way by
doing our extra processing in an intermediate method!

```java
TODO - add an example here
```

Here's the full example code (and we don't need a default class anymore with JDK 23!)

```java
import java.util.function.Predicate;
import java.util.stream.Gatherer;
import java.util.stream.Stream;

void main(String[] args) {

    var result = Stream.of(1, 2, 3) // The Stream
            .filter((integer -> integer > 0)) // Intermediate Operation
            // TODO - gather example
            .toList(); // The Terminal Operation
    System.out.println(result);
}

```

```bash
 $ javac demo.java --enable-preview -source 23
 $ java --enable-preview demo
```

TODO - find real life example
- distinctBy
- grouping and applying a change to the whole collection

[soby-chako]: https://github.com/sobychacko
