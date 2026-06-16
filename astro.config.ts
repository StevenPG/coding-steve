import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";
import partytown from "@astrojs/partytown"
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE } from "./src/config";

/**
 * Build a map of post URL path -> last-modified ISO date by reading blog
 * frontmatter directly. Used to add <lastmod> to the sitemap so Google gets a
 * freshness signal for each post. Kept dependency-free (simple frontmatter
 * scan) so it works on a clean CI install.
 */
function getPostLastmodMap(): Record<string, string> {
  const blogDir = fileURLToPath(new URL("./src/content/blog", import.meta.url));
  const map: Record<string, string> = {};

  const field = (src: string, key: string) =>
    src.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");

  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(blogDir, file), "utf-8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    if (!fm) continue;

    const slug = field(fm, "slug");
    const date = field(fm, "modDatetime") ?? field(fm, "pubDatetime");
    if (!slug || !date) continue;

    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) continue;
    map[`/posts/${slug}/`] = parsed.toISOString();
  }

  return map;
}

const postLastmod = getPostLastmodMap();

// https://astro.build/config
export default defineConfig({
  site: SITE.website,
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    react(),
    sitemap({
      serialize(item) {
        const { pathname } = new URL(item.url);
        const lastmod = postLastmod[pathname];
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
    partytown({ config: { forward: ['dataLayer.push'] } }),
  ],
  markdown: {
    remarkPlugins: [
      remarkToc,
      [
        remarkCollapse,
        {
          test: "Table of contents",
        },
      ],
    ],
    shikiConfig: {
      // For more themes, visit https://shiki.style/themes
      themes: { light: "min-light", dark: "night-owl" },
      wrap: true,
    },
  },
  vite: {
    optimizeDeps: {
      exclude: ["@resvg/resvg-js"],
    },
  },
  scopedStyleStrategy: "where",
});
