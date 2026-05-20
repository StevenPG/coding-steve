---
author: StevenPG
pubDatetime: 2026-05-20T12:00:00.000Z
title: Running Claude Code Locally on Apple Silicon
slug: running-claude-code-locally-on-apple-silicon
featured: false
ogImage: /assets/default-og-image.png
tags:
  - ai
  - llm
  - claude
description: How to run Claude Code locally on a Mac using llama.cpp, Qwen3.6-35B, and Apple Silicon to avoid API limits.
---

## Brief

This guide shows you how to run Claude Code locally on an Apple Silicon Mac using `llama.cpp` and the Qwen3.6-35B model. No API key, no rate limits, no per-request billing. You'll need a Mac with an M-series chip and some comfort with the command line.

The end result is a fully functional Claude Code session — tool use, file editing, shell execution, the whole agentic workflow — running entirely on your machine.

## Why Go Local

I kept hitting Claude API rate limits on the $20 Pro tier. Not from heavy use, but from the kind of session that naturally accumulates — iterative debugging, refactoring, back-and-forth exploration. Once the throttle hits, the session becomes unusable until it resets.

My first stop was Ollama. It's the easiest way to run an LLM locally on macOS. But Ollama's API doesn't support tool calling. Claude Code requires tool calling to do anything useful — file editing, shell execution, search-and-replace. Without it, Ollama is just a chat window.

The path from there was `llama.cpp`'s `llama-server`. It exposes an OpenAI-compatible API that the Claude SDK can talk to using the `anthropic` backend. No tool-calling translation layer. No abstraction tax. Just a local HTTP server that behaves like the Anthropic API.

## Why Qwen3.6-35B-A3B

The model choice matters more than you'd think — not every model fits in an M3 Pro's memory, and not every model that fits runs fast enough to be usable.

Qwen3.6-35B-A3B is a [mixture-of-experts](https://qwen.ai/blog?id=qwen3.6-35b-a3b) model from the Qwen team. It has 35 billion total parameters but only activates about 3 billion per token. That sparse activation has two consequences that matter for local deployment:

1. **Memory footprint.** The full 35B-parameter MoE router must be loaded into memory regardless of how many parameters are active per token. At Q4_K_M quantization, the GGUF weights are about 22 GB. The rest of the RAM goes to KV cache and context.
2. **Inference speed.** Active parameters scale with compute, not total parameters. Token generation is closer to a 3B model's speed while retaining the quality of a much larger model.

### Other models worth considering

| Model | Active Params | Q4 Weight Size | Best For |
|---|---|---|---|
| Qwen3.6-35B-A3B | ~3B | ~22 GB | General purpose, best quality/size balance |
| Qwen3-Coder-30B-A3B | ~3B | ~18 GB | Code-focused tasks |
| Qwen3.6-235B-A22B | ~22B | ~120 GB | Maximum quality (needs 128 GB+ RAM) |
| Gemma 3 27B | 27B (dense) | ~16 GB | Dense model quality, tight on 36 GB Macs |
| DeepSeek-R1-Distill-Qwen-32B | 32B (dense) | ~20 GB | Reasoning tasks (may swap on 36 GB) |

The A3B models (sparse-activated, ~3B active params) are the sweet spot for 36 GB Macs — the Q4 weights fit comfortably with room for a generous context window. On 16-18 GB machines, even the A3B variants are too large for Q4; you'd need much lower quantization (Q2 or Q3) or a smaller model (7-13B dense). On 128 GB (M4 Ultra), you can run the much larger Qwen3.6-235B-A22B.

## Understanding Quantization

The models you'll see on Hugging Face come in many quantization variants. Quantization is the process of reducing the precision of a model's weights to save memory and speed up inference. A full-precision model stores each weight as a 32-bit floating-point number (FP32). Quantization maps those values to a smaller set — 8 bits (INT8), 4 bits (INT4), and so on.

The tradeoff is straightforward: lower precision means smaller files and faster inference, but potentially degraded model quality. The model was trained or fine-tuned with the quantization in mind, so a well-quantized model at Q4 can be nearly indistinguishable from its FP16 original. A poorly quantized one will be noticeably dumber.

**GGUF** is the file format used by `llama.cpp`. It stores the quantized weights along with metadata (model architecture, quantization scheme, etc.). When you see a model tag like `UD-Q4_K_M`, that's a GGUF quantization identifier.

Here's a quick reference for the quantization schemes you'll encounter:

| Scheme | Bits | Quality | Weight Size (35B model) | Notes |
|---|---|---|---|---|
| FP16 | 16 | Reference | ~70 GB | Full precision, rarely needed locally |
| Q8_0 | 8 | Near-lossless | ~37 GB | Good for KV cache, overkill for weights |
| Q5_0 | 5 | Very good | ~26 GB | Sweet spot for larger models on big Macs |
| Q4_K_M | 4 (mixed) | Good | ~22 GB | Mixed Q4/Q6 quantization, balanced |
| Q3_K_M | 3 (mixed) | Acceptable | ~18 GB | Noticeable quality drop |
| Q2_K | 2 (mixed) | Poor | ~14 GB | Only if you're desperate for space |

The `_K_M` variants use mixed precision — some weights get quantized more aggressively than others, based on their importance to the model's output. `K_M` is generally the best quality/size tradeoff in the K-quants family. If you have the RAM, prefer Q5_0 or Q8_0. If you need to fit in memory, Q4_K_M is the default recommendation.

The KV cache is a separate concern from the model weights. It's the stored key/value pairs for each token in the context, and it also has a precision setting. That's what the `--cache-type-k q8_0` and `--cache-type-v q8_0` flags control — quantizing the cache independently of the weights so you can fit more context in the same amount of RAM without degrading the model itself.

## Prerequisites

Install `llama.cpp` via Homebrew:

```bash
brew install llama.cpp
```

This gives you `llama-server`, which is the only binary you need.

## The Server Command

This is the command that runs on my M3 Pro (36 GB):

```bash
llama-server \
  -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M \
  --port 8131 \
  -ngl 999 \
  -t 6 \
  -c 65536 \
  -b 1024 \
  -ub 1024 \
  --parallel 1 \
  -fa on \
  --jinja \
  --keep 1024 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --swa-full \
  --no-context-shift \
  --reasoning off \
  --mlock \
  --no-mmap
```

It downloads the model on first run (about 22 GB over the network) and caches it locally. Subsequent starts are immediate.

### Flag-by-flag explanation

**`-hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M`**

Downloads and loads the model directly from Hugging Face. The `unsloth/` organization provides community-optimized GGUF quantizations. `UD-Q4_K_M` is a specific quantization variant — Q4 means 4-bit, `K_M` is a medium-quality K-quants scheme that balances quality and size. Lower quantizations (Q3, Q2) save memory but degrade model quality noticeably.

**`--port 8131`**

The HTTP port the server listens on. The Claude SDK will connect here instead of Anthropic's API endpoint. Pick any unused port.

**`-ngl 999`**

Number of GPU layers to offload. 999 means "offload everything to the GPU." On Apple Silicon, this uses Metal. The M3 Pro's GPU is orders of magnitude faster than the CPU for transformer inference, so this is the single most important flag for speed.

**`-t 6`**

CPU threads. The M3 Pro has 12 cores (6 performance + 6 efficiency). Use 6 threads for the CPU portions. This leaves the other 6 cores free for your OS and other applications. If you're running on a Max or Ultra with more cores, you can go higher. If you want the server to be completely non-blocking, drop to 4.

**`-c 65536`**

Context window size in tokens. 64K tokens is roughly 48,000 words. This is the flag you'll most likely need to tune.

Long Claude Code sessions — iterative debugging, multi-file refactors, or sessions with many tool calls accumulating — can exhaust this limit. When context fills and `--no-context-shift` is set, the server rejects new requests rather than silently truncating. You'll hit an error and the session becomes unusable until you restart with a larger context or start fresh.

The constraint is RAM. KV cache consumption scales roughly linearly with context length. Based on the post's measured ~1.2 GB for a 32K context at Q8.0, here's what to expect on a 36 GB machine:

| `-c` value | Approx. KV cache | Notes |
|---|---|---|
| 16384 (16K) | ~0.6 GB | Comfortable floor; fine for short sessions |
| 32768 (32K) | ~1.2 GB | Reasonable default for most coding tasks |
| 65536 (64K) | ~2.4 GB | What this guide uses; fits well on 36 GB |
| 98304 (96K) | ~3.6 GB | Tight; requires minimal other apps running |
| 131072 (128K) | ~4.8 GB | Marginal; may refuse to start with browser/Docker open |

On a 36 GB machine with the model occupying ~30-32 GB, you have roughly 4-6 GB of headroom. A 64K context sits comfortably. A 128K context is possible but leaves almost no margin. If the server refuses to start, it's almost always this flag — drop it by half and try again.

**`-b 1024`**

Batch size — the number of tokens processed in parallel during inference. Larger batches improve throughput on Apple Silicon's GPU but consume more memory. 1024 is a reasonable default.

**`-ub 1024`**

Ubatch (micro-batch) size — the number of tokens processed per internal compute step. Smaller ubatch values use less memory but can reduce throughput. Keeping it equal to batch size is fine for most use cases.

**`--parallel 1`**

Number of context sequences to run in parallel. Set to 1 because with a single user session, there's no benefit to running multiple contexts. Higher values consume proportionally more memory.

**`-fa on`**

Enables flash attention. This is an attention optimization that reduces memory bandwidth pressure during self-attention computation. On Apple Silicon, this can provide a meaningful speedup because it reduces the number of memory accesses per attention head.

**`--jinja`**

Enables Jinja templating for chat templates. Required for proper tool calling format with Claude models. Without this, the server falls back to a simpler template that may not support function calling correctly.

**`--keep 1024`**

Keep the model in memory for 1024 seconds (about 17 minutes) of inactivity before unloading. Without this, the model would be evicted after the last request, and the next request would trigger a slow reload. Set to `0` to never unload, or a higher value if your sessions are longer apart.

**`--cache-type-k q8_0`** and **`--cache-type-v q8_0`**

Override the precision of the K (key) and V (value) KV cache tensors to Q8.0 (8-bit). The default is usually F16, which uses 4x more memory. Q8.0 cache is essentially indistinguishable from F16 in quality but cuts cache memory in half. This is critical for fitting larger context windows in limited RAM.

**`--swa-full`**

Enables sliding window attention across the entire context window. Standard attention scales quadratically with context length — doubling the context quadruples the compute. Sliding window attention reduces this to linear scaling, which means faster inference on long prompts and better handling of follow-up messages that build on prior context.

**`--no-context-shift`**

Disable context shifting. By default, when the context fills up, llama.cpp shifts the window forward, discarding the oldest tokens. With this flag off, the server rejects new tokens that exceed the context window rather than silently dropping conversation history. Safer — you'll get an error instead of losing context.

**`--reasoning off`**

Disable the reasoning token mode. Qwen3.6 supports a "chain of thought" reasoning mode where the model outputs hidden reasoning tokens before its final response. We turn it off here because the Claude API doesn't support streaming reasoning tokens in a way that works well with Claude Code's interaction model.

**`--mlock`**

Lock the model in memory using `mlock()`. On macOS, this prevents the OS from swapping the model weights to disk. Without this, if other applications consume RAM, the kernel could page your model weights out, causing massive latency spikes when they're paged back in.

**`--no-mmap`**

Disable memory-mapped file I/O for loading the model. Combined with `--mlock`, this ensures the model is fully loaded into physical RAM rather than being memory-mapped from disk. On systems with enough RAM (which is the point of `--mlock`), this avoids subtle latency issues from page faults.

### Running as a Script + Alias

Pasting a long command into the terminal every time is tedious. Create a script (e.g., `./qclaude`) with the server command, make it executable, and add an alias in your shell config:

```bash
# In ~/.zshrc or ~/.bashrc
alias qclaude='~/path/to/your/dir/qclaude'
```

Or run it inline:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8131 ANTHROPIC_AUTH_TOKEN=local claude --dangerously-skip-permissions
```

This approach starts the Claude Code session directly with the environment variables set for that invocation only — no persistent config changes needed. The `--dangerously-skip-permissions` flag skips the permission prompts for tool use (file edits, shell commands). Remove it if you want Claude Code to ask for confirmation before each action.

## Connecting Claude Code

Configure Claude Code to use the local server by editing `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8131",
    "ANTHROPIC_AUTH_TOKEN": "local"
  }
}
```

That's it. Claude Code uses the Anthropic SDK, which reads these environment variables. The base URL points to your local server, and the auth token can be anything — the local server doesn't validate it.

Restart any existing Claude Code sessions for the changes to take effect. The first prompt will be slower (the model is already in memory thanks to `--keep`), but subsequent interactions will be fast.

## Performance

Measured on an M3 Pro (36 GB) with the model fully offloaded to the GPU via Metal.

**First-token latency: ~30-35 ms** — this is the time from sending a prompt to the server receiving the first token from the model. The initial prompt processing (331 tokens in my first test run) took 774 ms total, but the subsequent response generation was 14 tokens in 448 ms, which works out to about **31 tokens per second** for the response portion. That's not blazing fast, but it's usable. The first-token latency for interactive response generation (after prompt processing is done) feels roughly 10-20x slower than Claude's API.

**Context handling: gradual slowdown.** The server logs show prompt processing at various checkpoints — at 1K tokens it's running ~610 tokens/sec, at 8K it drops to ~590 tokens/sec, and by 13K tokens it's down to ~527 tokens/sec. The sliding window attention (`--swa-full`) was actually disabled for this model (the server logs `swa_full is not supported by this model, it will be disabled`), so the full quadratic attention cost applies. At 64K context, expect significant slowdown. The KV cache with Q8_0 quantization consumed roughly 129 MB for a 344-token context — scaling linearly, a 32K context would be around 1.2 GB, which is very manageable on 36 GB.

**Memory usage: ~30-32 GB at idle.** The model weights (22 GB Q4) + GPU offload + KV cache + prompt cache leave about 4-6 GB of headroom. macOS shows the process consuming about 31 GB of unified memory. The prompt cache was allocated at 8 GB (`--cache-idle-slots` would let it grow but that flag requires `--kv-unified`). This is tight — if other apps consume significant RAM, the `--mlock` flag is doing heavy lifting to prevent swapping.

**The model takes about 9 seconds to load** from a cold start, which is fast given the 22 GB file. The `--keep 1024` flag (17 minutes of inactivity) keeps it resident.

**Compared to Claude's API:** Claude Pro responds in well under a second for most prompts. Locally, first response is ~1-2 seconds (prompt processing + initial generation) and steady-state is 31 tokens/sec — about 10-20x slower. For iterative work where you're reading and responding quickly, this is noticeable. For longer tasks where the model is generating extended code or explanations, the speed difference is less jarring.

## Caveats

**Sliding window attention is disabled.** The server logs `swa_full is not supported by this model, it will be disabled`. This means for long contexts the model falls back to full quadratic attention, which is why you see that 15% throughput drop between 1K and 13K tokens. It's not a dealbreaker for typical Claude Code sessions (which rarely push past 16K of actual content), but it does cap the effective context well below the model's 262K training length.

**The `--reasoning off` flag was necessary.** Qwen3.6 supports a "chain of thought" reasoning mode that outputs hidden tokens before its final response. The Claude API doesn't support streaming reasoning tokens in a way that works with Claude Code's interaction model, so the model would either hang or produce garbled output with reasoning enabled. This is a known limitation and removes a capability that Qwen's reasoning models offer.

**Prompt cache invalidation is aggressive.** The server logs show context checkpoints being invalidated during processing (`forced full prompt re-processing due to lack of cache data`). The log line `swa or hybrid/recurrent memory` suggests this is a known issue with certain model architectures that use non-standard memory patterns. Each new interaction after a pause requires full re-processing of the context, which adds latency to follow-up messages.

**Memory is tight.** 31-32 GB used for the model leaves very little headroom. If you're running Xcode, Docker, or a browser with many tabs, you'll eat into that buffer. The `--mlock` and `--no-mmap` flags prevent swapping, but if total memory exceeds ~35 GB, `llama.cpp` will refuse to start or fall back to CPU inference, which is orders of magnitude slower.

**Context exhaustion is a real-world problem.** The `-c 65536` value sounds generous until you hit it. A session that opens several large files, runs a few build commands, and iterates on errors can push 20-30K tokens faster than you'd expect. Once the limit is reached with `--no-context-shift`, the server stops accepting new prompts. The fix is to either restart the server with a larger `-c` value (and accept the RAM hit), start a new Claude Code session, or lower the context if startup is failing due to memory. I went through a few tries before settling on 65536 — 32768 ran out mid-session on longer refactors, and 128K wouldn't start reliably with other apps open.

**Tool calling works but isn't bulletproof.** The model calls tools correctly most of the time, but there are occasional failures — wrong parameter names, missing arguments, or hallucinated tool names. Claude's API model virtually never makes these mistakes. For code generation and text editing, the quality is good enough for routine tasks. For complex multi-step refactors or unfamiliar codebases, you'll likely want the API model as a fallback.

**It's slower.** By a lot. Claude's API responds in sub-second time for most prompts. Locally, the first token takes ~30 ms to arrive (which feels instant), but the actual prompt processing for a 300-token input takes 774 ms, and steady-state generation is ~31 tokens/sec. The gap is most noticeable during interactive conversations where you're reading responses and firing follow-ups quickly — it feels like chatting with a very patient colleague who writes at the speed of a snail. For batch tasks (generate a whole file, run tests, explain a long output) the slowness is less jarring because the model is doing useful work rather than waiting for a response.

## Choosing a Model for Your Mac

The model you can run depends entirely on how much unified memory your Mac has. The KV cache also consumes RAM, so you can't load a model whose weight size equals your total RAM. Here's a practical guide for each Apple Silicon tier, using Q4_K_M quantization as the default.

### M1 / M2 / M2 Pro / M3 (16 GB)

| Model | Weight Size | Viable? | Notes |
|---|---|---|---|
| Qwen3.6-35B-A3B | ~22 GB | No | Weights alone exceed total RAM. |
| Qwen3-Coder-30B-A3B | ~18 GB | No | Weights exceed usable RAM. |
| Qwen3.6-235B-A22B | ~120 GB | No | Needs 128 GB of RAM minimum. |
| Gemma 3 27B | ~16 GB | No | Weights alone fill the machine. |
| Qwen2.5-7B/14B | ~4-8 GB | Yes | Comfortable fit at Q4, room for context. |
| Any dense model <=13B | <=8 GB | Yes | Best option for 16 GB Macs at Q4. |

### M3 Pro (18 GB)

| Model | Weight Size | Viable? | Notes |
|---|---|---|---|
| Qwen3.6-35B-A3B | ~22 GB | No | Weights exceed total RAM. |
| Qwen3-Coder-30B-A3B | ~18 GB | No | Weights alone fill the machine. |
| Qwen3.6-235B-A22B | ~120 GB | No | Needs 128 GB of RAM minimum. |
| Dense 13B at Q4 | ~8 GB | Yes | ~8 GB free for context. Best balance. |
| Dense 7-8B at Q4 | ~4-5 GB | Yes | Plenty of room for context. |

### M2 Max / M3 Pro / M3 Max (36 GB)

This is the setup described in this guide. The 36 GB limit leaves about 28-30 GB usable. You can comfortably run both sparse and dense models with generous context windows.

| Model | Weight Size | Viable? | Notes |
|---|---|---|---|
| Qwen3.6-235B-A22B | ~120 GB | No | Weights alone exceed 36 GB RAM. |
| Qwen3.6-35B-A3B | ~22 GB | Yes | Comfortable fit. ~6-8 GB for context. |
| Gemma 3 27B (Q4) | ~16 GB | Yes | Dense model quality, ~10 GB for context. |
| Qwen3-Coder-30B-A3B | ~18 GB | Yes | Code-focused, ~8 GB for context. |
| Any dense 14-20B at Q4 | ~8-12 GB | Yes | Good quality, room for context. |

### M4 Pro / M4 Max / M4 Ultra (32-128 GB)

These chips can run anything that fits. The practical limit is inference speed — larger models take longer to generate tokens, even with GPU offload. For 32-36 GB (M4 Pro / M3 Pro), treat it like the 36 GB tier above. For 48 GB (M4 Max), Qwen3.6-35B-A3B becomes comfortable with a large context window. At 128 GB (M4 Ultra), you can run the Qwen3.6-235B-A22B or a dense 70B+ model.

### General Rules of Thumb

1. **Available RAM ≈ total RAM - 6 GB** (macOS overhead + other processes). On a 36 GB machine, that's ~28-30 GB. On 18 GB, ~12-13 GB.
2. **KV cache at Q8_0** roughly scales with context length and model architecture. A 64K context on Qwen3.6-35B-A3B with Q8_0 cache uses roughly 2-3 GB. Larger models with bigger hidden dimensions consume more per token.
3. **Always leave headroom.** If the model + estimated cache exceeds your RAM, you'll swap and the GPU offload advantage is meaningless.

## Comparison

| Aspect | Claude API (Pro) | Qwen3.6-35B-A3B Local |
|---|---|---|
| Cost | $20/mo + overage | Hardware you already own |
| Rate limits | Yes (tier-dependent) | None |
| Tool calling | Full, reliable | Works, depends on model |
| Internet access | Via tools you provide | Via tools you provide |
| First-token latency | ~200-500ms | ~30ms (server), ~774ms (full prompt processing for 331 tokens) |
| Context window | 200K tokens | ~32K (effective, SWA disabled for this model) |
| Model quality | SOTA | Good, not SOTA |
| Privacy | Data leaves your machine | Entirely local |

## Summary

Running Claude Code locally on Apple Silicon is practical, but it comes with trade-offs. The combination of sparse-activated models and unified memory makes the hardware a surprisingly good fit — the model is smart enough for routine coding tasks, and the setup eliminates the frustration of rate-limit throttled sessions. But it's slower than the API (roughly 10-20x for response generation) and the effective context window is capped around 32K tokens because this model doesn't support sliding window attention. For heavy iterative work where API limits are a problem, it's a great alternative. For speed and maximum quality, the API still wins.

The key flags are `-ngl 999` (GPU offload), `--mlock --no-mmap` (keep the model in RAM), and `--cache-type-k/v q8_0` (fit more context in memory). Everything else is tuning.

---

*This post was written using Qwen3.6-35B-A3B running locally on a MacBook Pro with an M3 Pro chip (36 GB RAM).*
