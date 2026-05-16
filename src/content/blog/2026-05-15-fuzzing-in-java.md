---
author: StevenPG
pubDatetime: 2026-05-15T12:00:00.000Z
title: "The Ultimate Guide to Fuzz Testing in Java"
slug: ultimate-guide-fuzzing-in-java
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - testing
  - fuzzing
  - spring boot
  - security
description: A hands-on introduction to fuzz testing for developers. What fuzzing is, how Go bakes it into the standard library, and how to do coverage-guided fuzzing in Java with Jazzer, including the regression-corpus loop that locks every discovered bug in forever.
---

# The Ultimate Guide to Fuzz Testing in Java

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This one started with a detour.

I was writing some Go recently and went looking for a testing helper, and I kept tripping over `testing.F`, the fuzzing harness that has been part of Go's standard `testing` package since Go 1.18. Not a library. Not a plugin. Fuzzing, sitting right next to `testing.T` and `testing.B`, available the moment you have a Go toolchain installed. You write `func FuzzParse(f *testing.F)`, run `go test -fuzz`, and the toolchain starts generating inputs and hunting for crashes.

That got me wondering what this looks like in Java. I write a lot more Spring Boot than Go, and "fuzzing" in the JVM world had always felt like a security-research thing, something other people did to other people's parsers. It turns out the Java story is pretty good. It's just not in the standard library, and almost nobody talks about it.

So this post is two things. First, an introduction to fuzzing for developers who have never written a fuzz test: what it is, why it finds bugs your unit tests never will, and how Go's built-in support works as a reference point. Second, a hands-on guide to doing the same thing in Java with **Jazzer**, walking through a small Spring Boot project that ships with three deliberately planted bugs — yours to find with the fuzzer and then fix.

If you've never fuzzed anything, read straight through. If you already know the concept and just want the Java mechanics, skip to [Fuzzing in Java with Jazzer](#fuzzing-in-java-with-jazzer).

The companion project is on GitHub: [DemosAndArticleContent/blog/fuzzing-in-java](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/fuzzing-in-java).

## What Is Fuzzing?

A normal unit test checks the inputs you thought of. You write `assertEquals`, you pick a few representative values, maybe a `null` and an empty string if you're being thorough, and you move on.

A **fuzzer** checks the inputs you didn't think of. It throws a large, continuously-mutating stream of generated input at your code and watches for it to misbehave: to crash, to throw an unhandled exception, to hang, to corrupt state. The whole premise is that the bugs that survive into production are the edge cases nobody enumerated. The empty string, the gigantic number, the embedded null byte, the malformed UTF-8, the value one past a boundary, the deeply-nested JSON.

The naive version of this idea, "generate random bytes and feed them in," is decades old and not very effective. Random input bounces off the shallow surface of your program and almost never reaches the interesting code deep inside. What makes modern fuzzing actually work is one addition.

### Coverage Guidance

A coverage-guided fuzzer instruments your code so that, for every input it runs, it can see which branches that input reached. It then runs a feedback loop:

1. Start with a seed input (or an empty one).
2. Mutate it: flip bits, splice bytes, increment numbers, copy chunks around.
3. Run the mutated input and record the code coverage it produced.
4. If the mutation reached a new branch, keep it as a building block. If it didn't, discard it.
5. Repeat, millions of times.

This turns blind random search into something closer to a directed exploration. The fuzzer effectively reverse-engineers your control flow. It discovers that a certain byte pattern gets past the JSON parser, then that a certain key gets past validation, then that a certain value reaches the one line you forgot to guard. Each discovery becomes the seed for the next. This is the technique behind AFL, libFuzzer, Go's native fuzzer, and the subject of this post, Jazzer on the JVM.

### Fuzzing vs. Property-Based Testing

If you've used jqwik or QuickCheck, fuzzing will feel familiar. Both generate inputs instead of hard-coding them. The difference is the feedback loop. Property-based testing generates inputs from a distribution you describe and checks a property. Coverage-guided fuzzing generates inputs from what the code does with them, steering toward unexplored branches. They overlap, and modern tools blur the line, but the mental model is that property testing samples your spec while fuzzing explores your binary.

## How Go Made Fuzzing Boring

Before the Java material, it's worth seeing the thing that sent me down this path, because it sets the bar.

In Go, a fuzz test is just a function in a `_test.go` file:

```go
func FuzzReverse(f *testing.F) {
    f.Add("hello")          // seed corpus entry
    f.Fuzz(func(t *testing.T, s string) {
        rev := Reverse(s)
        doubleRev := Reverse(rev)
        if s != doubleRev {
            t.Errorf("reverse twice != original: %q", s)
        }
    })
}
```

`go test` runs this as an ordinary regression test, replaying the seed corpus. Add `-fuzz=FuzzReverse` and the toolchain starts the coverage-guided loop, generating new strings until it finds one that breaks the property. When it does, it writes the failing input to a file in `testdata/fuzz/`, and that file becomes a permanent regression test that every future `go test` run replays.

That last part is the key insight, and it carries over directly to Java. A discovered bug isn't a log line you might lose. It's a committed artifact that fails the build until fixed and can never silently come back. Hold onto that idea.

The reason Go feels so frictionless is that it's all in the standard library. Java doesn't have that. But it has something close.

## Fuzzing in Java with Jazzer

[Jazzer](https://github.com/CodeIntelligenceTesting/jazzer) is the de-facto standard coverage-guided fuzzer for the JVM. It's built by Code Intelligence on top of libFuzzer, it's what Google's [OSS-Fuzz](https://github.com/google/oss-fuzz) uses to continuously fuzz open-source Java projects, and it has a JUnit 5 integration that makes a fuzz test look almost exactly like a normal test.

Here's the entire dependency footprint. From the demo's `build.gradle.kts`:

```kotlin
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")

    testImplementation("org.springframework.boot:spring-boot-starter-test")

    // Jazzer: the most widely used Java fuzzing framework.
    // @FuzzTest methods run as regression tests during `./gradlew test` (corpus replay mode).
    // Set JAZZER_FUZZ=1 or pass -Djazzer.fuzz=true to run live coverage-guided fuzzing.
    testImplementation("com.code-intelligence:jazzer-junit:0.24.0")
}
```

One `testImplementation` line. That's it. `jazzer-junit` brings a `@FuzzTest` annotation and a JUnit 5 extension. Everything else is the Spring Boot app you're fuzzing.

There's one configuration block worth understanding:

```kotlin
tasks.withType<Test> {
    useJUnitPlatform()

    // Scope Jazzer's coverage instrumentation to our own application code.
    systemProperty("jazzer.instrument", "com.stevenpg.fuzzingdemo.**")

    testLogging {
        events("passed", "skipped", "failed")
        showExceptions = true
        showCauses = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
```

`jazzer.instrument` tells Jazzer which classes to add coverage tracking to. You want this scoped to your own code. If you let Jazzer instrument all of Spring and the JDK, the coverage signal is drowned in framework noise and the fuzzer wastes its budget exploring branches in `DispatcherServlet` that you can't fix anyway. Point it at your packages and the coverage-guided search stays focused on the code you actually own.

> **A note on Java versions.** The demo runs on a Java 25 JVM but compiles to Java 21 bytecode (`options.release = 21`). Jazzer 0.24's bundled ASM can't yet parse Java 25 class files, and Jazzer has to read your bytecode to instrument it. Targeting 21 is a zero-cost shim as long as you don't use Java-25-only APIs. If you fuzz, watch your toolchain. The fuzzer needs to be able to read your classes.

## The Demo Project

The companion repo is a small Spring Boot 4 REST API. It exposes twelve endpoints across three controllers (Users, Products, and Orders), and every endpoint is a stub that returns canned data. There's no database, no business logic to speak of. That's deliberate. The point isn't the logic, it's the inputs. Every path variable, every query parameter, every request body is attack surface, and that surface is what we fuzz.

Jakarta Bean Validation runs on every endpoint, so a lot of garbage input is rejected at the door with a `400`. The interesting bugs are the ones that get past validation and crash in the controller body anyway.

The project ships with **three deliberately planted bugs**, one in each controller. The test suite starts fully green — no crash inputs are pre-committed. Your job is to run the fuzzer, let it find the bugs, commit each crash file to lock the failure in, and then fix the code. That loop — fuzz, find, lock, fix — is the entire workflow this post is about.

## Anatomy of a Fuzz Test

A Jazzer fuzz test is a JUnit 5 method annotated with `@FuzzTest`. Here's the simplest one in the project, from `UserControllerFuzzTest`:

```java
@SpringBootTest
class UserControllerFuzzTest {

    @Autowired
    private WebApplicationContext wac;

    private MockMvc mockMvc;

    @BeforeEach
    void setup() {
        this.mockMvc = MockMvcBuilders.webAppContextSetup(wac).build();
    }

    @FuzzTest
    void fuzzSearchByName(byte[] data) throws Exception {
        // The raw fuzz bytes ARE the query-parameter value.
        String name = new String(data, StandardCharsets.UTF_8);

        mockMvc.perform(get("/api/users")
                        .param("name", name))
                // ASSERTION: status must be < 500. 400 is fine; 500 is a bug.
                .andExpect(status().is(lessThan(500)));
    }
}
```

If you've written a Spring `MockMvc` test, the only unfamiliar thing here is the method signature. Instead of taking no arguments, a `@FuzzTest` method takes a fuzzed input parameter. Jazzer supplies that parameter. Everything else (`@SpringBootTest`, `@Autowired`, `MockMvc`) is the testing setup you already know.

The method body does exactly one job: drive a request from the fuzzed input and assert an invariant. We'll come back to the invariant, `status < 500`, in a later section because it's worth its own discussion. First, the input.

### Two Ways to Receive Fuzzed Input

Jazzer can hand your test data in two shapes, and the demo uses both so you can compare them.

**`byte[] data`, where the raw bytes are the input.** Works well when the target is itself a byte stream — a parser, a single query parameter. Seed corpus files are literal: you can open and read them. The downside is important: validation layers absorb most random bytes as `400`, leaving the fuzzer with no coverage signal to guide it deeper. If your endpoint has required fields or a typed body, raw bytes bounce off the validation layer and the fuzzer never reaches the code you care about. `fuzzSearchByName` above uses this style; the raw bytes become the `name` parameter.

**`FuzzedDataProvider data`, a typed-value cursor.** Use this to assemble structured, multi-field requests so that Bean Validation always passes and the fuzzer explores controller logic instead of stalling at the rejection layer. `FuzzedDataProvider` hands out typed values on demand (`consumeInt()`, `consumeString(maxLength)`, `consumeBoolean()`, `consumeRemainingAsBytes()`), and Jazzer mutates those typed values intelligently. Note that seed corpus files are opaque binary (the raw byte stream `FuzzedDataProvider` consumed), but the crashing request body is printed in the `AssertionError` message when a crash is replayed in regression mode.

Here's the `FuzzedDataProvider` style, from `ProductControllerFuzzTest#fuzzListProducts`:

```java
@FuzzTest
void fuzzListProducts(FuzzedDataProvider data) throws Exception {
    String category = data.consumeString(50);
    String minPrice = data.consumeString(20);
    String maxPrice = data.consumeString(20);
    String sortBy   = data.consumeString(20);
    String sortDir  = data.consumeString(10);
    int    page     = data.consumeInt();
    int    size     = data.consumeInt();

    mockMvc.perform(get("/api/products")
                    .param("category", category)
                    .param("minPrice",  minPrice)
                    .param("maxPrice",  maxPrice)
                    .param("sortBy",    sortBy)
                    .param("sortDir",   sortDir)
                    .param("page",      String.valueOf(page))
                    .param("size",      String.valueOf(size)))
            .andExpect(status().is(lessThan(500)));
}
```

Seven independent fuzzed values, each consumed in order from the same provider. Jazzer knows `page` is an `int` and will deliberately try `0`, `-1`, `Integer.MAX_VALUE`, and `Integer.MIN_VALUE`, the boundary values that break things, rather than hoping random bytes happen to decode to them.

The rule of thumb: use `byte[]` for one thing that's already bytes, and `FuzzedDataProvider` for several things that aren't.

## The Two Modes: Regression and Fuzzing

This is the part that makes Jazzer practical for everyday development, and it mirrors Go's design. A `@FuzzTest` method runs in one of two modes depending on how you launch the suite.

### Regression Mode, the default

```bash
./gradlew test
```

In regression mode, Jazzer does not generate anything. It replays a fixed set of inputs: the empty input, plus every file already sitting in that test's seed corpus directory. Each corpus file becomes its own JUnit test invocation.

This is fast, deterministic, and CI-friendly. It runs in milliseconds alongside your normal unit tests. It's not finding new bugs, it's guarding against the ones you already found coming back. Once you've run fuzzing mode and committed a crash file, regression mode replays it on every `./gradlew test` run — the build stays red until someone fixes the code.

### Fuzzing Mode, the search

```bash
JAZZER_FUZZ=1 ./gradlew test
```

Set the `JAZZER_FUZZ=1` environment variable and the same `@FuzzTest` methods switch into the real coverage-guided loop. Jazzer generates inputs, mutates them, measures coverage, and keeps the ones that reach new branches, the loop from the start of this post. Each `@FuzzTest` runs for up to five minutes by default.

You typically don't fuzz everything at once. You point it at one test:

```bash
JAZZER_FUZZ=1 ./gradlew test --tests "*.ProductControllerFuzzTest.fuzzCreateProduct"
```

The division of labor is straightforward. Fuzzing mode is for discovery, so you run it deliberately, locally when you're hunting or on a nightly CI job with a long time budget. Regression mode is for protection, and it runs on every commit. You don't pay the five-minute fuzzing cost on every push. You pay the millisecond replay cost, and the replay cost is what catches regressions.

## Crashes Become Regression Tests

This is the most important thing about the whole workflow, and the thing the project is built to demonstrate.

When Jazzer is in fuzzing mode and an input triggers an unhandled exception, it doesn't just print a stack trace and exit. It writes the exact crashing bytes to a file in the seed corpus directory.

The corpus directory follows a strict naming convention:

```
src/test/resources/<package-as-path>/<TestClassName>Inputs/<methodName>/
```

So a crash found by `UserControllerFuzzTest#fuzzSearchByName` lands in:

```
src/test/resources/com/stevenpg/fuzzingdemo/fuzz/UserControllerFuzzTestInputs/fuzzSearchByName/
```

The moment that file exists, regression mode picks it up automatically. You commit the file. From then on, every `./gradlew test` run replays that exact input, the build stays red until someone fixes the bug, and once it's fixed the same file proves it's fixed and proves it stays fixed. The bug can never be silently reintroduced, because the input that triggers it is a checked-in test artifact.

This is the loop in full:

```
fuzzing mode finds a crash
      │
      ▼
Jazzer writes the crashing input to a seed corpus file
      │
      ▼
you `git add` the corpus file
      │
      ▼
regression mode replays it on every commit, build is RED
      │
      ▼
you fix the bug
      │
      ▼
build is GREEN, and the corpus file guards it permanently
```

A discovered bug stops being a thing someone saw once in a log. It becomes a small, human-readable file in your repo that is part of your test suite. That separates fuzzing as a one-off security audit from fuzzing as a permanent part of your development process. It's the same guarantee Go gives you with `testdata/fuzz/`, and it's worth adopting the convention even before you write a single fuzz test.

## Finding Fresh Bugs

This is the loop you run when you want the fuzzer to discover new issues rather than replaying known ones.

### 1. Run a discovery session

```bash
JAZZER_FUZZ=1 ./gradlew test \
  --tests "*.ProductControllerFuzzTest.fuzzCreateProduct"
```

When Jazzer triggers a `5xx` it writes a file to the project root:

```
artifact_prefix='.../fuzzing-in-java/'; Test unit written to .../crash-<sha1hash>
```

Because `fuzzCreateProduct` builds the request manually and wraps the assertion, the console also prints the exact body that caused the crash:

```
java.lang.AssertionError: Crashing input: {"name":"x","price":1.00,"metadata":{"category":null}}
```

### 2. Place the crash file in the seed corpus

Move the generated file into the Jazzer seed corpus directory for the test method that found it:

```
src/test/resources/<package>/<TestClassName>Inputs/<methodName>/
```

For example:

```bash
mv crash-<sha1hash> \
   src/test/resources/com/stevenpg/fuzzingdemo/fuzz/ProductControllerFuzzTestInputs/fuzzCreateProduct/crash-null-category
```

Name it something that describes the bug. The filename becomes the test case name in Jazzer's output.

### 3. Verify regression mode catches it

```bash
./gradlew test --tests "*.ProductControllerFuzzTest.fuzzCreateProduct"
```

You'll see the named crash fail in milliseconds — no live fuzzing, no long wait:

```
ProductControllerFuzzTest > fuzzCreateProduct(FuzzedDataProvider) > crash-null-category FAILED
    java.lang.AssertionError: Crashing input: {...}
```

Commit the file. From this point on, CI fails on it until someone fixes the bug, and the fix is guarded against ever coming back.

### 4. Fix the bug, confirm the suite is green

Apply the fix, run `./gradlew test`, and watch the crash case turn from `FAILED` to `PASSED`. The seed file stays in the corpus permanently as a regression guard.

## Walking Through the Three Planted Bugs

Each planted bug has the same shape, and it's a realistic shape. The input passes Bean Validation and then crashes in the controller body. That combination is what makes them good fuzzing targets. Validation is the obvious guard, and these bugs live in the gap just past it.

### Bug 1: StringIndexOutOfBoundsException on a short search term

`GET /api/users` accepts an optional `name` filter. The controller builds a 3-character search prefix from it:

```java
@GetMapping
public ResponseEntity<List<Map<String, Object>>> searchUsers(
        @RequestParam(required = false) @Size(max = 100) String name,
        /* ...other params... */) {

    // The developer guarded null and empty, but not 1-2 character names.
    String prefix = (name != null && !name.isEmpty()) ? buildSearchPrefix(name) : "";
    /* ... */
}

private String buildSearchPrefix(String name) {
    // BUG: substring(0, 3) on a 1- or 2-character string throws.
    return name.substring(0, 3).toLowerCase();
}
```

Look at the guard: `name != null && !name.isEmpty()`. It's almost right. The developer thought about `null`, thought about `""`, and stopped. But `substring(0, 3)` needs a string of length 3 or more, and `"ab"` sails through every guard, through the `@Size(max = 100)` constraint, and straight into a `StringIndexOutOfBoundsException`.

This is the canonical fuzzing find. No human writes a test for `"ab"` specifically. It's not a representative value, it's not `null`, and it's not empty. But a fuzzer mutating the `name` bytes hits a 2-character string in milliseconds and catches the crash.

The fix:

```java
private String buildSearchPrefix(String name) {
    return (name.length() >= 3 ? name.substring(0, 3) : name).toLowerCase();
}
```

### Bug 2: NullPointerException from a null map value

`POST /api/products` accepts a request body with a `Map<String, String> metadata` field. The controller reads a value out of it:

```java
// metadata.get("category") can be null even when validation passed.
return request.metadata().get("category").toUpperCase();
```

Here's the subtle part. Jakarta Bean Validation has no built-in constraint that inspects the values inside a map. `@NotNull` on the field checks the map reference. `@Size` checks the map's entry count. Neither one looks at whether `metadata.get("category")` is null. So a body like this:

```json
{ "name": "Widget", "metadata": { "category": null } }
```

passes every declared constraint, reaches the controller, and `null.toUpperCase()` throws.

A coverage-guided fuzzer walks into this in steps, and you can almost watch it think. First it generates a body where `metadata` is present (new coverage), then it puts the key `category` inside the map (more coverage), then it sets that key's value to `null` (reaches the unguarded call). Each step is rewarded by the coverage signal, so the fuzzer keeps it and builds on it. When it finally triggers the NPE, it prints the exact crashing JSON body in the `AssertionError` so you know immediately what to commit to the corpus.

The fix:

```java
return Optional.ofNullable(request.metadata().get("category"))
        .map(String::toUpperCase)
        .orElse("UNCATEGORIZED");
```

### Bug 3: integer overflow in an order total

`POST /api/orders` computes an order total:

```java
int quantity  = request.quantity();
int unitPrice = request.unitPrice();

int total = quantity * unitPrice;   // BUG: 32-bit multiplication overflows
```

Bean Validation lets both `quantity` and `unitPrice` individually reach large values. But their product can exceed `Integer.MAX_VALUE` (2,147,483,647). With `quantity = unitPrice = 50000`, the true product is 2,500,000,000, which doesn't fit in a 32-bit `int`, so it silently wraps around to a negative number.

This is the bug class fuzzers were practically invented to find. No validation rule is violated. No exception is thrown at the multiplication itself, since Java integer overflow is silent. The only symptom is a wrong, negative number, and the fuzzer's habit of trying large `int` values walks straight into it.

The fix is to promote to 64-bit before multiplying:

```java
long total = (long) quantity * unitPrice;
```

Note the cast goes before the multiplication. `(long)(quantity * unitPrice)` would overflow in 32-bit first and then widen the already-wrong result. `(long) quantity * unitPrice` widens `quantity` first, so the whole multiplication happens in 64-bit.

### A note on human-readable findings

The demo also keeps a plain-English explanation of each crash in `src/main/resources/fuzzing-findings/`. A raw corpus file tells the build that something fails. A findings note tells the next developer why. When you adopt this workflow on a real project, pairing each committed crash input with a short written explanation is a habit worth keeping. The corpus file is the test, and the note is the documentation.

## The Invariant: Why "No 5xx" Is the Whole Game

Every fuzz test in the project asserts the same thing:

```java
.andExpect(status().is(lessThan(500)));
```

This deserves a real explanation, because choosing the right invariant is the hard part of fuzzing, harder than the tooling.

A fuzzer can only find a bug if it can recognize one. It needs an oracle: a property that is true for all correct behavior and false for a bug. If your invariant is too strict, every weird-but-valid input is a false alarm and you drown in noise. If it's too loose, real bugs slip through.

For a REST API, HTTP status codes give you a good oracle, as long as you draw the line in the right place:

- A `4xx` response (`400 Bad Request`, `404 Not Found`, `405 Method Not Allowed`, `415 Unsupported Media Type`) means your input was bad and the server correctly rejected it. For a fuzzer hurling garbage at an endpoint, a `4xx` is the expected, healthy response. It is not a bug. Keep exploring.
- A `5xx` response (`500 Internal Server Error`) means the server's own code threw an exception it didn't handle. No input should ever be able to cause this. A `5xx` is, by definition, a bug.

So the invariant "no input should ever produce a 5xx" is exactly the property we want. It's loose enough that valid rejections don't trip it, and strict enough that every unhandled exception does.

But this invariant only works if your application is disciplined about the `4xx` / `5xx` boundary, and that doesn't happen for free. The demo's `GlobalExceptionHandler` is what makes it true:

```java
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {
    // Overrides handleMethodArgumentNotValid(...)  -> 400 for @Valid body failures
    // Adds   handleConstraintViolations(...)        -> 400 for @RequestParam / @PathVariable failures
    // Adds   a last-resort @ExceptionHandler        -> 500 for anything genuinely unhandled
}
```

Extending Spring's `ResponseEntityExceptionHandler` is the important move. It ensures that framework-level failures (unparseable JSON, an unknown route, a wrong content type, a bean-validation failure) all come back as clean `4xx` responses. Once all the expected failure modes are nailed down as `4xx`, a `5xx` is left meaning exactly one thing: a code path your application didn't anticipate. That's the bug, and that's what the fuzzer records.

The takeaway generalizes beyond REST. Before you fuzz anything, decide what "broken" means and make sure your code reports it unambiguously. The fuzzer is only as good as the oracle you give it.

## Running the Demo

Clone the repo and verify the suite starts clean:

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent.git
cd DemosAndArticleContent/blog/fuzzing-in-java

./gradlew test
```

All tests pass. No crash files are pre-committed. Now pick a test and let Jazzer hunt:

```bash
JAZZER_FUZZ=1 ./gradlew test --tests "*.UserControllerFuzzTest.fuzzSearchByName"
JAZZER_FUZZ=1 ./gradlew test --tests "*.ProductControllerFuzzTest.fuzzCreateProduct"
JAZZER_FUZZ=1 ./gradlew test --tests "*.OrderControllerFuzzTest.fuzzCreateOrder"
```

When Jazzer finds a crash it prints the offending input and drops a file in the project root. Follow the steps in [Finding Fresh Bugs](#finding-fresh-bugs) to move that file into the seed corpus and commit it. The build goes red. Open the controller, find the comment marked `BUG:`, apply the fix from the walkthrough above, and re-run `./gradlew test`. The crash case turns green, the corpus file stays as a permanent guard, and you've completed the full fuzzing loop by hand.

## When Should You Actually Use This?

Fuzzing earns its keep wherever untrusted input meets non-trivial code:

- **Parsers and deserializers** like JSON, XML, protobuf, CSV, and custom binary formats. This is the home turf of fuzzing.
- **Public API boundaries** like REST controllers, gRPC handlers, and message-queue consumers. Anywhere the input comes from outside your trust boundary.
- **Anything doing arithmetic on external numbers**, where overflow, division, rounding, and currency bugs hide.
- **String slicing and indexing**, like `substring`, `charAt`, regex, and manual buffer handling.

It's less useful for code whose inputs are entirely internal and well-typed, where a property-based test or plain unit tests give you a better return on effort.

You don't need to fuzz everything. A handful of `@FuzzTest` methods over your real input boundaries, replayed cheaply on every commit and fuzzed hard on a nightly schedule, catches a class of bug that no amount of example-based testing will.

## Wrapping Up

Go made fuzzing feel like a default by putting it in the standard library. Java doesn't have that, but with one `testImplementation` line for `jazzer-junit`, a `@FuzzTest` annotation, and a clear invariant, you get the same thing: coverage-guided input generation, and crashes that turn themselves into permanent, committed regression tests.

The mechanics are easy. The two things worth taking away are the parts that aren't about tooling at all.

The first is to pick the right invariant. "No `5xx`" works because the application is disciplined about the `4xx` / `5xx` boundary. The fuzzer is only as smart as the oracle you hand it.

The second is to commit the crash files. A discovered bug should never be a log line you might lose. It should be a file in your repo that fails the build until it's fixed and guards against its own return forever.

Clone the demo, fuzz the three controllers to find the planted bugs, lock each crash into the corpus, then fix the code. Once the suite is green, point Jazzer at your own parsers and controllers. The bugs are already there. Fuzzing just finds them before your users do.

Thanks for reading, and happy fuzzing.
