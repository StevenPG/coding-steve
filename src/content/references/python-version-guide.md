---
title: Python Version Guide
description: What's new in each Python 3 release, with support status marked and links to the official What's New notes.
slug: python-version-guide
pubDatetime: 2026-06-26T12:00:00.000Z
modDatetime: 2026-07-18T12:00:00.000Z
tags:
  - python
order: 3
---

A scannable "what's new" for modern Python 3 releases. Python ships one feature release per year (every **October**).

> **Python has no LTS**, but every release gets a fixed **~5-year** support window: roughly 2 years of bug fixes
> followed by 3 years of security-only fixes. For exact dates always check the
> [official version status page](https://devguide.python.org/versions/). Version numbers below link to the "What's New"
> notes.

## Release History

| Version                                                          | Released | Status        | Highlights                                                                                                |
| :-------------------------------------------------------------- | :------- | :------------ | :-------------------------------------------------------------------------------------------------------- |
| [3.14](https://docs.python.org/3/whatsnew/3.14.html)            | Oct 2025 | Active        | **Template strings (t-strings)**, free-threading officially supported, deferred annotation evaluation, `concurrent.interpreters` |
| [3.13](https://docs.python.org/3/whatsnew/3.13.html)            | Oct 2024 | Active        | Experimental **free-threaded (no-GIL)** build, experimental JIT, new interactive REPL, better error messages |
| [3.12](https://docs.python.org/3/whatsnew/3.12.html)            | Oct 2023 | Security-only | Type parameter syntax (PEP 695), per-interpreter GIL, improved f-strings, `type` statement                |
| [3.11](https://docs.python.org/3/whatsnew/3.11.html)            | Oct 2022 | Security-only | **10–60% faster** (Faster CPython), exception groups & `except*`, fine-grained tracebacks, `tomllib`      |
| [3.10](https://docs.python.org/3/whatsnew/3.10.html)            | Oct 2021 | Security-only | **Structural pattern matching** (`match`/`case`), much better error messages, `X \| Y` union types        |
| [3.9](https://docs.python.org/3/whatsnew/3.9.html)             | Oct 2020 | End of life   | Dict union operators (`\|`), builtin generic types (`list[int]`), `zoneinfo`, `str.removeprefix/suffix`   |
| [3.8](https://docs.python.org/3/whatsnew/3.8.html)             | Oct 2019 | End of life   | Walrus operator (`:=`), positional-only params (`/`), f-string `=` debugging, `typing.Protocol`           |
| [3.7](https://docs.python.org/3/whatsnew/3.7.html)             | Jun 2018 | End of life   | `dataclasses`, `breakpoint()`, deferred annotation imports, guaranteed dict ordering                      |
| [3.6](https://docs.python.org/3/whatsnew/3.6.html)             | Dec 2016 | End of life   | **f-strings**, variable annotations, async generators & comprehensions, `secrets`                         |

> **[Python 3.15](https://docs.python.org/3.15/whatsnew/3.15.html)** is due **October 1, 2026**, and as of mid-July
> 2026 it's feature-frozen and in beta. Headliners: **explicit lazy imports**
> ([PEP 810](https://peps.python.org/pep-0810/) &mdash; faster startup for big dependency trees), a **stable ABI for
> free-threaded CPython**, a noticeably faster JIT (~8&ndash;13% on the benchmark suite), a new zero-overhead sampling
> profiler, UTF-8 as the default text encoding ([PEP 686](https://peps.python.org/pep-0686/)), and a colorized CLI with
> SQL keyword tab-completion in `sqlite3`. Status labels above are approximate &mdash; the
> [devguide version page](https://devguide.python.org/versions/) is the source of truth for bugfix vs. security-only vs.
> EOL dates.

## How Python Support Works

- **No LTS branch.** Each annual release follows the same lifecycle: ~24 months of bug-fix releases, then security-only
  patches until it reaches roughly 5 years old.
- The **latest one or two releases** are the ones receiving regular bug fixes (the "Active" rows above). Older supported
  versions get security fixes only.
- **Free-threading** (PEP 703 / 779) is the big ongoing shift: experimental in 3.13, officially supported in 3.14. It
  removes the GIL but is still opt-in via a separate build.

## Sources

- [Python version status](https://devguide.python.org/versions/) &mdash; authoritative support & EOL dates
- [What's New in Python](https://docs.python.org/3/whatsnew/) &mdash; full release notes
- [endoflife.date/python](https://endoflife.date/python) &mdash; support timelines
