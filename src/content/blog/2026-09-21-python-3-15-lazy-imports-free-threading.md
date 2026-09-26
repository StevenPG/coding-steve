---
author: StevenPG
pubDatetime: 2026-09-21T12:00:00.000Z
title: "Python 3.15 Lazy Imports and Free-Threading: A Benchmark for People Who Write CLIs and Services"
slug: python-3-15-lazy-imports-free-threading
featured: false
draft: true
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

Python 3.15.0 is scheduled for October 1. Most releases come with a list of nice things that don't change
how your code performs. This one ships two things that do:

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
The interpreters come from `uv` (3.14.7, 3.14.7t, 3.15.0rc2, 3.15.0rc2t). If you haven't moved to uv yet,
[here's why you should](/posts/python-package-manager-uv).

> **[DRAFT NOTE: numbers pending]** Module counts and the syntax/behavior findings are real, and they don't depend
> on hardware. The timing tables are placeholders until the final run on my M3 MacBook Pro, and 3.15 should be
> final (not rc2) by then.

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

This is the deterministic half: count the modules `-X importtime` reports for each command. On 3.15:

| Variant                       | `version` | `summary` | `report` |
| ----------------------------- | --------: | --------: | -------: |
| eager                         |       381 |       381 |      387 |
| `lazy` keyword                |    **64** |    **83** |      385 |
| `__lazy_modules__`            |    **64** |    **83** |      385 |
| eager + `-X lazy_imports=all` |    **60** |    **73** |  **268** |

On 3.14, every variant that runs imports 377–384 modules. The `lazy` keyword variant doesn't run at all
(`SyntaxError: invalid syntax`), and `__lazy_modules__` quietly behaves exactly like eager. That's the point of it.

The last column is the interesting one. `report` uses every module in the import block, so the per-file variants
save nothing: all of them get reified. But `-X lazy_imports=all` _also_ defers the imports that `requests` and
`rich` make internally, and a lot of those are never touched by what `fleetctl` actually calls. That's 117 fewer
modules for a command that "uses everything."

## Startup time

Median wall time of a full process launch, 30 launches after one warm-up (so `.pyc` files exist and the page cache is warm):

| Interpreter | Variant                       | `version` ms | `summary` ms | `report` ms |
| ----------- | ----------------------------- | -----------: | -----------: | ----------: |
| 3.14        | eager                         |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.14        | `__lazy_modules__`            |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15        | eager                         |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15        | `lazy` keyword                |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15        | `__lazy_modules__`            |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15        | eager + `-X lazy_imports=all` |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15t       | eager                         |        _TBD_ |        _TBD_ |       _TBD_ |
| 3.15t       | `lazy` keyword                |        _TBD_ |        _TBD_ |       _TBD_ |

A bare `python -c pass` costs roughly 17–23 ms, so that's the floor for any row.

What the preliminary run showed, and what to confirm: on 3.15 `version` went from about 200 ms to about 30 ms,
**more than 6× faster** and close to the bare-interpreter floor. The two per-file variants were indistinguishable. And
`report` under `-X lazy_imports=all` was about a quarter faster than eager, even though it does all the work.

## Gotchas

These are all verified on 3.15.0rc2:

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

`threads/scale.py` splits a fixed amount of pure-Python CPU work (total Collatz steps for 1 to 1.5 million)
across 1, 2 and 4 threads, keeps the best of three runs, and runs the same work in a 4-process
`ProcessPoolExecutor` as the "what you'd do today" baseline. It also checks `sys._is_gil_enabled()` at runtime,
because importing a C extension that isn't marked free-threading-safe can silently turn the GIL back on.

| Interpreter | GIL | 1 thread | 2 threads | 4 threads | 4 processes |
| ----------- | --- | -------: | --------: | --------: | ----------: |
| 3.14        | on  |    _TBD_ |     _TBD_ |     _TBD_ |       _TBD_ |
| 3.14t       | off |    _TBD_ |     _TBD_ |     _TBD_ |       _TBD_ |
| 3.15        | on  |    _TBD_ |     _TBD_ |     _TBD_ |       _TBD_ |
| 3.15t       | off |    _TBD_ |     _TBD_ |     _TBD_ |       _TBD_ |

The shape to confirm on real hardware:

- **The GIL builds don't scale at all.** 1, 2 and 4 threads all took the same time, which is exactly what the
  GIL promises for CPU-bound Python.
- **The free-threaded builds scale nearly linearly.** About 1.8× at 2 threads and 3.6–3.7× at 4. That matched
  the 4-process pool, **without the pickling, the memory copies or the process startup.**
- **The single-thread tax is small.** 3.15t was around 5% slower than 3.15 on one thread, and it paid 10–30 ms
  more at startup.

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
| 3.14        |             _TBD_ |                    _TBD_ |                _TBD_ |                       _TBD_ |
| 3.15        |             _TBD_ |                    _TBD_ |                _TBD_ |                       _TBD_ |

The shape from the preliminary run is the most surprising result in this post:

- **3.15's JIT cut this loop's time by about 40%.** 3.14's JIT managed about 6%. "Significantly upgraded" undersells it.
- **The JIT isn't available in the free-threaded builds.** On 3.14t and 3.15t it never engaged. You get the JIT
  or free-threading, not both.
- So, for now, **JIT plus a process pool beat free-threaded threads** for this workload: four JIT-enabled
  processes finished well ahead of four free-threaded threads.

Two caveats. A tight integer loop is the JIT's best case, so don't expect the same on I/O-bound code or code that
spends its time in C extensions. And it's still labeled experimental.

# What I'd do

- **CLIs and developer tools: add `__lazy_modules__` now.** It's free on 3.14, it pays off on 3.15, and for
  subcommand-style tools the gain is the difference between sluggish and instant. Consider
  `PYTHON_LAZY_IMPORTS=all` in the tool's own entry-point wrapper, where you control every dependency.
- **CPU-bound services currently on `multiprocessing`: test on 3.15t.** Check `sys._is_gil_enabled()` after
  your imports. If it's still `False`, a thread pool may replace the process pool outright.
- **CPU-bound and not ready for 3.15t: try `PYTHON_JIT=1` in staging first.** It's one variable, it's easy to roll
  back, and in this benchmark it was the bigger win.

# Run it yourself

```bash
git clone https://github.com/StevenPG/DemosAndArticleContent
cd DemosAndArticleContent/blog/python-3-15-lazy-imports-free-threading
./scripts/setup.sh                 # uv installs 3.14, 3.14t, 3.15, 3.15t
python3 scripts/bench.py all
```
