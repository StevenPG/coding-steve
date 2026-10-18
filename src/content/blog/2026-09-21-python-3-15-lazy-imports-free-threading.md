---
author: StevenPG
pubDatetime: 2026-09-21T12:00:00.000Z
modDatetime: 2026-10-18T12:00:00.000Z
title: "Python 3.15 Lazy Imports and Free-Threading: A Benchmark for People Who Write CLIs and Services"
slug: python-3-15-lazy-imports-free-threading
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - python
  - performance
  - concurrency
description: Python 3.15 adds the lazy keyword for imports (PEP 810), a stable ABI for the no-GIL build, and a faster experimental JIT. A runnable benchmark of all three on 3.14 and 3.15, with and without free-threading, including the three different ways to turn lazy imports on and what each one actually defers.
---

## Table of Contents

[[toc]]

# Why this release is worth a benchmark

[Python 3.15.0](https://www.python.org/downloads/release/python-3150/) was released on **October 9, 2026**, a
week later than the originally scheduled October 1. Most releases come with a list of nice things that don't
change how your code performs. This one ships two things that do:

- **[PEP 810](https://peps.python.org/pep-0810/): explicit lazy imports.** `lazy import json` binds the name
  now and runs the import the first time you touch it. Every CLI with a heavy import block can start faster.
- **Free-threading grows up.** The no-GIL build has been installable since 3.13. In 3.15,
  [PEP 803](https://peps.python.org/pep-0803/) gives it a stable ABI (`abi3t`), so C extensions can ship one
  wheel for the free-threaded build instead of one per minor version. The ecosystem can now actually follow it.

Plus a third thing nobody seems to benchmark: the **experimental JIT** has been "significantly upgraded," and
it's in the standard builds, one environment variable away.

I write a lot of Java and like Python for tooling. So the questions I wanted answered were the ones a
tooling author asks. How much faster does my CLI start? Does the easy migration path work? Can threads finally
replace `multiprocessing` for CPU-bound work? And what does the free-threaded build cost when I don't use threads?

Everything is in
[DemosAndArticleContent/blog/python-3-15-lazy-imports-free-threading](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/python-3-15-lazy-imports-free-threading).
The interpreters come from `uv`, and every number below is **3.15.0 final against 3.14.8**. The tables are from my
M3 Pro MacBook (12 cores). I ran the same suite on a 4-core Linux cloud container as a second machine and quote it
wherever the two tell different stories; the absolute numbers there are 3× slower, so treat it as a check on shape,
not on speed. If you haven't moved to uv yet, [here's why you should](/posts/python-package-manager-uv).

# Lazy imports: three ways to turn them on

PEP 810 gives you three switches, and they don't do the same thing.

**1. The `lazy` keyword, per import.**

```python
lazy import json
lazy from pathlib import Path
lazy import xml.etree.ElementTree as ET
```

The name is bound to a proxy immediately. The actual import runs the first time anything touches it. It's only
allowed at module scope. Inside a function, a class body or a `try` block, it's a `SyntaxError`. So is
`lazy from x import *`.

**2. `__lazy_modules__`, per module, without new syntax.**

```python
__lazy_modules__ = ["json", "pathlib", "xml.etree.ElementTree"]

import json                          # lazy on 3.15
from pathlib import Path             # lazy on 3.15
import xml.etree.ElementTree as ET   # lazy on 3.15
import os                            # not listed: eager
```

On 3.15 the listed imports are lazy. **On 3.14 and earlier, `__lazy_modules__` is just an unused variable, and the
same file runs eagerly.** This is the migration path for anything that has to support more than one Python version.

**3. `-X lazy_imports=all` (or `PYTHON_LAZY_IMPORTS=all`), for the whole process.**

Every import becomes lazy. That includes the imports inside every third-party package you depend on, and that
turns out to matter more than I expected.

## The test subject

`fleetctl` is a small flight-log CLI with the kind of import block real tools accumulate: `asyncio`, `csv`,
`decimal`, `email`, `http.client`, `json`, `sqlite3`, `statistics`, `tomllib`, `urllib.request`, `xml.etree`,
`zipfile`, plus `requests` and `rich`. It has three subcommands:

- `version`: needs nothing
- `summary flights.csv`: needs `csv`, `json`, `statistics`
- `report flights.csv`: needs everything

The two lazy variants are _generated_ from the eager file by a script (`scripts/make_variants.py`), so the three
can't drift apart. The generated `lazy` variant is exactly what you'd get by adding the keyword to every line of
the import block.

## Modules actually imported

This is the deterministic half: count the modules `-X importtime` reports for each command. On 3.15, on macOS:

| Variant                       | `version` | `summary` | `report` |
| ----------------------------- | --------: | --------: | -------: |
| eager                         |       380 |       380 |      386 |
| `lazy` keyword                |    **61** |    **80** |      384 |
| `__lazy_modules__`            |    **61** |    **80** |      384 |
| eager + `-X lazy_imports=all` |    **54** |    **67** |  **266** |

On Linux the `report` column is one lower (385 and 383), because of platform-specific modules. The
`-X lazy_imports=all` count is 266 on both. Everything else is identical.

On 3.14, every variant that runs imports 376–383 modules. The `lazy` keyword variant doesn't run at all
(`SyntaxError: invalid syntax`), and `__lazy_modules__` quietly behaves exactly like eager. That's the point of it.

The last column is the interesting one. `report` uses every module in the import block, so the per-file variants
save nothing: all of them get reified. But `-X lazy_imports=all` _also_ defers the imports that `requests` and
`rich` make internally, and a lot of those are never touched by what `fleetctl` actually calls. That's 118 fewer
modules than the per-file variants (266 against 384), for a command that "uses everything."

## Startup time

Median wall time of a full process launch, over 30 launches after one warm-up (so `.pyc` files exist and the page
cache is warm):

| Interpreter | Variant                       | `version` ms | `summary` ms | `report` ms |
| ----------- | ----------------------------- | -----------: | -----------: | ----------: |
| 3.14        | eager                         |         82.3 |         83.2 |        97.7 |
| 3.14        | `__lazy_modules__`            |         86.4 |         89.3 |        90.4 |
| 3.15        | eager                         |         81.0 |         81.3 |        88.2 |
| 3.15        | `lazy` keyword                |     **18.4** |     **21.5** |        90.8 |
| 3.15        | `__lazy_modules__`            |     **18.6** |     **21.5** |        86.9 |
| 3.15        | eager + `-X lazy_imports=all` |     **18.2** |     **20.1** |    **68.8** |
| 3.15t       | eager                         |         89.4 |         89.0 |        96.4 |
| 3.15t       | `lazy` keyword                |     **20.5** |     **23.9** |        99.4 |
| 3.15t       | eager + `-X lazy_imports=all` |     **19.6** |     **22.2** |    **76.6** |

A bare `python -c pass` cost 11.6 ms on 3.15, 11.2 ms on 3.14 and 12.3 ms on 3.15t, so that's the floor for any row.

**The headline holds.** On 3.15, `fleetctl version` went from 81 ms to 18–19 ms, **more than 4× faster**, within
about 7 ms of the bare-interpreter floor. `summary` went from 81 ms to 20–22 ms. All three ways of turning laziness
on landed in the same place. The container was more dramatic still: 249 ms down to 36–38 ms, nearly 7×, because a
slower machine spends more of its startup in the imports you just deferred.

**Read the rest of the table with the noise in mind**, though there is much less of it than in my pre-release run.
The lazy rows now vary by well under a millisecond (standard deviations of 0.2–0.9 ms) and the eager rows by
1–10 ms. That is tight enough to trust the large gaps and still too loose to rank rows a few milliseconds apart.
The `report` column is where to be careful: every per-file variant loads every module the command uses, so the
87–99 ms spread there is noise, not a ranking. `__lazy_modules__` on 3.14 is the built-in control — it does
nothing on that version, and it still came out 7 ms "ahead" of eager on `report`.

**`-X lazy_imports=all` on `report`: fewer modules, and this time reliably faster.** It loaded 266 modules instead
of 386 and cut the median from 88 ms to 69 ms on 3.15 — 22% — with 21% on 3.15t and 27–28% on both builds in the
container. On my pre-release run this was within noise, so I called it a maybe. On 3.15.0 final it is the only
variant that speeds up the command that uses everything, and it's the reason to consider the process-wide switch
for a CLI you control end to end.

## Gotchas

These are all verified on 3.15.0:

- **Module-scope use defeats it.** `lazy from dataclasses import dataclass` followed by `@dataclass class P: ...`
  imports `dataclasses` at import time anyway, because the decorator runs then. Base classes, module-level
  constants and type aliases evaluated at import all do the same. Laziness pays off only when the first use is
  inside a function.
- **A missing module fails later.** `lazy import does_not_exist` succeeds. The `ModuleNotFoundError` comes when
  the name is first touched (the traceback does point at the import line). The optional-dependency idiom
  `try: import x / except ImportError:` can't be lazy anyway, because `lazy` inside `try` is a `SyntaxError`.
- **No `__future__` escape hatch.** `lazy` is a hard syntax error before 3.15. If you support 3.14, use
  `__lazy_modules__`.
- **`-X lazy_imports=all` is a sharp tool.** It changes when _other people's_ code runs its import-time side
  effects: plugin registration, monkey-patching, `logging.basicConfig` at import. Great for a CLI you control
  end to end. Test it before turning it on for a service. `sys.set_lazy_imports_filter()` exists to exempt
  modules that need to stay eager.
- **Check it with `python -X importtime`.** A lazily imported module shows up only when it's actually loaded.

# Free-threading: do threads finally scale?

`threads/scale.py` splits a fixed amount of pure-Python CPU work (total Collatz steps for 1 to 2 million)
across 1, 2 and 4 threads, keeps the best of three runs, and runs the same work in a 4-process
`ProcessPoolExecutor` as the "what you'd do today" baseline. It also checks `sys._is_gil_enabled()` at runtime,
because importing a C extension that isn't marked free-threading-safe can silently turn the GIL back on.

| Interpreter | GIL | 1 thread | 2 threads |         4 threads | 4 processes |
| ----------- | --- | -------: | --------: | ----------------: | ----------: |
| 3.14        | on  |  11.27 s |   10.92 s |           10.83 s |      3.09 s |
| 3.14t       | off |  11.02 s |    5.90 s | **3.00 s** (3.7×) |      2.99 s |
| 3.15        | on  |  11.29 s |   11.32 s |           11.29 s |      3.18 s |
| 3.15t       | off |  11.73 s |    6.25 s | **3.22 s** (3.6×) |      3.21 s |

- **The GIL builds don't scale at all.** On the M3, 1, 2 and 4 threads all landed within half a second of 11.3 s.
  On the 4-core container they got _measurably worse_ with more threads (0.9× at four), which is contention cost
  on top of no benefit. That is exactly what the GIL promises for CPU-bound Python.
- **The free-threaded builds scale nearly linearly.** About 1.9× at 2 threads and 3.5–3.7× at 4, on both machines.
  That matched the 4-process pool, **without the pickling, the memory copies or the process startup.**
- **There is a small single-thread tax, and this run can see it.** On one thread, 3.15t took 11.73 s against
  3.15's 11.29 s — about 4%, with 5% in the container. My pre-release run called this unmeasurable; two machines
  agreeing on 4–5% is more convincing than one machine finding nothing. (The 3.14 pair still disagrees with
  itself: 3.14t came out 2% _faster_ on the M3 and 8% slower in the container, so I wouldn't lean on it.)
  Startup costs a little too: a bare 3.15t interpreter was 0.7 ms slower than 3.15 on the M3 and 7.7 ms slower in
  the container.

For a Java developer, this is the headline. For the first time, a CPU-bound Python service can use a thread pool
the way a JVM service would. The remaining caveat is extensions. Every C extension you import has to declare
free-threading support, or the GIL comes back. The new `abi3t` stable ABI in 3.15 is what should make that
declaration common.

# The JIT: one environment variable

CPython's experimental JIT first shipped as a build-time option in 3.13. The uv-provided builds used here include
it, off by default, and `PYTHON_JIT=1` turns it on. The benchmark runs every interpreter a second time with it set,
and drops the row if `sys._jit.is_enabled()` says it didn't engage:

| Interpreter | 1 thread, JIT off | 1 thread, `PYTHON_JIT=1` | 4 processes, JIT off | 4 processes, `PYTHON_JIT=1` |
| ----------- | ----------------: | -----------------------: | -------------------: | --------------------------: |
| 3.14        |           11.27 s |                  11.14 s |               3.09 s |                      3.02 s |
| 3.15        |           11.29 s |               **5.48 s** |               3.18 s |                  **1.61 s** |

This is the most surprising result in the post:

- **3.15's JIT cut this loop's time by 51%.** It was 2.06× faster, with no code changes. The container got 44%
  (1.8×). 3.14's JIT did nothing useful here: 1% faster on one thread on the M3, 5% slower in the container.
  "Significantly upgraded" undersells it.
- **The JIT isn't available in the free-threaded builds.** On 3.14t and 3.15t it never engaged. You get the JIT
  or free-threading, not both.
- So, for now, **JIT plus a process pool beat free-threaded threads by 2×** for this workload: 1.61 s for four
  JIT-enabled processes against 3.22 s for four free-threaded threads. The container agreed (2.88 s against 5.48 s).
  Note also that a single JIT-enabled 3.15 thread (5.48 s) beat two free-threaded ones (6.25 s), so free-threading
  only pulls ahead here once you can keep four cores busy.

Two caveats. A tight integer loop is the JIT's best case, so don't expect the same on I/O-bound code or code that
spends its time in C extensions. And it's still labeled experimental.

# What I'd do

- **CLIs and developer tools: add `__lazy_modules__` now.** It's free on 3.14, it pays off on 3.15, and for
  subcommand-style tools the gain is the difference between sluggish and instant. Consider
  `PYTHON_LAZY_IMPORTS=all` in the tool's own entry-point wrapper, where you control every dependency.
- **CPU-bound services currently on `multiprocessing`: test on 3.15t.** Check `sys._is_gil_enabled()` after
  your imports. If it's still `False`, a thread pool may replace the process pool outright.
- **CPU-bound and not ready for 3.15t: try `PYTHON_JIT=1` in staging first.** It's one variable and it's easy to
  roll back. In this benchmark it produced the single fastest number anywhere in the post: four JIT-enabled 3.15
  processes finished in 1.61 s, against 3.22 s for four free-threaded threads.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/python-3-15-lazy-imports-free-threading
uv self update                     # needs uv 0.13+; older versions don't list the 3.15 builds
./scripts/setup.sh                 # uv installs 3.14, 3.14t, 3.15, 3.15t
python3 scripts/bench.py all
```

`setup.sh` prints the interpreter it actually resolved for each slot — check it. On a Homebrew-installed uv,
`uv self update` refuses and you want `brew upgrade uv` instead, and a `uv python install 3.14` that finds an
older 3.14 already installed will reuse it rather than fetch 3.14.8.
