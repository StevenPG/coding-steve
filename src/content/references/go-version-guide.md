---
title: Go Version Guide
description: What's new in each major Go release, with support status marked and links to release notes.
slug: go-version-guide
pubDatetime: 2026-06-26T12:00:00.000Z
modDatetime: 2026-06-26T12:00:00.000Z
tags:
  - golang
order: 2
---

A scannable "what's new" for every major Go release. Go ships a major version roughly every **six months** (February
and August) under the [Go 1 compatibility promise](https://go.dev/doc/go1compat), so upgrades are almost always
painless.

> **Go has no LTS.** The Go team provides security and critical bug fixes for the **two most recent** major releases
> only. In practice, staying within one or two versions of the latest is the supported path &mdash; there is no
> long-term branch to pin to. Version numbers below link to the official release notes.

## Release History

| Version                                | Released | Highlights                                                                                                       |
| :------------------------------------- | :------- | :--------------------------------------------------------------------------------------------------------------- |
| [1.26](https://go.dev/doc/go1.26)      | Feb 2026 | **Green Tea GC default** (10–40% GC overhead reduction), self-referential generics, `go fix` rewrite with modernizers, `crypto/hpke`, `errors.AsType()`, `log/slog.NewMultiHandler()`, post-quantum TLS hybrids default, ~30% faster cgo calls |
| [1.25](https://go.dev/doc/go1.25)      | Aug 2025 | Container-aware `GOMAXPROCS`, experimental Green Tea GC, `testing/synctest` graduated, experimental `encoding/json/v2` |
| [1.24](https://go.dev/doc/go1.24)      | Feb 2025 | Generic type aliases, faster Swiss Table maps, tool dependencies in `go.mod` (`go tool`), `os.Root`, weak pointers, FIPS 140-3 |
| [1.23](https://go.dev/doc/go1.23)      | Aug 2024 | **Range-over-function iterators** (`iter`), `unique` package, timer/ticker GC improvements                       |
| [1.22](https://go.dev/doc/go1.22)      | Feb 2024 | **Per-iteration loop variables**, range over integers, enhanced `net/http` routing patterns, `math/rand/v2`      |
| [1.21](https://go.dev/doc/go1.21)      | Aug 2023 | `min`/`max`/`clear` builtins, `slices`/`maps`/`cmp` packages, structured logging (`log/slog`), PGO GA            |
| [1.20](https://go.dev/doc/go1.20)      | Feb 2023 | `errors.Join` (wrapping multiple errors), profile-guided optimization (preview)                                  |
| [1.18](https://go.dev/doc/go1.18)      | Mar 2022 | **Generics (type parameters)**, native fuzzing, multi-module workspaces                                          |
| [1.16](https://go.dev/doc/go1.16)      | Feb 2021 | `embed` package, modules on by default, `io/fs` abstraction                                                      |
| [1.13](https://go.dev/doc/go1.13)      | Sep 2019 | Error wrapping (`%w`, `errors.Is`/`errors.As`), new number literal syntax                                        |
| [1.11](https://go.dev/doc/go1.11)      | Aug 2018 | **Go Modules** (experimental), WebAssembly port                                                                  |
| [1.7](https://go.dev/doc/go1.7)        | Aug 2016 | `context` package moved into the standard library, SSA compiler backend                                          |
| [1.5](https://go.dev/doc/go1.5)        | Aug 2015 | Compiler & runtime rewritten in Go, concurrent low-latency GC, `GOMAXPROCS` defaults to all CPUs                 |
| [1.0](https://go.dev/doc/go1)          | Mar 2012 | First stable release &mdash; the Go 1 compatibility guarantee begins                                             |

> **[Go 1.27](https://go.dev/doc/go1.27)** is expected around **August 2026**. Work-in-progress release notes are already published — highlights include generic methods, `encoding/json/v2` GA, a new `uuid` package, `crypto/mldsa` (post-quantum ML-DSA), and ~30% faster small allocations. See the [release history](https://go.dev/doc/devel/release) for the latest published versions and the [milestone tracker](https://github.com/golang/go/milestones) for what's landing.

## How Go Support Works

- **No LTS, no exceptions.** Only the latest two major releases get fixes. Upgrading promptly is the intended workflow.
- The **compatibility promise** means code written for Go 1.x keeps compiling on later 1.y releases, which makes those
  frequent upgrades low-risk.
- Since 1.21, the **toolchain line in `go.mod`** lets a module request a minimum Go version and auto-download it.

## Sources

- [Go release history](https://go.dev/doc/devel/release) &mdash; official notes for every version
- [Go release policy](https://go.dev/doc/devel/release#policy) &mdash; the two-release support window
- [endoflife.date/go](https://endoflife.date/go) &mdash; support timelines
