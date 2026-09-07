---
author: StevenPG
pubDatetime: 2026-09-07T12:00:00.000Z
title: "Go 1.27's encoding/json/v2: You Already Upgraded"
slug: go-1-27-encoding-json-v2
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - golang
  - json
  - performance
description: Go 1.27 ships encoding/json/v2 and jsontext, and quietly reimplements encoding/json on top of them. Benchmarks from a real harness, the six behavioural differences that bite during migration, and the two that fail silently.
---

# Go 1.27's encoding/json/v2: You Already Upgraded

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Go 1.27 graduated `encoding/json/v2` and its low-level companion `encoding/json/jsontext` out of `GOEXPERIMENT=jsonv2`. Most coverage of this frames it as a new opt-in package.

That framing buries the part that matters: **`encoding/json` is now implemented on top of v2.** The moment you build with Go 1.27, every `json.Marshal` call in your codebase runs through the new engine. You did not opt in. You upgraded.

The answer up front: **the upgrade is safe, the new package is not a drop-in, and unmarshal got faster on every payload shape I measured.** v1's *behaviour* is preserved — I verified this rather than trusting it. Switching your imports to v2 is a separate decision with six behavioural changes attached, two of which fail silently.

Everything below comes from a project at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/go-1-27-json-v2). The benchmarks were run there, not quoted from release notes; the difference table is *generated* by running both packages against the same input rather than typed by hand.

## Part 1: What Happens When You Do Nothing

The compatibility claim is that v1 semantics are preserved through options the v1 package applies for you. That is a large claim, so the demo project asserts it directly — the four v1 behaviours most likely to have been quietly dropped:

```go
// Case-insensitive fallback matching
v1.Unmarshal([]byte(`{"NAME":"ada"}`), &d)      // d.Name == "ada"  ✓

// Duplicate names, last one wins
v1.Unmarshal([]byte(`{"name":"a","name":"b"}`), &d)  // d.Name == "b"  ✓

// nil slice and map marshal as null
v1.Marshal(Container{})     // {"items":null,"attrs":null}  ✓

// time.Duration as a nanosecond count
v1.Marshal(Timed{90 * time.Second})   // {"timeout":90000000000}  ✓
```

All four hold on 1.27.1. If you keep importing `encoding/json`, nothing about your program's behaviour changes.

Two caveats on that, both real:

**Error message text may differ.** The release notes say so explicitly. If you have tests asserting on JSON error strings — and plenty of codebases do, usually by accident — that is where the upgrade will surface. Assert on error *types* or `errors.Is`, not on `err.Error()`.

**There is a temporary escape hatch.** `GOEXPERIMENT=nojsonv2` restores the original implementation. It is documented as expected-to-be-removed, so treat it as buying one release to fix something, not as a place to live.

## Part 2: Is It Faster?

The release notes say marshal is "broadly at parity" and unmarshal is "significantly faster". I wanted to know where, and by how much.

The harness compares v1 and v2 across five payload shapes chosen to stress different parts of a codec: a small flat struct (per-call overhead), a 32-level nested struct (recursion), a 2,000-element telemetry batch (throughput), an escape-heavy document (UTF-8 and string handling), and a `map[string]any` (the reflection-heavy dynamic case). The corpus is generated from a fixed seed, so every run measures identical bytes, and a test asserts v1 and v2 marshal the fixtures to byte-identical JSON — without that guard the benchmark would be timing two different jobs.

`-count=10`, compared with `benchstat`. Negative means v2 is faster; `~` means no statistically significant difference.

```
                     │      v1      │                 v2                  │
                     │    sec/op    │   sec/op     vs base                │
Marshal/Small           649.0n ± 3%   679.2n ± 6%        ~ (p=0.353 n=10)
Marshal/Nested          6.676µ ± 5%   7.024µ ± 2%   +5.21% (p=0.004 n=10)
Marshal/Batch           917.9µ ± 4%   921.6µ ± 3%        ~ (p=0.393 n=10)
Marshal/Document        48.83µ ± 1%   48.94µ ± 3%        ~ (p=0.393 n=10)
Marshal/Dynamic         86.61µ ± 2%   60.01µ ± 5%  -30.71% (p=0.000 n=10)
Unmarshal/Small        1061.5n ± 2%   855.7n ± 3%  -19.39% (p=0.000 n=10)
Unmarshal/Nested        14.47µ ± 4%   13.19µ ± 9%   -8.80% (p=0.000 n=10)
Unmarshal/Batch         2.071m ± 5%   1.743m ± 8%  -15.86% (p=0.000 n=10)
Unmarshal/Document     119.50µ ± 2%   86.97µ ± 5%  -27.22% (p=0.000 n=10)
Unmarshal/Dynamic      147.77µ ± 4%   95.46µ ± 4%  -35.40% (p=0.000 n=10)
geomean                 39.58µ        34.07µ       -13.92%
```

**Unmarshal is faster on every shape**, from −8.8% on deeply nested structs to −35.4% on `map[string]any`. That is a consistent win rather than one good case carrying the average, and it confirms the upstream claim.

**Marshal is at parity on three of five shapes**, which also matches. The two exceptions are not mentioned upstream and are worth knowing:

- **`map[string]any` marshal is 30.7% faster**, and allocates 204 times instead of 404 — less than half. If your service logs or proxies dynamic JSON, this is the biggest single improvement in the table.
- **Deeply nested marshal is 5.2% *slower*.** At p=0.004 that is a real effect, not noise, though it is small and 32 levels of nesting is not a typical payload. If that shape is on your hot path, measure before assuming parity.

Allocations are otherwise identical between the two on every shape. The dynamic path is where v2's rewrite shows up: `map[string]any` unmarshal drops from 1,273 allocations to 793.

One caveat I want to be honest about: this ran in a shared cloud container, not on dedicated hardware. The v1-to-v2 *ratios* are trustworthy — both implementations ran interleaved on the same machine, ten times each, with benchstat reporting variance. The absolute ns/op figures are not a prediction for your hardware. If a number here would change a decision, run the harness on the box that serves your traffic.

## Part 3: The Six Differences

Now the part that matters if you actually switch imports. v2 has stricter, more interoperable defaults. Each difference below was observed by running both packages against the same input, along with the option that restores v1 behaviour.

I have sorted them by how likely they are to hurt you, which is *not* the same as how dramatic they look.

### The silent ones

**Case-insensitive field matching.** This is the one to worry about.

```go
in := []byte(`{"NAME":"ada"}`)   // against `json:"name"`

v1: Name="ada"
v2: Name=""
```

v1 fell back to case-insensitive matching of object names. v2 is case-sensitive. **No error is raised** — the field is simply left at its zero value. A producer sending `userId` against a `json:"userid"` tag worked yesterday and silently loses data today.

Restore with `v2.MatchCaseInsensitiveNames(true)`. If you serve traffic from clients you do not control, you almost certainly want this on.

**nil slices and maps.**

```go
v1.Marshal(Container{})  →  {"items":null,"attrs":null}
v2.Marshal(Container{})  →  {"items":[],"attrs":{}}
```

Arguably v2 is right — an empty collection is not a missing one. But anything downstream that distinguishes `null` from empty will see this: JSON Schema validators, strongly typed clients, diff-based change detection. Restore with `v2.FormatNilSliceAsNull(true)` and `v2.FormatNilMapAsNull(true)`.

### The loud ones

**`time.Duration` no longer marshals at all.**

```go
v1.Marshal(Timed{90 * time.Second})  →  {"timeout":90000000000}
v2.Marshal(Timed{90 * time.Second})  →  ERROR: json: cannot marshal from Go
    time.Duration within "/timeout": no default representation
```

v1 emitted the nanosecond count because `Duration` is an `int64` underneath. v2 refuses to guess, so *any* struct carrying a `time.Duration` fails outright. This is the change most likely to stop a migration on line one. The fix lives in the v1 package, which is easy to miss: `json.FormatDurationAsNano(true)`, imported from `encoding/json` and passed to a v2 call.

**Invalid UTF-8 is rejected**, on both marshal and unmarshal:

```
jsontext: invalid UTF-8 within "/name" after offset 8
```

v1 silently substituted U+FFFD, producing JSON that did not round-trip. RFC 8259 requires UTF-8. Restore with `jsontext.AllowInvalidUTF8(true)`.

**Duplicate object names are rejected:**

```
jsontext: duplicate object member name "name"
```

v1 took the last occurrence. This one is a security improvement, not just a tidiness one: two parsers in a request path disagreeing about which duplicate wins is a well-known primitive for auth bypass and request smuggling. Restore with `jsontext.AllowDuplicateNames(true)` if you must, but think about why you must.

### One difference that isn't

Unknown members are **ignored by default in both**. v2 merely adds `RejectUnknownMembers(true)` as an option. I checked because several write-ups imply v2 rejects them by default; it does not.

Turning it on is a compatibility decision rather than a safety one — it makes your service reject payloads from a newer client that added a field. Reasonable for internal APIs with lockstep deploys, usually wrong for public ones.

## Part 4: Migrating Deliberately

The lever that makes this manageable is `json.DefaultOptionsV1()`, which restores the entire v1 profile through v2's entry points in one option:

```go
import (
    v1 "encoding/json"
    v2 "encoding/json/v2"
)

v2.Unmarshal(data, &out, v1.DefaultOptionsV1())   // behaves exactly like v1
```

That lets you land the import change and the behaviour change as **separate commits**, which is the whole game on a large codebase. Move to the v2 API with the legacy profile, confirm nothing moved, then remove options one at a time with a test for each.

The profile I would reach for in most services keeps v2's strictness and restores only the two things that break real traffic rather than indicate a bug:

```go
func InteropProfile() v2.Options {
    return v2.JoinOptions(
        v2.MatchCaseInsensitiveNames(true),  // don't silently drop fields
        v1.FormatDurationAsNano(true),       // don't fail on time.Duration
    )
}
```

Duplicate names and invalid UTF-8 stay rejected. Those are malformed input, and now you find out.

## Part 5: What jsontext Actually Unlocks

`encoding/json/jsontext` is the syntax layer: a token reader and a token writer sharing a state machine. This is the genuinely new capability, and it is easy to overlook next to the performance numbers.

v1 could stream tokens with `json.Decoder`, but it could not re-emit them with structure preserved, and `json.RawMessage` still required you to model the document well enough to know where the raw parts were. With `jsontext` you can transform a document whose shape you do not know.

The demo implements field redaction — the case that shows up in every logging path that must not persist PII:

```go
func Redact(r io.Reader, w io.Writer, names ...string) error
```

It walks tokens, and when it hits a member name in the redact set it calls `d.SkipValue()` and writes a placeholder. Nothing is unmarshaled, so memory stays proportional to nesting depth and the largest single scalar rather than to document size. Because `SkipValue` walks the whole subtree, redacting an object works exactly like redacting a string.

The property that makes this worth reaching for is numeric fidelity. Values are copied as raw text:

```
input:      "raw_precision": 1.7976931348623157e308,  "big_int": 123456789012345678901234567890

jsontext:   "raw_precision": 1.7976931348623157e308,  "big_int": 123456789012345678901234567890
via map[string]any:
            "raw_precision": 1.7976931348623157e+308, "big_int": 1.2345678901234568e+29
```

The `map[string]any` round-trip that most people write destroyed the big integer. The token stream preserved it exactly.

One more thing worth stealing: v2 and `jsontext` errors carry a **JSON Pointer to the exact fault location**, which v1 errors did not. Pull it out with `errors.AsType`, itself new in Go 1.27:

```go
serr, ok := errors.AsType[*jsontext.SyntacticError](err)
// serr.JSONPointer → "/items/1/name"
```

Which turns "duplicate object member name" into `at /items/1/name (member "name"): duplicate object member name`. On a multi-megabyte payload from a partner system, that is the difference between a five-minute fix and an afternoon.

## Practical Adoption Checklist

- **Upgrading to 1.27 needs no JSON work.** v1 behaviour is preserved. Check your tests for assertions on JSON error strings; that is the realistic breakage.
- **Don't reach for `GOEXPERIMENT=nojsonv2`** except to unblock a release. It is going away.
- **Audit for `time.Duration` in JSON structs first** if you plan to adopt v2. It is a hard failure and it is everywhere in config and API types.
- **Then audit for case sensitivity**, which is harder because nothing errors. Grep your struct tags for names that differ from the wire format only by case, and check what your producers actually send.
- **Migrate with `DefaultOptionsV1()`**, then remove options one at a time.
- **Reach for `jsontext` when you are transforming JSON rather than consuming it** — redaction, filtering, passthrough with edits, anything where a `map[string]any` round-trip would lose precision or waste memory.
- **Expect the wins on decode.** If your service is marshal-dominated with static types, v2 is a correctness and API upgrade, not a speed one.

## Summary

- Go 1.27 reimplemented `encoding/json` on top of v2. You get the new engine automatically; **behaviour is unchanged**, verified, with error message text as the one documented exception.
- **Unmarshal is faster on every shape measured** — −8.8% to −35.4%, geomean −13.9% across the suite. Marshal is at parity on most shapes, **30.7% faster on `map[string]any`**, and ~5% slower on deeply nested structs.
- Adopting the v2 API is a separate decision with six behavioural changes. **Two are silent**: case-sensitive field matching and `null` versus `[]`/`{}` for nil collections.
- **`time.Duration` does not marshal under plain v2 at all.** Fix it with `json.FormatDurationAsNano(true)` from the v1 package.
- `json.DefaultOptionsV1()` makes the migration a two-commit job instead of a big-bang one.
- `jsontext` is the real new capability: transform documents you have not modelled, preserve exact numeric text, and get a JSON Pointer to the failure.

## Resources

- [Go 1.27 Release Notes](https://go.dev/doc/go1.27)
- [`encoding/json/v2` documentation](https://pkg.go.dev/encoding/json/v2)
- [`encoding/json/jsontext` documentation](https://pkg.go.dev/encoding/json/jsontext)
- [The demo project and full benchmark results for this post](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/go-1-27-json-v2)
- [The Ultimate Guide to Go 1.27 Generic Methods](/posts/ultimate-guide-go-1-27-generic-methods) (the other half of this release worth your time)
- [The Ultimate Guide to Go for Spring Developers](/posts/ultimate-guide-go-for-spring-developers) (if you are coming to Go from the JVM side)
