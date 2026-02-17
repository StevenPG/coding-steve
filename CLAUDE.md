# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Coding Steve** (stevenpg.com), a personal tech blog built with the AstroPaper theme on **Astro 4**. It uses React for interactive components, TailwindCSS for styling, and deploys to **Cloudflare Pages** via GitHub Actions on push to `main`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server at localhost:4321 |
| `npm run build` | Production build to `./dist/` |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier (includes Astro plugin) |
| `npm run format:check` | Check formatting without writing |

## Architecture

- **Blog posts**: Markdown files in `src/content/blog/` with Zod-validated frontmatter (defined in `src/content/config.ts`)
- **Site config**: `src/config.ts` — site metadata, social links, pagination settings
- **Astro config**: `astro.config.ts` — integrations (Tailwind, React, Sitemap, Partytown for analytics), remark plugins (TOC, collapse), Shiki code highlighting
- **Layouts/Pages**: `src/layouts/` and `src/pages/` — Astro file-based routing
- **Components**: `src/components/` — mix of `.astro` and React (`.tsx`) components
- **Utilities**: `src/utils/` — helper functions
- **Static assets**: `public/` directory

## Blog Post Conventions

Posts use the naming pattern `YYYY-MM-DD-slug-name.md` and require this frontmatter:

```yaml
---
author: StevenPG
pubDatetime: 2024-02-04T12:00:00.000Z
title: Post Title
slug: post-slug
featured: false
ogImage: /assets/default-og-image.png
tags:
  - tag1
  - tag2
description: A short description.
---
```

Optional fields: `modDatetime`, `draft` (hides from published), `canonicalURL`.

## Deployment

Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/workflow.yml`) which builds with Node 22 and deploys to Cloudflare Pages via Wrangler.
