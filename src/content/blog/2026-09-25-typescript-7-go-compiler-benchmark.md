---
author: StevenPG
pubDatetime: 2026-09-25T16:00:00.000Z
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

> **[DRAFT NOTE: numbers pending]** The migration findings and the npm gotcha are real. The timing tables are
> placeholders until the run on my M3 MacBook Pro. Parallelism results from a 4-core cloud container would undersell
> TypeScript 7.

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
| coding-steve   |   _TBD_ |                    _TBD_ |                _TBD_ |          _TBD_ |            _TBD_ | _TBD_ |
| cesium-spatial |   _TBD_ |                    _TBD_ |                _TBD_ |          _TBD_ |            _TBD_ | _TBD_ |
| playwright     |   _TBD_ |                    _TBD_ |                _TBD_ |          _TBD_ |            _TBD_ | _TBD_ |

### Scaling with `--checkers` (playwright)

|        Checkers | Wall s | CPU s | Peak RSS MiB |
| --------------: | -----: | ----: | -----------: |
| single-threaded |  _TBD_ | _TBD_ |        _TBD_ |
|               1 |  _TBD_ | _TBD_ |        _TBD_ |
|               2 |  _TBD_ | _TBD_ |        _TBD_ |
|     4 (default) |  _TBD_ | _TBD_ |        _TBD_ |
|               8 |  _TBD_ | _TBD_ |        _TBD_ |

### Memory

| Target         | `tsc 6` peak RSS MiB | `tsc 7` peak RSS MiB |
| -------------- | -------------------: | -------------------: |
| coding-steve   |                _TBD_ |                _TBD_ |
| cesium-spatial |                _TBD_ |                _TBD_ |
| playwright     |                _TBD_ |                _TBD_ |

## What to look for

A preliminary run in a 4-core cloud container is too noisy to publish, but it had a clear shape that surprised me.
Here's what to check against the M3:

- **Most of the 10× is native code, not threads.** With `--singleThreaded`, TypeScript 7 was already 3.5–4.8×
  faster than TypeScript 6 on all three targets. Parallelism added another 1.1–1.35× on top, on 4 cores. On the
  two small codebases most of the win is startup: Node has to load and JIT-warm a very large JavaScript compiler
  before it checks a single file, and a Go binary doesn't.
- **Checkers cost memory, and too many cost time.** On Playwright, peak RSS rose from about 750 MiB single-threaded
  to about 1.1 GiB at the default 4 checkers and about 1.45 GiB at 8. On a 4-core machine, 8 checkers was _slower_
  than 4. That's the classic oversubscription curve, and a good reason to set `--checkers` from your runner's core
  count rather than just raising it.
- **TypeScript 6 spends about twice its wall time in CPU**, on Node's GC and JIT threads. `tsc 7 --singleThreaded`
  spends about 1.2×. That's the "no JIT warm-up, GC mostly idle" story from Cavanaugh's explanation, visible in `rusage`.
- **Identical diagnostics everywhere.** Same error count from every configuration on every target. The port claim
  (same semantics, same answers) held.

On the M3's performance cores, I expect the parallel share to grow and the total to approach Microsoft's 8–12×.
The native share shouldn't move much.

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

# What I'd do

- **Upgrade CI type-checking first.** It's the easiest win: no API consumers, and the speedup lands on every pull request.
- **Fix `baseUrl` and friends while you're on 6.** Everything TypeScript 7 rejects, TypeScript 6 already warns or errors on.
- **Keep TypeScript 6 for tools that need the API**, and check which `tsc` your scripts are actually running.
- **Look at `--checkers` if your CI runners have more than 4 cores.** The default is 4. The scaling table shows
  whether more helps your codebase.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/typescript-7-go-compiler-benchmark
npm install
python3 scripts/bench.py prepare
python3 scripts/bench.py run
```

Add your own repo to `targets.json` with a pinned commit and its install command.
