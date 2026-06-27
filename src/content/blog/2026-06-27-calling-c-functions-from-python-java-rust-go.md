---
author: StevenPG
pubDatetime: 2026-06-27T12:00:00.000Z
title: "Calling C from Python, Java, Rust, and Go"
slug: calling-c-functions-from-other-languages
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - c
  - python
  - java
  - rust
  - golang
  - ffi
description: One tiny C library, four languages, the same set of calls. A from-scratch guide to foreign function interfaces — what's actually happening when your language reaches into C, and the best practices for doing it in Python, Java, Rust, and Go.
---

# Calling C from Python, Java, Rust, and Go

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This one started with a question I kept dodging: when my code calls a C library, what is actually happening?

Almost everything you use eventually bottoms out in C. The cryptography in your TLS handshake, the SQLite database on your phone, the codec decoding this page's images, the GPU driver, half of NumPy — all C, or close enough. Most of the time you never notice, because someone already wrapped it for you. But sooner or later you hit a library that only ships as a `.so` or a `.dylib`, with a header file and no bindings for your language, and you have to do the wrapping yourself.

This is called **FFI** — a Foreign Function Interface — and every serious language has a story for it. The stories are surprisingly different. Some make it a one-liner. Some make you describe every type by hand. Some make you say the word `unsafe` out loud. This post walks through the same handful of C calls in **Python, Java, Rust, and Go**, so you can see the shape of each one side by side and steal the best practices for whichever you reach for.

The companion project is on GitHub: [DemosAndArticleContent/blog/calling-c-functions](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/calling-c-functions). Every demo loads the **same prebuilt** shared library and prints the identical output. None of them recompile the C — they link against or `dlopen` the shared object, which is the realistic "I have a C library, call it from X" scenario.

If you've never done this before, read straight through. If you already know FFI and just want a specific language's mechanics, jump to [Python](#python-ctypes), [Java](#java-the-foreign-function--memory-api), [Rust](#rust-extern-c), or [Go](#go-cgo).

## What's Actually Happening

Before any code, it helps to know what problem FFI is solving, because the ceremony in each language exists for a reason.

A compiled C function is just a blob of machine instructions sitting at some address in a loaded library. To call it, your program needs to agree with that blob on a set of conventions that nobody writes down in the function signature:

- **Where do the arguments go?** Which registers, in what order, and what spills onto the stack.
- **How big is each type?** A C `int` is (almost always) 32 bits; a C `long` is 64 bits on Linux/macOS but 32 on Windows. `size_t` is pointer-sized. Get this wrong and you read garbage.
- **Where does the return value come from?** A register for scalars, but a small struct might come back in two registers, and a large one through a hidden pointer.
- **Who owns the memory?** If C hands you a pointer it `malloc`'d, *you* have to free it — through C, with C's allocator, not your language's garbage collector.

That whole bundle of conventions is called the **ABI** (Application Binary Interface). C doesn't really have a runtime, so the "C ABI" is the lingua franca that every language and operating system already agrees on. FFI, in every language below, is fundamentally about teaching your runtime to speak that ABI for a specific function: here are the argument types, here's the return type, here's the address — go.

The three things that make FFI interesting, and that our demo library deliberately exercises, are:

1. **Plain scalars** — ints and longs. The easy case.
2. **Strings** — a `char*` going in, and a heap-allocated `char*` coming back that you must free. This is where ownership bites.
3. **Structs and arrays** — passed and returned by value, which forces each language to get the memory layout exactly right.

## The C Library

Everything calls into `mathlib`, a deliberately tiny library with seven functions. Here's the header — it's the contract every language has to honor:

```c
/* ---- 1. scalars ---- */
int add(int a, int b);
long fibonacci(int n);

/* ---- 2. strings ---- */
/*
 * Return a newly malloc'd greeting, e.g. greet("Ada") -> "Hello, Ada!".
 * The caller owns the returned pointer and MUST release it with free_string().
 * This is the classic ownership wrinkle every language has to handle.
 */
char *greet(const char *name);
void free_string(char *s);

/* ---- 3. structs & arrays ---- */
typedef struct {
    double x;
    double y;
} Point;

double distance(Point a, Point b);   /* structs in, by value      */
Point  midpoint(Point a, Point b);   /* struct out, by value      */
long   sum_array(const int *values, size_t count);
```

The implementations are exactly what they look like — `add` adds, `fibonacci` loops, `greet` does a `malloc` + `snprintf`. The interesting one is `greet`: it returns memory it allocated, and the header is explicit that the caller now owns that pointer and must hand it back to `free_string`. Hold onto that detail. It's the single most instructive line in the whole project, and each language handles it differently.

All four demos print the same thing:

```
add(2, 3)        = 5
fibonacci(20)    = 6765
greet("Ada")     = Hello, Ada!
distance(a, b)   = 5
midpoint(a, b)   = Point(x=1.5, y=2.0)
sum_array(1..10) = 55
```

Now let's see how each language gets there.

## Python: `ctypes`

Python's `ctypes` ships with CPython, so there's nothing to install. You `dlopen` the library at runtime and then *describe* each function's types so `ctypes` can marshal values correctly. The whole thing is dynamic — there's no compile step, no generated code, just declarations executed at runtime.

```python
import ctypes, platform
from pathlib import Path

class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

lib = ctypes.CDLL(str(library_path()))

# Declaring argtypes/restype lets ctypes convert values correctly and
# catches mismatches instead of silently corrupting the stack.
lib.add.argtypes = [ctypes.c_int, ctypes.c_int]
lib.add.restype  = ctypes.c_int

lib.greet.argtypes = [ctypes.c_char_p]
lib.greet.restype  = ctypes.c_void_p  # void* so we keep the raw pointer to free it

lib.distance.argtypes = [Point, Point]
lib.distance.restype  = ctypes.c_double
```

Scalars are trivial once the types are declared: `lib.add(2, 3)` just works. The struct is a Python class mirroring the C layout, and you pass instances directly by value.

The string is where you earn your keep. Notice that `greet.restype` is `c_void_p`, **not** `c_char_p`. That's deliberate. If you let `ctypes` return a `c_char_p`, it eagerly copies the bytes into a Python `bytes` object and you lose the original pointer — which means you can never free it, and you've leaked. By keeping the raw `void*`, you hold onto the address, copy the string yourself, and then hand the pointer back to C:

```python
def greet(lib, name: str) -> str:
    ptr = lib.greet(name.encode("utf-8"))
    try:
        # Copy the bytes into a Python str while the C memory is still alive.
        return ctypes.cast(ptr, ctypes.c_char_p).value.decode("utf-8")
    finally:
        lib.free_string(ptr)  # hand ownership back to C
```

**Best practices for Python `ctypes`:**

- **Always set `argtypes` and `restype`.** Without them, `ctypes` assumes everything is a C `int`, which silently corrupts pointers and 64-bit values on the way in and out. This is the number one source of mysterious `ctypes` crashes.
- **Use `c_void_p` for any pointer you have to free**, then `cast` to read it. Returning `c_char_p` loses the pointer to a copy.
- **Free in a `finally`.** C memory isn't garbage collected; if your copy throws, you still need to release it.
- **For real libraries, reach for `cffi` instead.** It can read the actual C header and generate the declarations, removing the hand-maintained `argtypes` that drift out of sync with the library.

`ctypes` is the lowest-ceremony option here, and also the slowest — every call pays for runtime marshalling. For glue code and scripting that's a non-issue. For a hot loop, it matters.

## Java: The Foreign Function & Memory API

For years, calling C from Java meant JNI: a separate C compilation step, hand-written glue, and a great way to crash the JVM. That's over. The **Foreign Function & Memory API** (FFM, formerly Project Panama) went final in **Java 22**, and it does all of this in pure Java with no native build step.

The trade-off is that FFM is the most explicit of the four. You wire up the machinery by hand: a `Linker` to the native ABI, a `SymbolLookup` to find functions, a `MethodHandle` per function, and `MemoryLayout` objects describing the C types.

```java
Linker linker = Linker.nativeLinker();
SymbolLookup lookup = SymbolLookup.libraryLookup(libraryPath(), Arena.global());

MethodHandle add = linker.downcallHandle(
        lookup.find("add").orElseThrow(),
        FunctionDescriptor.of(C_INT, C_INT, C_INT));

// add.invokeExact returns int — the cast must match exactly.
System.out.println((int) add.invokeExact(2, 3));
```

The star of the show is `Arena`. Native memory in FFM is owned by an arena, and a confined arena in a try-with-resources block frees *everything* it allocated the moment you leave the block — deterministically, no GC involved. This is what makes FFM feel safe compared to JNI:

```java
try (Arena arena = Arena.ofConfined()) {
    MemorySegment a = point(arena, 0.0, 0.0);   // allocated in the arena
    MemorySegment b = point(arena, 3.0, 4.0);
    double d = (double) distance.invokeExact(a, b);
    // ... arena frees a and b automatically on close
}
```

The `greet` string shows the one wrinkle. A pointer returned from C comes back as a *zero-length* `MemorySegment` — Java knows the address but not how big it is, on purpose, because reading off the end would be unsafe. You `reinterpret` it to a known size before reading, then free it:

```java
MemorySegment result = (MemorySegment) greet.invokeExact(cName);
String s = result.reinterpret(Long.MAX_VALUE).getString(0);
freeString.invokeExact(result);   // hand ownership back to C
```

**Best practices for Java FFM:**

- **Use `Arena.ofConfined()` in try-with-resources** for anything with a bounded lifetime. Reach for `Arena.global()` only for memory that genuinely lives forever, like the library handle itself.
- **`invokeExact` means exact.** The static types of the arguments and the return cast must match the `FunctionDescriptor` precisely — `(int)` not `(long)`, an explicit `(MemorySegment)` cast on the allocator argument for struct returns. A mismatch is a `WrongMethodTypeException`, which is annoying but far better than a silent crash.
- **Generate bindings for anything non-trivial.** The JDK ships `jextract`, which reads a C header and emits all the `MethodHandle` and layout boilerplate. Hand-writing it, like the demo does, is great for learning and tedious in production.
- **Run with `--enable-native-access`** to opt into native calls explicitly; a future JDK will require it.

FFM is the most ceremony of the four, but it buys you GC-friendly, deterministically-freed native memory with zero native toolchain — a genuinely great place to be if you're already on the JVM.

## Rust: `extern "C"`

Rust speaks the C ABI natively, because it has no runtime of its own to get in the way. You declare the foreign functions in an `extern "C"` block, slap `#[repr(C)]` on any struct so its layout matches C exactly, and the linker connects the symbols. There's no marshalling layer at all — these calls compile down to direct C calls, which is why Rust is the fastest option here.

```rust
#[repr(C)]                       // lay this struct out exactly like C
#[derive(Clone, Copy, Debug)]
struct Point { x: f64, y: f64 }

// Every call into C is `unsafe`: the compiler can't verify the other side.
unsafe extern "C" {
    fn add(a: c_int, b: c_int) -> c_int;
    fn greet(name: *const c_char) -> *mut c_char;
    fn free_string(s: *mut c_char);
    fn distance(a: Point, b: Point) -> f64;
}
```

The word that defines the Rust experience is **`unsafe`**. Every C call is unsafe, because the borrow checker can't see across the boundary — it has no idea whether C will hold your pointer, free it twice, or scribble past the end of your array. Rust makes you acknowledge that explicitly.

The idiomatic move is to quarantine the `unsafe` inside a small, safe wrapper function, so the rest of your program gets a normal, safe Rust API. The `greet` wrapper is the textbook example — it owns the whole unsafe dance and hands back a plain `String`:

```rust
fn greet_safe(name: &str) -> String {
    let c_name = CString::new(name).expect("name contained a NUL byte");
    unsafe {
        let ptr = greet(c_name.as_ptr());
        // Copy the bytes into an owned String while the C memory is alive.
        let owned = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        free_string(ptr);   // hand ownership back to C
        owned
    }
}
```

Linking is handled in `build.rs`, which tells Cargo where to find the library at link time and bakes an `rpath` so it's found at runtime too:

```rust
println!("cargo:rustc-link-search=native={}", lib_dir.display());
println!("cargo:rustc-link-lib=dylib=mathlib");
println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
```

**Best practices for Rust FFI:**

- **Wrap `unsafe` in safe functions.** Expose a safe API and keep the raw C calls behind a thin boundary you can audit. The goal is that callers never write `unsafe` themselves.
- **`#[repr(C)]` on every struct** that crosses the boundary. The default Rust layout is unspecified and the compiler is free to reorder fields.
- **Use the `c_*` type aliases** (`c_int`, `c_long`, `c_char`) from `std::os::raw` rather than assuming `i32`/`i64`. They track the platform's real C types.
- **Mind the NUL byte.** `CString::new` fails if your string contains an interior NUL, because C strings can't represent one. Handle that case instead of unwrapping blindly in production.
- **Generate bindings with `bindgen`** for real libraries — it reads the header and writes the `extern` block and `#[repr(C)]` structs for you.

Rust gives you zero-overhead calls and compile-time layout guarantees; the cost is that you're the one vouching for safety inside those `unsafe` blocks.

## Go: cgo

Go's approach is the most novel-looking: you write actual C in a comment directly above `import "C"`, and the `cgo` tool compiles it and wires it up. The `#cgo` directives tell the toolchain where the header and library live.

```go
/*
#cgo CFLAGS: -I${SRCDIR}/../c-library/include
#cgo LDFLAGS: -L${SRCDIR}/../c-library/build -lmathlib -Wl,-rpath,${SRCDIR}/../c-library/build
#include <stdlib.h>
#include "mathlib.h"
*/
import "C"
```

After that, the C functions and types are available under the `C` pseudo-package. Scalars and structs are pleasant — `C.add(2, 3)`, `C.Point{x: 0.0, y: 0.0}` — you just convert at the boundary with `int(...)`, `float64(...)`, and so on, because Go's `C.int` and Go's `int` are distinct types.

Strings need explicit conversion in both directions, and the C-owned buffer needs freeing. Go's `defer` makes the cleanup read nicely:

```go
func greet(name string) string {
    cName := C.CString(name)            // Go string -> C char* (malloc'd by cgo)
    defer C.free(unsafe.Pointer(cName)) // free the input we allocated

    ptr := C.greet(cName)
    defer C.free_string(ptr)            // hand the returned buffer back to C
    return C.GoString(ptr)              // copies into a Go string
}
```

Note there are *two* frees here: `C.CString` allocates C memory for the input that you own and must free, and `greet`'s return value is C-owned and goes back to `free_string`. `defer` runs them in reverse order as the function exits.

**Best practices for Go cgo:**

- **Always free what `C.CString` allocates.** It `malloc`s — it is not garbage collected. Pair every `C.CString` with a `defer C.free(unsafe.Pointer(...))`.
- **Convert at the boundary and stay in Go.** Turn `C.int`/`C.long` into Go types immediately and do your real work in pure Go; the C types are awkward to pass around.
- **Don't store Go pointers in C.** The Go garbage collector can move memory; handing a long-lived Go pointer to C violates the cgo pointer rules and leads to rare, vicious bugs. Copy across the boundary instead.
- **Know the costs before you commit.** Each cgo call has real overhead (far more than a Go function call), and — the big one — **cgo breaks easy cross-compilation.** A pure-Go binary cross-compiles to any target by setting two env vars; the moment you add cgo you need a C toolchain for each target. Many Go teams avoid cgo specifically for this.

cgo makes C feel almost native inside Go, with the lowest ceremony after Python. The catch isn't the syntax — it's what cgo does to your build and deploy story.

## How They Compare

Same seven functions, four very different experiences:

| | Mechanism | Extra deps | Binding style | Memory across boundary | Speed | Ceremony |
| --- | --- | --- | --- | --- | --- | --- |
| **Python** | `ctypes` (runtime `dlopen`) | none (stdlib) | runtime type decls | manual `c_void_p` + `free_string` | slowest | lowest |
| **Java** | FFM / Panama | none (JDK 22+) | `MethodHandle` + `MemoryLayout` | `Arena` (scoped, auto-freed) | fast | highest |
| **Rust** | `extern "C"` + linker | none (build.rs) | compile-time `extern` block | explicit, `unsafe` + safe wrappers | fastest | medium |
| **Go** | cgo | none (toolchain) | C in special comment | `C.CString`/`C.GoString` + `defer` | fast (boundary cost) | low/medium |

The most striking thing is that **none of them need a third-party library**. FFI used to mean SWIG or hand-written JNI; today every one of these is built into the language or its standard toolchain.

The second is that the `greet` string — the one function that hands ownership across the boundary — is where each language reveals its philosophy. Python keeps a raw `void*` and frees it in a `finally`. Java reads from a reinterpreted `MemorySegment` while an `Arena` cleans up the input. Rust copies into an owned `String` and hides the whole thing behind a safe wrapper. Go copies with `C.GoString` and `defer`s the free. Four ways to say the same careful thing: *copy the bytes out while the memory is alive, then give the pointer back to C.*

## Picking One

- **Glue, scripting, quick experiments, data work** → Python `ctypes` (or `cffi` once it's more than a script). Lowest friction, and the call overhead rarely matters for this kind of code.
- **On the JVM and want no native build step with GC-friendly, deterministic lifetimes** → Java FFM. The most ceremony, but `jextract` removes most of it and `Arena` makes the memory story genuinely pleasant.
- **Want zero overhead and compile-time guarantees** → Rust. You pay in `unsafe` blocks, but you can wrap them away and the calls cost nothing.
- **Already in Go and want C to feel native** → cgo — with eyes open about the cross-compilation and per-call cost. If those bite, consider a pure-Go reimplementation or a subprocess instead.

A few things that apply no matter which you choose:

- **For real libraries, generate the bindings.** Hand-writing signatures (like every demo here does) is perfect for learning and a maintenance trap in production. Use `cffi` for Python, `jextract` for Java, `bindgen` for Rust. cgo reads the header itself.
- **`#[repr(C)]`, `MemoryLayout`, `ctypes.Structure`, `C.Point` — respect the layout.** Structs are where silent corruption lives. The demo passes `Point` by value in all four specifically because by-value structs force you to get the ABI exactly right.
- **Whoever `malloc`s, frees — through C.** Your garbage collector does not know about C's heap, and C does not know about yours. Every pointer that crosses the boundary needs an owner, and that ownership has to be honored with C's own allocator.

## Wrapping Up

The headline is that FFI got *boring*, in the best possible way. Four mainstream languages, four batteries-included answers, no third-party dependency in sight. Whatever you write, there's a built-in path from your code into the enormous body of C that the world already runs on.

What stays constant underneath all four is the C ABI — the agreement about registers, sizes, and ownership that C made the universal contract decades ago. FFI is just each language's way of teaching its runtime to honor that contract for one function at a time. Once you can see that, the ceremony stops looking arbitrary: the `argtypes`, the `MemoryLayout`, the `#[repr(C)]`, the `C.size_t` — every one of them is a place where your language is pinning down a detail the C ABI assumed everyone already knew.

Clone the demo, run `./run-all.sh`, and watch all four print the same six lines. Then change the C library — add a function, return a different struct — and wire it through each language yourself. Doing the `greet`-style ownership dance once in each language is worth more than any number of paragraphs about it.

Thanks for reading, and happy linking.
