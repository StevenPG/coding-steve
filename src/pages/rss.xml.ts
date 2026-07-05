import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import getSortedPosts from "@utils/getSortedPosts";
import { SITE } from "@config";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const parser = new MarkdownIt();

/**
 * Posts reference images in public/ a few different ways
 * (/assets/..., /public/assets/..., ../../../public/assets/...).
 * Feed readers resolve none of these, so rewrite every relative
 * src/href to an absolute URL on the deployed site.
 */
function absolutizeUrls(html: string): string {
  return html.replace(
    /(src|href)="(?!https?:\/\/|mailto:|#)([^"]+)"/g,
    (_match, attr: string, url: string) => {
      const path = url
        .replace(/^(\.\.\/)+public\//, "")
        .replace(/^\/public\//, "")
        .replace(/^\//, "");
      return `${attr}="${new URL(path, SITE.website).href}"`;
    }
  );
}

export async function GET() {
  const posts = await getCollection("blog");
  const sortedPosts = getSortedPosts(posts);
  return rss({
    title: SITE.title,
    description: SITE.desc,
    site: SITE.website,
    items: sortedPosts.map(post => ({
      link: `posts/${post.data.slug}/`,
      title: post.data.title,
      description: post.data.description,
      pubDate: new Date(post.data.modDatetime ?? post.data.pubDatetime),
      content: sanitizeHtml(absolutizeUrls(parser.render(post.body ?? "")), {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
      }),
    })),
  });
}
