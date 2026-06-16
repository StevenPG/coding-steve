# Coding Steve

Source for [stevenpg.com](https://stevenpg.com) — a personal tech blog and
project hub built with [Astro](https://astro.build/), React, and
TailwindCSS, deployed to Cloudflare Pages.

## Tech Stack

- **Framework** — [Astro](https://astro.build/)
- **Component framework** — [React](https://reactjs.org/) (for interactive
  pieces like search)
- **Styling** — [TailwindCSS](https://tailwindcss.com/)
- **Fuzzy search** — [Fuse.js](https://fusejs.io/)
- **Deployment** — Cloudflare Pages, via GitHub Actions on push to `main`

## Project Structure

```
/
├── public/              static assets, robots.txt, favicon
├── src/
│   ├── components/      .astro and .tsx components
│   ├── content/
│   │   ├── blog/        blog posts (markdown)
│   │   └── projects/    project portfolio entries (markdown)
│   ├── content.config.ts  content collection schemas
│   ├── layouts/          page layouts
│   ├── pages/            file-based routes
│   ├── styles/           global CSS / theme variables
│   ├── utils/            helpers (OG image generation, sorting, tags, etc.)
│   └── config.ts         site metadata, social links
└── astro.config.ts
```

Astro turns `.astro`/`.md` files under `src/pages/` into routes. Blog posts
live in `src/content/blog/`; projects shown on `/projects/` live in
`src/content/projects/`. See `CLAUDE.md` for blog post frontmatter
conventions.

## Running Locally

```bash
npm install
npm run dev          # http://localhost:4321
```

## Commands

| Command                | Action                                 |
| :--------------------- | :------------------------------------- |
| `npm run dev`          | Start the local dev server             |
| `npm run build`        | Build the production site to `./dist/` |
| `npm run preview`      | Preview the production build locally   |
| `npm run lint`         | Lint with ESLint                       |
| `npm run format`       | Format with Prettier                   |
| `npm run format:check` | Check formatting without writing       |

## Google Site Verification (optional)

Set `PUBLIC_GOOGLE_SITE_VERIFICATION` in your environment to have the
verification meta tag included in the page `<head>`.

## License

Licensed under the MIT License.

---

Originally based on the [AstroPaper](https://github.com/satnaing/astro-paper)
theme by Sat Naing.
