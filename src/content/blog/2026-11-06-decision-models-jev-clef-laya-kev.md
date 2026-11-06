---
author: StevenPG
pubDatetime: 2026-11-06T12:00:00.000Z
title: "Decision Models Explained: Jev, Clef, Laya and Kev Compared"
slug: decision-models-jev-clef-laya-kev
featured: false
draft: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - ai
  - performance
description: "Decision models answer typed questions with calibrated probabilities instead of generating text. What they are, how they work, and how TypeSafe's Jev, Cloudflare's Clef and Clef-flash, Laya and Kev-9B compare on architecture, latency and published benchmarks."
---

## Table of Contents

[[toc]]

# A new kind of model for the boring, important part of agents

Most of the work an agent does isn't writing prose. It's making small decisions:
_is this ticket urgent?_ _Which team owns it?_ _Is this tool call safe to run?_
_Is this site a phishing page?_ We usually ask a general-purpose LLM those
questions, have it write some JSON, parse it, retry when the parse fails, and
hope the `"confidence": 0.9` it wrote means something.

In the last two months a new category of model has appeared to do exactly this
job: the **decision model**. You give it some state and a set of predefined
questions, and it returns a **probability for every allowed answer**. It doesn't
generate text, so there's nothing to parse and no way to answer outside the
options you defined.

The short version:

- **Jev** from [TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
  (September 15, 2026) started the category. It's a hosted, closed model that
  TypeSafe calls a "System One Model".
- **Clef** and **Clef-flash** from [Cloudflare](https://blog.cloudflare.com/clef-decision-models/)
  (October 1, 2026) are open-weight (Apache 2.0) and Jev-API-compatible. They're
  built on frozen Qwen backbones and hosted on Workers AI.
- **Laya** from [Convai Innovations](https://huggingface.co/convaiinnovations/laya)
  is a small (421M) encoder-based model that runs on a modest GPU and is by far
  the fastest. On Cloudflare's benchmarks it's also by far the least accurate.
- **Kev-9B** from [Jared Palmer](https://huggingface.co/jaredpalmer/kev-9b) is an
  open LoRA plus a scoring head on Qwen3.5-9B. It fits on a single 24 GB GPU and
  speaks Jev's API unchanged.

This post covers what these models are, how they work under the hood, how they
compare on the numbers that have been published, and how much those numbers can
be trusted. Most of the benchmarks are self-reported by whoever built the model,
so I'll flag that as I go. I'll do my own head-to-head benchmarking in a
follow-up post. The plan for that is at the end.

# What a decision model is

Cloudflare's [launch post](https://blog.cloudflare.com/clef-decision-models/) has
the clearest definition:

> A decision model makes classifications to help agents decide how to act, based
> on certain probabilities. For example, you can pass in a customer support
> message (inputs) and ask if it is urgent and which team should handle it. A
> decision model will return typed answers with probabilities (outputs), which
> your code can use to route the ticket, trigger an escalation, or defer to a
> human.

TypeSafe puts it more briefly: Jev is _"unstructured state in, typed probabilistic
decisions out."_ The name "System One" refers to Kahneman's _Thinking, Fast and
Slow_. These are fast, intuitive judgments, not slow chain-of-thought reasoning.

## How it differs from an LLM, and from a classic classifier

|                   | Classic classifier        | LLM with JSON output               | Decision model                        |
| ----------------- | ------------------------- | ---------------------------------- | ------------------------------------- |
| New categories    | Retrain                   | Change the prompt                  | Change the question definition        |
| Output            | Fixed label set           | Free text you hope is valid JSON   | A probability for each allowed option |
| Invalid output    | Impossible                | Possible (retry/repair loop)       | Impossible by construction            |
| Confidence        | Softmax, often calibrated | Self-reported text, not calibrated | Trained to be calibrated (RLCD)       |
| Several questions | One model per task        | One prompt, long output            | One forward pass answers them all     |
| Latency driver    | Tiny                      | Number of output tokens generated  | Input length (a single prefill pass)  |

So a decision model is a classifier whose label set you define at request time
in plain language. That's the whole idea: the flexibility of prompting an LLM,
with the bounded, typed and cheap output of a classifier.

## The three question types

Every model in this post uses the same vocabulary, which comes from Jev's API:

- **`noul`**: a yes/no question. The model returns P(yes).
- **`choice`**: pick one of N named options, each with a short description. You
  get a probability distribution over the options. Jev supports a
  cardinality of up to 255.
- **`score`**: an _ordered_ scale (for example `No impact → Minor → Major →
Critical`). It's also a distribution, but the order matters, and training can
  give partial credit for being off by one level.

This is the request Cloudflare shows for Clef. It's a useful picture of the shape
all of these share:

```json
{
  "model": "clef",
  "state": "Checkout has been failing for every customer for the last hour.",
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Is this support request urgent?"
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this request?",
      "criteria": {
        "billing": "Payments, invoices, and refunds",
        "technical": "Outages, errors, and configuration",
        "sales": "Plans and upgrades"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the customer impact?",
      "criteria": ["No impact", "Minor", "Major", "Critical"]
    }
  }
}
```

One request asks three questions and gets three typed answers.

# Walkthrough: what comes back, and what you do with it

None of the launch posts I read show a full response body, so the numbers below
are **made up to illustrate the idea**. This isn't real output from any of these
models. Conceptually, the request above produces something like this:

| Question   | Answer distribution                                          |
| ---------- | ------------------------------------------------------------ |
| `urgent`   | yes **0.97** · no 0.03                                       |
| `team`     | technical **0.91** · billing 0.08 · sales 0.01               |
| `severity` | Critical **0.81** · Major 0.17 · Minor 0.02 · No impact 0.00 |

The useful part is what your code does next. The answers are probabilities,
so you set the thresholds in code, not in a prompt:

- `urgent > 0.9` **and** `severity` is Critical → page the on-call engineer
- `team` top choice has probability `> 0.8` → route automatically
- Anything less certain → send it to a human queue

That last branch is the one that matters. Cloudflare's wording is careful: a human
"does not necessarily need to be in the loop for agentic decisions anymore"
(the [Decoder's headline](https://the-decoder.com/cloudflare-says-its-new-clef-model-means-humans-no-longer-need-to-be-in-the-loop-for-ai-agents/)
dropped the "necessarily"). Calibration is what makes it safe to drop the
human. If 0.9 really means right about 90% of the time, you can pick an
operating point that matches the cost of being wrong.

## Three more shapes this fits

**Website classification (Cloudflare's real-world example).** Cloudflare's
threat-intelligence team uses Clef with its headless browser to classify a
domain. One request returned "a 95% chance it is a fashion website, 85%
ecommerce, <1% phishing". Those are independent `noul` answers, which is why
they don't sum to 100%. Fetch, render and classify took **2.2 s** in total. The
fastest general-purpose LLM they tried (gpt-oss-120b) took **4.7 s** for the same
workflow and returned only two of the classifications.

**Agent guardrail.** The state is an agent's proposed tool call plus the
conversation so far. Questions: `noul` "Does this call modify or delete data?",
`noul` "Did the user explicitly request this action?", and `score` "Risk level".
If the call is destructive and not requested, you block it or ask the user. This
check runs before every tool call, which is only practical when it costs tens of
milliseconds rather than seconds.

**CI/CD change triage.** The state is a PR description plus a diff summary.
Questions: `choice` "Which subsystem is affected?", `score` "Blast radius",
`noul` "Touches auth, crypto or flight-critical config?" The probabilities pick
the reviewers and decide whether the change can take the fast-track pipeline.
Anything uncertain gets the full review. In regulated environments a calibrated
"I'm not sure" is a lot more useful than an LLM that is always confident.

# How they work under the hood

All four models share one trick: **they never decode tokens.** They run one
pass over the input and then score the allowed options directly from the
model's internal representations. That's where the latency win comes from. An
LLM's cost grows with the number of output tokens. A decision model's cost is
roughly one prefill.

## Jev (TypeSafe AI)

- **Status:** early-access hosted API and console. Weights are not published.
- **What's disclosed:** very little architecture. TypeSafe doesn't publish a
  parameter count, base model or context window. Cloudflare states Jev's context
  as 32k and says Jev is text-only today.
- **Training:** introduces **RLCD**, _Reinforcement Learning for Calibrated
  Decisions_. TypeSafe positions it against RLHF and RLVR and claims "higher
  confidence means higher accuracy". The blog gives no algorithm details; the
  Decoder links an [RLCD paper](https://arxiv.org/abs/2609.29429), and Clef,
  Laya and Kev all describe RLCD-style or proper-scoring-rule training.
- **High cardinality:** for choices with many options, Jev "scor[es]
  independently then mak[es] an explicit choice" in two stages.
- **Pricing:** **$0.042 per million input tokens**, and output is free ("too
  cheap to meter"). Compare that with $0.20 to $10/MTok input for typical LLMs,
  where output costs about 5x more on top.
- **Claimed latency:** 70–500 ms end to end.

TypeSafe's "no hallucinations" claim needs care. Their own chart notes: _"Our
number is not empirical. Schema matching is guaranteed, thus we can confidently
add 0% into the plots."_ That's true and useful, because you'll never get an
answer outside your schema. But it means **valid**, not **correct**. A decision
model can still confidently pick the wrong valid option.

## Clef and Clef-flash (Cloudflare)

- **Backbones:** Clef uses a frozen **Qwen3.8-27B**. Clef-flash uses a frozen
  **Qwen3.5-9B**.
- **What's trained:** a routing head together with **rank-256 LoRA adapters**.
  Inference is "a prefill-only pass, then scores the valid schema choices in
  parallel", which makes it non-autoregressive.
- **Scoring head:** a two-stage attention routing step. Each option pulls the
  evidence relevant to it from the prompt, and the fields cross-attend to each
  other and back to the payload before they're scored. That joint attention is
  what lets one request answer several _related_ questions consistently.
- **Training:** label-smoothed cross-entropy plus a **Brier loss** for
  calibration, on synthetic data that permutes field order, prompts and schemas.
  On top of that is Cloudflare's RLCD variant, which gives partial credit for
  adjacent ordinal choices and adds a reference penalty against distribution
  shift.
- **Differentiators vs Jev:** a **vision encoder** (it can classify images) and
  a **64k context window**.
- **Compatibility:** "fully Jev-API compatible".
- **License and hosting:** Apache 2.0 on Hugging Face
  ([clef](https://huggingface.co/Cloudflare/clef),
  [clef-flash](https://huggingface.co/Cloudflare/clef-flash)), and on Workers AI
  as `@cf/cloudflare/clef`. The launch post gives no pricing.
- **Fine-tuning:** a new RL fine-tuning service. It starts as a hands-on service
  with Cloudflare's engineers, and a self-serve version is planned. Traffic is
  captured through AI Gateway, rollouts are scored in Containers, and the tuned
  model is redeployed to Workers AI.

## Laya (Convai Innovations)

Laya takes the most different approach. It doesn't use a decoder LLM at all.

- **Backbone:** **ModernBERT-large** (395M, bidirectional encoder), fully
  fine-tuned, with a decision head trained from scratch: two transformer layers,
  an option-marker scorer and an act/escalate head. That's **421M parameters**
  in total. Each option is scored at its own `[MASK]` token.
- **Variants:** `laya` (English, 512-token context), `laya-multilingual`
  (mmBERT-base, 322M, 100+ languages, up to 8k context) and
  `laya-typed-decisions` (fine-tuned on four workflow tasks).
- **Training:** RL against strictly proper scoring rules (log + spherical, plus
  ranked probability score for ordinal questions), with GRPO-style updates.
- **Speed (own numbers, Tesla T4):** 39.5 ms for one question, and 158.6 ms
  for ten questions batched.
- **Compatibility:** ships `laya-serve`, a server that exposes Jev's
  `POST /v1/systemone` endpoint, so TypeSafe clients only need a new base URL.
- **License:** Apache 2.0.

The Laya model card is unusually honest about its limits. The base checkpoints
are "near chance on typed-decisions zero-shot" (0.362 against a 0.461 majority
baseline). They ship over-confident and need temperature refitting, which brings
mean ECE from 0.466 down to 0.081. Ordinal `score` questions are its weakest
type, and Jev leads on high-cardinality choices.

## Kev-9B (Jared Palmer)

- **Backbone:** frozen **Qwen3.5-9B-Base**.
- **What's trained:** a rank-16 LoRA (45.4M parameters) and a **pointer head**
  that scores each option's closing token against the question's final token.
  Inference is prefill-only, with each question answered from a shared, cached
  state.
- **Hardware:** fits on a single 24 GB GPU (about 22 GB resident).
- **Context:** serves states up to 64k tokens. Accuracy on contract questions
  falls gently with length, from 0.876 at 4k to 0.801 at 64k.
- **Compatibility:** implements `POST /v1/systemone`, and the TypeSafe SDK "works
  against it unchanged". The card states that no Jev outputs were used in
  training.
- **License:** Apache 2.0. v2 was released on 2026-09-30.

The Kev card is just as candid. On its own broad test set it trails Jev
(chance-corrected index **41.0 vs 54.0**), and it calls date arithmetic its
weakest area.

## The rest of the field

- **DiffusionGemma Jev** is Cloudflare's earlier in-house experiment. It exposes
  a diffusion LLM's log-probabilities as decision probabilities. It appears in
  Cloudflare's tables and wins one benchmark.
- **OpenAI's Decisions API**, built on GPT-6 Luna, was announced in late
  September and accepts text or images,
  [according to the Decoder](https://the-decoder.com/cloudflare-says-its-new-clef-model-means-humans-no-longer-need-to-be-in-the-loop-for-ai-agents/).
  I haven't found published benchmarks for it.
- A community **Jev Decision Index** on Hugging Face (several forks) has become
  the de facto leaderboard. Per the Kev card, it computes a chance-corrected
  score per dataset, `(score − chance) / (1 − chance)`, averages within five
  areas, and reports 100 × the mean.

# Side-by-side comparison

|                    | Jev             | Clef                 | Clef-flash          | Laya                     | Kev-9B              |
| ------------------ | --------------- | -------------------- | ------------------- | ------------------------ | ------------------- |
| Builder            | TypeSafe AI     | Cloudflare           | Cloudflare          | Convai Innovations       | Jared Palmer        |
| Released           | Sep 15, 2026    | Oct 1, 2026          | Oct 1, 2026         | Not stated               | Sep 30, 2026 (v2)   |
| Weights            | Closed          | Apache 2.0           | Apache 2.0          | Apache 2.0               | Apache 2.0          |
| Backbone           | Undisclosed     | Qwen3.8-27B (frozen) | Qwen3.5-9B (frozen) | ModernBERT-large encoder | Qwen3.5-9B (frozen) |
| Size               | Undisclosed     | ~27B + adapters      | ~9B + adapters      | 421M                     | ~9B + 45M adapter   |
| Context            | 32k             | 64k                  | 64k                 | 512 (EN) / 8k (multi)    | 64k served          |
| Images             | No              | Yes                  | Yes                 | No                       | No                  |
| Jev API compatible | It _is_ the API | Yes                  | Yes                 | Yes (`laya-serve`)       | Yes                 |
| Run locally        | No              | Yes (big GPU)        | Yes                 | Yes (a T4 is fine)       | Yes (24 GB GPU)     |
| Hosted option      | TypeSafe API    | Workers AI           | Workers AI          | —                        | —                   |

Clef-flash's context and image support come from the launch post's description
of "our model". Check the model card if you depend on them for the flash
variant.

# Benchmarks: what's been published

**Read this section with care.** Almost every number here was measured by the
company that built one of the models, on hardware and network paths that
differ. I'm reporting them as published, and the caveats follow.

## Cloudflare's accuracy table

From the [Clef launch post](https://blog.cloudflare.com/clef-decision-models/).
The benchmarks are a shortlist from the Jev Decision Index. Bold is the row
best.

| Benchmark                    | Clef      | Clef-flash | Jev       | DiffusionGemma Jev | Kev 9B | Laya  |
| ---------------------------- | --------- | ---------- | --------- | ------------------ | ------ | ----- |
| BFCL · case exact            | 98.47     | **98.76**  | 95.75     | 96.52              | 94.51  | 38.13 |
| ToolRet · nDCG@10            | **69.19** | 66.43      | 65.28     | 61.21              | 64.26  | 12.69 |
| API-Bank · accuracy          | 91.93     | **93.11**  | 88.19     | 83.66              | 56.30  | 11.41 |
| Home appliances · case exact | 82.95     | **97.73**  | 52.27     | 42.05              | 25.00  | 0.00  |
| When2Call · accuracy         | 72.37     | 65.58      | **80.97** | 75.44              | 49.62  | 11.94 |
| BANKING77 · macro-F1         | **94.20** | 90.93      | 79.74     | 74.28              | 84.83  | 14.29 |
| CLINC150+OOS · macro-F1      | **97.43** | 66.77      | 89.27     | 83.49              | 79.03  | 3.19  |
| BRIGHT · nDCG@10             | 45.91     | 39.26      | **47.52** | 42.94              | 38.53  | 19.90 |
| Amazon ESCI · macro-F1       | **57.48** | 57.39      | 55.21     | 53.37              | 49.22  | 24.40 |
| PhishNChips · accuracy       | 79.60     | 75.05      | 62.55     | **85.35**          | 50.75  | 50.15 |

What I take from it:

- **Tool-use routing (BFCL, ToolRet, API-Bank)** looks close to solved for the
  large models. That's the "which tool should the agent call" decision.
- **Jev still wins When2Call and BRIGHT.** When2Call tests _whether_ to call a
  tool at all, and BRIGHT is reasoning-heavy retrieval. Both lean on judgment
  more than pattern matching.
- **Clef-flash vs Clef is task-dependent.** Flash collapses on CLINC150+OOS
  (66.77 vs 97.43). That's a 150-intent task with out-of-scope detection, and the
  smaller backbone struggles with high cardinality plus "none of the above".
  Yet flash wins on Home appliances.
- **Laya's numbers look broken, not just weak.** 0.00 on Home appliances and
  3.19 on CLINC150 are below what you'd expect even from a weak model. Laya's own
  card admits zero-shot weakness, and its English checkpoint has a **512-token
  context**, which could truncate longer benchmark inputs. Cloudflare doesn't say
  which Laya checkpoint or settings it used. I'd treat this column as "not yet
  fairly measured" until someone reruns it.

## TypeSafe's workflow evals

Cloudflare also ran TypeSafe's own
[workflow eval suite](https://huggingface.co/collections/typesafe/workflowevals),
which is a home-field test for Jev:

| Workflow                  | Clef     | Clef-flash | Jev      |
| ------------------------- | -------- | ---------- | -------- |
| Invoice processing        | **64.7** | 57.1       | 61.8     |
| Customer service          | 76.3     | **77**     | 76.0     |
| Security incidents        | **62.9** | 61.7       | 61.7     |
| Agent trace observability | 68.5     | 69.8       | **71.6** |

These are much closer. Most of the gaps are one or two points, which is probably
within run-to-run noise. Note that TypeSafe's reference answers for these evals
are the average of two frontier LLMs, which TypeSafe itself says "biases answers
towards OpenAI and Anthropic's models".

## Latency

From Cloudflare, across its 43 eval benchmarks:

| Latency     | Clef  | Clef-flash | Jev   | DiffusionGemma Jev | Kev-9B | Laya    |
| ----------- | ----- | ---------- | ----- | ------------------ | ------ | ------- |
| Median · ms | 209.3 | 38.8       | 524.1 | 84.4               | 51.4   | **5.8** |
| p95 · ms    | 238.6 | **122.4**  | 536.0 | 211.2              | 187.9  | 222.5   |

Compare that with what the builders report for their own models:

| Model  | Cloudflare's median | Builder's own number                                    |
| ------ | ------------------- | ------------------------------------------------------- |
| Jev    | 524.1 ms            | 70–500 ms end to end (TypeSafe)                         |
| Jev    |                     | 236–276 ms p50 (third-party, cited on Laya's card)      |
| Laya   | 5.8 ms              | 39.5 ms on a Tesla T4, 1 question (Laya card)           |
| Kev-9B | 51.4 ms             | 24.0 ms on an H100, 6 questions, short state (Kev card) |

Those can all be true at once, which is exactly the problem. Jev is only
reachable over the internet, so Cloudflare's 524 ms includes a network round
trip that the self-hosted models don't pay. TypeSafe says its own evals "are
generally run from our laptops on the West Coast". Laya's 5.8 ms median against
its 222.5 ms p95 is a 38x spread, which suggests caching or batching effects.
The table doesn't describe hardware, batch size, input length or warm/cold
state for any model.

The safe conclusion is about orders of magnitude, not milliseconds. **Decision
models answer in tens to hundreds of milliseconds, where an LLM producing the
same structured answer takes seconds.** Within that, the small self-hosted
models are fastest, and Clef-flash looks like the best balance of speed and
quality among the hosted ones.

## Calibration

Calibration is the headline feature, and it's the least benchmarked:

- TypeSafe claims Jev is calibrated but publishes no ECE.
- Laya reports a mean ECE of 0.081 _after_ temperature refitting, against a
  third-party figure of 0.246 for Jev.
- Kev-9B reports an ECE of 0.034 on its own test set, with a fitted temperature
  of T = 2.19.
- Cloudflare trains with a Brier loss but publishes no calibration numbers.

These aren't comparable with each other (different test sets, different
binning), and nobody has published reliability diagrams on a shared benchmark.
That's the gap I most want to fill.

# Which one should you use?

- **You want hosted, zero ops, and the original:** Jev. It's strongest on
  judgment-heavy "should I act?" decisions (When2Call). It's the cheapest per
  token, but closed and text-only.
- **You want hosted with open weights as an exit strategy:** Clef. It has the best
  overall scores in Cloudflare's table, images, 64k context, and a fine-tuning
  path. Because it's Jev-API-compatible, switching between the two is a base-URL
  change.
- **You need it fast and on a latency budget:** Clef-flash. Test it on your
  high-cardinality questions first, given its CLINC150 result.
- **It must run on your own hardware (air-gapped, ITAR, data residency):** Kev-9B
  on a single 24 GB GPU, or Clef/Clef-flash if you have the GPU budget. All are
  Apache 2.0.
- **You need tiny, multilingual, or CPU/edge-class hardware:** Laya. Fine-tune it
  on your task first, though. Its own card shows zero-shot quality near chance,
  and the fine-tuned `laya-typed-decisions` jumps from 0.362 to 0.766.

The shared API is the real story. Clef, Laya and Kev all implement Jev's
`/v1/systemone` interface, so the question schema you write is portable. You can
start hosted, measure, and move on-prem later without rewriting your decision
logic.

# What I want to benchmark next

The published numbers leave three open questions, so in a follow-up post I plan
to measure them myself:

1. **Same hardware, same inputs.** All of the open models (Clef, Clef-flash,
   Kev-9B, Laya) on one GPU class, with fixed input lengths (256, 2k, 16k
   tokens) and 1 vs 10 questions per request, reporting cold and warm p50, p95
   and p99. Jev measured from a cloud VM near its endpoint, with network time
   reported separately.
2. **Calibration on a shared set.** ECE, Brier score and reliability diagrams on
   the same held-out questions, and how far a coverage-vs-accuracy curve lets
   you push automation at a fixed error rate (for example, "auto-route 80% of
   tickets at 99% precision").
3. **A fair rerun of Laya.** The multilingual 8k checkpoint, with inputs checked
   for truncation, to see whether the 0.00 and 3.19 scores reflect the model or
   the setup.

If there's a model or a workload you'd like to see in that comparison, let me
know.

# Sources

- TypeSafe AI, [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Cloudflare, [Introducing Clef: our open-source decision models, and new RL fine-tuning platform](https://blog.cloudflare.com/clef-decision-models/)
- The Decoder, [Cloudflare says its new Clef model means humans no longer need to be in the loop for AI agents](https://the-decoder.com/cloudflare-says-its-new-clef-model-means-humans-no-longer-need-to-be-in-the-loop-for-ai-agents/)
- Hugging Face model cards: [Cloudflare/clef](https://huggingface.co/Cloudflare/clef), [Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash), [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya), [jaredpalmer/kev-9b](https://huggingface.co/jaredpalmer/kev-9b)
- [Jev Decision Index](https://huggingface.co/spaces/multimodalart/jev-decision-index) (community leaderboard)
