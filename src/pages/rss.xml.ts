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

/**
 * Wrap post content with a syndication banner and footer so copies
 * imported elsewhere (dev.to, feed readers) point readers back to the
 * original post. Kept as simple blockquote/paragraph HTML because
 * dev.to converts imported HTML to markdown and strips styling.
 */
function withSyndicationLinks(html: string, postUrl: string): string {
  const banner =
    `<blockquote><p><em>Originally published at ` +
    `<a href="${postUrl}">stevenpg.com</a> — ` +
    `code samples and images render best on the original post.</em></p></blockquote>`;
  const footer =
    `<hr/><p><em>Thanks for reading! You can find this post and more at ` +
    `<a href="${postUrl}">stevenpg.com</a>. If it helped you, you can ` +
    `<a href="https://www.buymeacoffee.com/codingsteve">support the site here</a>.</em></p>`;
  return banner + html + footer;
}

export async function GET() {
  const posts = await getCollection("blog");
  const sortedPosts = getSortedPosts(posts);
  return rss({
    title: SITE.title,
    description: SITE.desc,
    site: SITE.website,
    items: sortedPosts.map(post => {
      const postUrl = new URL(`posts/${post.data.slug}/`, SITE.website).href;
      const body = sanitizeHtml(
        absolutizeUrls(parser.render(post.body ?? "")),
        {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
        }
      );
      return {
        link: `posts/${post.data.slug}/`,
        title: post.data.title,
        description: post.data.description,
        pubDate: new Date(post.data.modDatetime ?? post.data.pubDatetime),
        content: withSyndicationLinks(body, postUrl),
      };
    }),
  });
}
