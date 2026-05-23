---
author: StevenPG
pubDatetime: 2026-05-22T12:00:00.000Z
title: How I built Visual Finances
slug: how-i-built-visual-finances
featured: false
ogImage: /assets/default-og-image.png
tags:
  - finances
description: How I built a free suite of calculators for the modern web.
---

# How I Built Visual Finances: A Free Calculator Suite with Astro + React Islands

## Brief

I kept running into the same problem with financial calculators online: they were either locked behind a paywall, required an email to access the "advanced" version, or just wouldn't let you share your inputs with anyone. I wanted a calculator I could send to someone with my exact numbers already filled in.

[Visual Finances](https://visualfinances.com) is what I built to solve that — a free, browser-only financial calculator suite with 32 calculators across saving, borrowing, retirement, income, and spending categories. No accounts, no email gates, no ads. This post covers the technical decisions behind it.

---

## The Problem

Financial calculator sites tend toward two failure modes: oversimplified (one input, one output) or gated (give us your email for the "advanced" tab). Neither is useful for someone who wants to actually think through a financial decision.

The feature I cared most about was a shareable URL — pull up the rent-vs-buy calculator, tweak numbers until they match your situation, then copy the URL and send it to your partner or financial advisor with state intact. That constraint turned out to be the most technically interesting part of the project.

---

## Why Astro

Most of the pages on Visual Finances are static. The calculator index, the learn articles, the about page — none of that needs JavaScript. Shipping a full React SPA for a site that's 80% text and navigation felt wasteful, both for performance and SEO.

Astro's architecture fits this pattern well. You write `.astro` components for the shell — layouts, navigation, headers, footers — and those ship as plain HTML. Then you drop in React components exactly where you need interactivity, using Astro's `client:load` directive:

```astro
---
// src/pages/calculators/compound-interest.astro
import CalcLayout from '@/layouts/CalcLayout.astro';
import { CompoundInterestCalc } from '@/components/react/calculators/CompoundInterestCalc';
---

<CalcLayout title="Compound Interest Calculator" ...>
  <CompoundInterestCalc client:load />
</CalcLayout>
```

The HTML shell — title, breadcrumbs, JSON-LD structured data, the related learn articles section — renders at build time on Cloudflare Pages. The React component hydrates in the browser. The Lighthouse scores reflect the difference: near-perfect on every calculator page.

---

## The React Islands Pattern and Shareable URLs

Each calculator is a self-contained React component. They all share a common layout primitive called `CalcShell` — a two-column grid with a sticky inputs panel on the left and a results/visualization panel on the right. On mobile the columns stack vertically so the inputs are reachable without scrolling past a chart.

```tsx
// Simplified CalcShell usage
<CalcShell
  slug="compound-interest"
  inputs={<CompoundInterestInputs state={state} update={update} />}
  results={<CompoundInterestResults state={state} />}
  assumptions={<CompoundInterestAssumptions />}
/>
```

The most interesting piece is `useHashState`. Instead of a backend or localStorage, calculator input state lives in the URL hash fragment. The hash never goes to a server — it's purely client-side — so your loan amount and income are never in a server log anywhere.

```ts
// Simplified version of the actual hook
export function useHashState<T extends Record<string, HashValue>>(
  initial: T,
): [T, (next: Partial<T> | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(initial);

  // On mount: hydrate from whatever hash is in the URL.
  // This is what makes share links work — the recipient loads
  // the page and gets your exact inputs, not the defaults.
  useEffect(() => {
    if (!window.location.hash) return;
    const decoded = decodeHashState(window.location.hash);
    setState(prev => mergeHashIntoState(prev, decoded));
  }, []);

  // On every state change: push the new hash with replaceState
  // so the back button still works normally.
  useEffect(() => {
    const encoded = encodeHashState(state);
    window.history.replaceState(null, '', `${window.location.pathname}#${encoded}`);
  }, [state]);

  return [state, update];
}
```

The real implementation does a bit more — it coerces number and boolean fields from the string values the URL gives you, and it skips the `replaceState` if the hash hasn't actually changed. But the core idea is that simple: mount → read hash, change → write hash.

The encoding is `URLSearchParams` under the hood. A compound interest calculator URL ends up looking like `#p=10000&m=500&r=7&n=30`. Short, human-readable-ish, and survives being pasted into iMessage.

---

## Content as a System

The 37 learn articles live in an MDX content collection. Astro's content collections let you define a Zod schema for frontmatter, which means a bad `publishedAt` date or a missing `description` fails the build rather than silently shipping wrong data:

```ts
const learn = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/learn' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    relatedCalculators: z.array(z.string()).default([]),
    readingMinutes: z.number().int().positive().optional(),
    tags: z.array(z.string()).default([]),
  }),
});
```

The `relatedCalculators` array is the glue between content and tools. Each article declares which calculator slugs it relates to, and each calculator page queries for articles that reference its slug. That bidirectional linking keeps the site from feeling like a disconnected pile of pages — the learn hub points down to tools, and calculator pages surface the relevant reading.

---

## What's Next

The immediate roadmap is expanding coverage across all three areas of the site.

On the calculator side, there are gaps in retirement and tax scenarios I want to fill — Roth conversion ladders, IRMAA bracket modeling, Social Security breakeven analysis, and marginal tax rate visualization. Each of these involves more complex math than the current set and needs better visualizations to be genuinely useful rather than just a number.

Speaking of visualizations: most calculators currently display results as a table or a basic chart. I want to push further here — things like an interactive amortization timeline you can scrub through, a retirement projection that shows multiple scenarios overlaid, or a net worth curve that accounts for inflation. The goal is results that communicate the *shape* of a financial outcome, not just a single number.

The learn hub is the third area. Each article is meant to pair with a calculator — explain the concept, then let the tool do the math. There are plenty of concepts worth covering that don't have articles yet, and each new article creates a natural entry point for users who land from search.

If you want to try the site: [visualfinances.com](https://visualfinances.com)

Feedback on missing calculators or where the math doesn't match your mental model is genuinely useful.