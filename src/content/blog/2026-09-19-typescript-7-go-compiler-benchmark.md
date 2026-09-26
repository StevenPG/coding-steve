---
author: StevenPG
pubDatetime: 2026-09-19T12:00:00.000Z
title: "TypeScript 7 Is Written in Go: Where the 10x Actually Comes From"
slug: typescript-7-go-compiler-benchmark
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - golang
  - typescript
  - javascript
  - performance
description: TypeScript 7 ported the compiler from JavaScript to Go and type-checks 8-12x faster. A benchmark on three real repositories that splits the speedup into "native code" and "parallelism", plus the migration errors my own blog hit and an npm gotcha that makes npx tsc quietly run TypeScript 6.
---

## Table of Contents

[[toc]]

# The most interesting Go program of the year isn't written by Go people

TypeScript 7.0 went GA in July. The headline is speed: Microsoft's table shows VS Code type-checking in 10.6 s
instead of 125.7 s, and Playwright in 1.47 s instead of 12.8 s. The reason is that the compiler is no longer written in
TypeScript. It's a port, file by file and function by function, to Go.

I've been [writing](/posts/ultimate-guide-go-1-27-generic-methods) [about](/posts/go-1-27-encoding-json-v2) Go from
the point of view of someone who lives in Java, so this release is interesting to me for two reasons:

1. **It's a case study in why a team picked Go.** It's a huge, mature, performance-critical codebase, and the
   team chose Go over Rust and C#. They explained why.
2. **"10x faster" has two ingredients**, and the release notes don't separate them. Part is running as native code
   instead of JIT-compiled JavaScript. Part is that Go made it practical to type-check on several threads with shared
   memory. They matter differently to you depending on how many cores your CI runners have.

So I built a benchmark that separates them. The code is in
[DemosAndArticleContent/blog/typescript-7-go-compiler-benchmark](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/typescript-7-go-compiler-benchmark).

The numbers below are from my M3 Pro MacBook (12 cores, Node 24.16, TypeScript 6.0.3 against 7.0.2), with the median
of five runs after a warm-up.

# Why Go, and not Rust or C#?

Ryan Cavanaugh's [explanation](https://github.com/microsoft/typescript-go/discussions/411) is worth reading in full.
The short version is that this was a **port, not a rewrite**, and that decided it:

> "Idiomatic Go strongly resembles the existing coding patterns of the TypeScript codebase, which makes this porting
> effort much more tractable."

The TypeScript compiler is written in a functional style over big, cyclic graphs of AST nodes and types. Go's
garbage collector means those graphs port as they are. Rust's ownership model would have meant redesigning every
data structure before the first line was ported. And the usual objection to a GC barely applies to a batch compiler:

> "Batch compilations can effectively forego garbage collection entirely, since the process terminates at the end."

For those of us coming from Java this is a familiar trade: a GC'd language with good control over memory layout,
fast startup and real threads. Go's advantage over the JVM for a CLI is the part the TypeScript team didn't have to
say out loud: a single static binary that starts in milliseconds.

# The benchmark

## Configurations

| Configuration                | What it isolates                                                              |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `tsc 6`                      | the JavaScript compiler on Node: the baseline                                 |
| `tsc 7 --singleThreaded`     | the Go port with every form of parallelism off: **the "native code" speedup** |
| `tsc 7 --checkers 1 / 2 / 8` | the number of type-checking workers                                           |
| `tsc 7`                      | the default, 4 checkers: **native + parallel**                                |

TypeScript 7's parallelism is shared-memory. Parsing and binding fan out across files, and `--checkers N` splits
type-checking across N workers that each check a slice of the program. That's goroutines over one address space, not
worker processes passing serialized ASTs around, and it's the thing that was impractical in single-threaded
JavaScript.

## Targets

| Target                                     | Size   | Notes                                                                   |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------- |
| This blog                                  | small  | Astro 6 site, `tsc --noEmit` after `astro sync` generates content types |
| [cesium-spatial](/projects/cesium-spatial) | medium | my pnpm monorepo, three packages checked one after another              |
| microsoft/playwright                       | large  | also in Microsoft's own table, so it doubles as a sanity check          |

Each is pinned to a commit. Every configuration has to report the **same number of type errors** as TypeScript 6,
so a run can't look faster because it checked less. Five timed runs after a warm-up, median reported, with total CPU
time and peak RSS for each.

## Results

### Wall time

| Target         | `tsc 6` | `tsc 7 --singleThreaded` | `tsc 7` (4 checkers) | Native speedup | Parallel speedup | Total |
| -------------- | ------: | -----------------------: | -------------------: | -------------: | ---------------: | ----: |
| coding-steve   |  0.84 s |                   0.23 s |               0.12 s |           3.7× |             1.9× |  6.8× |
| cesium-spatial |  1.02 s |                   0.26 s |               0.19 s |           3.9× |             1.4× |  5.5× |
| playwright     |  5.18 s |                   1.65 s |               0.81 s |           3.1× |             2.0× |  6.4× |

"Native" is `tsc 6` against `tsc 7 --singleThreaded`. "Parallel" is `--singleThreaded` against the default.

### Scaling with `--checkers` (playwright)

|        Checkers | Wall s | CPU s | Peak RSS MiB |
| --------------: | -----: | ----: | -----------: |
| single-threaded |   1.65 |  2.22 |          778 |
|               1 |   1.41 |  2.77 |          763 |
|               2 |   1.05 |  3.53 |          896 |
|     4 (default) |   0.81 |  4.12 |        1,102 |
|               8 |   0.75 |  6.47 |        1,430 |

For comparison, `tsc 6` on the same target: 5.18 s wall, 9.95 s CPU, 1,274 MiB.

### Memory

| Target         | `tsc 6` peak RSS MiB | `tsc 7 --singleThreaded` | `tsc 7` (4 checkers) |
| -------------- | -------------------: | -----------------------: | -------------------: |
| coding-steve   |                  464 |                      192 |                  220 |
| cesium-spatial |                  258 |                       80 |                   89 |
| playwright     |                1,274 |                      778 |                1,102 |

## What the numbers say

**About 3–4× is just "native code".** With every form of parallelism off, TypeScript 7 was 3.1–3.9× faster than
TypeScript 6 on all three targets. A preliminary run on a 4-core cloud container got a similar 3.5–4.8×, so this
part barely depends on the machine. On the two small codebases the absolute times are tiny (0.84 s down to 0.23 s),
and much of the win is startup: Node has to load and JIT-warm a very large JavaScript compiler before it checks a
single file, and a Go binary doesn't.

**Parallelism is the other 1.4–2×, and it grows with the codebase.** The default 4 checkers roughly halved Playwright's
time again (1.65 s to 0.81 s), but only took cesium-spatial from 0.26 s to 0.19 s. There isn't much to split across
workers in a small program. On the 4-core container, the same step was worth only 1.1–1.35×.

**`--checkers 1` isn't single-threaded.** It was 1.7× faster than `--singleThreaded` on this blog and 1.2× on
Playwright. `--checkers` only controls _type-checking_ workers, and parsing and binding still fan out across files.
`--singleThreaded` turns all of it off. If you're benchmarking TypeScript 7 yourself, that's the flag that isolates the
native-code effect.

**More than 4 checkers bought little and cost a lot.** On Playwright, 8 checkers was 7% faster than 4 (0.75 s against
0.81 s) for 30% more peak memory (1,430 MiB, _more_ than TypeScript 6 used) and 57% more CPU. The default is close to
the sweet spot even on a 12-core machine.

**The total is 5.5–6.8×, not 10×, and that's because TypeScript 6 was fast here.** Microsoft's table has Playwright at
12.8 s → 1.47 s. On the M3 Pro, TypeScript 7 was faster than their result in absolute terms (0.81 s), but TypeScript 6
on Node 24 was also much faster (5.18 s), so the ratio is smaller. The slower your current CI type-check is, the bigger
your multiple will be.

**It uses much less CPU in total, not just wall time.** Even with 4 checkers running in parallel, TypeScript 7 used
4.1 s of CPU on Playwright against TypeScript 6's 10.0 s. TypeScript 6 spends about twice its wall time in CPU,
on Node's GC and JIT threads. If you pay for CI by the minute, that's the number that matters, and it also means
`--singleThreaded` (2.2 s of CPU) is a good option on shared runners.

**Identical diagnostics everywhere.** Every configuration reported the same errors as TypeScript 6 on every target:
4 on this blog (real ones; one turned out to be a broken RSS feed), 0 on cesium-spatial, and 12 on Playwright (modules from a build step the
benchmark doesn't run). The port claim, same semantics and same answers, held.

# Migrating: my own blog didn't compile

Before any of this worked, both compilers refused this blog's `tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": "src",
    "paths": { "@components/*": ["components/*"], "...": ["..."] }
  }
}
```

```
# tsc 6
error TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0.
# tsc 7
error TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
```

TypeScript 6 already treats `baseUrl` as an error, not a warning, unless you set `"ignoreDeprecations": "6.0"`. So
if you jumped from 5.x to 7, this is the first thing you'll hit. The fix is mechanical: drop `baseUrl` and make every
`paths` entry relative to the tsconfig:

```json
"paths": { "@components/*": ["./src/components/*"] }
```

The rest of the list of things that are now hard errors: `target: es5`, `downlevelIteration`, `moduleResolution`
`node`/`node10`/`classic`, `module` `amd`/`umd`/`system`/`none`, and setting `esModuleInterop` or
`allowSyntheticDefaultImports` to `false`. Defaults changed too: `strict` is on, `module` is `esnext`, and `types`
is `[]`, so `@types/*` packages are no longer picked up automatically. List the ones you need.

Playwright's config was already clean, which tells you something about who reads the deprecation warnings.

# The npm gotcha: `npx tsc` may still be TypeScript 6

TypeScript 7 ships without a programmatic API (it's planned for 7.1). Anything that does `import ts from "typescript"`,
like typescript-eslint's type-aware rules, ts-morph, or custom transformers, needs TypeScript 6 alongside. That's
what `@typescript/typescript6` is for: it installs a `tsc6` binary and the JavaScript API.

Here's the trap. `@typescript/typescript6` depends on `typescript@^6` under the npm alias **`@typescript/old`**, and
that package also declares a `tsc` binary. On npm 10.9.7, installing both linked `@typescript/old`'s `tsc` into
`node_modules/.bin` _over_ TypeScript 7's:

```bash
$ npm i -D typescript@7.0.2 @typescript/typescript6@6.0.2
$ npx tsc --version
Version 6.0.3
$ readlink node_modules/.bin/tsc
../@typescript/old/bin/tsc
```

It reproduced on every clean install. Your CI could be "on TypeScript 7" and still be running 6. Check
`npx tsc --version` after adding the compat package, and call `node_modules/typescript/bin/tsc` directly if you
need to be sure. The benchmark calls both compilers by path for exactly this reason.

# One more: the exit code changed

When `tsc --noEmit` finds type errors, TypeScript 6 exits with **2** and TypeScript 7 exits with **1**. The benchmark
records exit codes, and it was the same on every target with errors, on both machines I ran it on. If a CI script
or git hook checks for a specific status (`if [ $? -eq 2 ]`) rather than for non-zero, it'll behave differently after
the upgrade. Check for non-zero.

# What I'd do

- **Upgrade CI type-checking first.** It's the easiest win: no API consumers, and the speedup lands on every pull request.
- **Fix `baseUrl` and friends while you're on 6.** Everything TypeScript 7 rejects, TypeScript 6 already warns or errors on.
- **Keep TypeScript 6 for tools that need the API**, and check which `tsc` your scripts are actually running.
- **Leave `--checkers` at the default unless you've measured.** Going from 4 to 8 bought 7% on a large codebase for
  30% more memory. On small or memory-tight runners, try lowering it, or `--singleThreaded`, which still gave a
  3–4× speedup here.
- **Check exit codes, not just "did it fail".** Scripts that look for exit code 2 need updating.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/typescript-7-go-compiler-benchmark
npm install
python3 scripts/bench.py prepare
python3 scripts/bench.py run
```

Add your own repo to `targets.json` with a pinned commit and its install command.
