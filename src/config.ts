import type { Site, SocialObjects } from "./types";

export const SITE: Site = {
  website: "https://stevenpg.com/", // replace this with your deployed domain
  author: "StevenPG",
  profile: "https://stevenpg.com/",
  desc: "My Tech and Life Blog with the writing the articles I wish were written!",
  title: "Coding Steve",
  ogImage: "og.png",
  lightAndDarkMode: true,
  postPerIndex: 6,
  featuredPerIndex: 8, // newest N featured posts shown on the homepage
  postPerPage: 6,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
};

// External sites referenced from multiple places (footer, project entries).
// Change a URL here and every reference follows. Project entries use these
// via the `siteLink` frontmatter field instead of a hard-coded `url`.
export const EXTERNAL_LINKS = {
  goodcat: {
    name: "GoodCat LLC",
    // Temporary host; swap for the real domain when it moves.
    url: "https://goodcat-llc.pages.dev/",
  },
} as const;

export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;

// The fixed set of project types used by the `types` field on project entries
// and by the type filter on /projects/. List order is the filter's button order.
export const PROJECT_TYPES = [
  "Web App",
  "Android App",
  "Library",
  "Self-hosted",
  "Company",
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const LOCALE = {
  lang: "en", // html lang code. Set this empty and default will be "en"
  langTag: ["en-EN"], // BCP 47 Language Tags. Set this empty [] to use the environment default
} as const;

export const LOGO_IMAGE = {
  enable: false,
  svg: true,
  width: 216,
  height: 46,
};

export const SOCIALS: SocialObjects = [
  {
    name: "Github",
    href: "https://github.com/stevenpg",
    linkTitle: ` ${SITE.title} on Github`,
    active: true,
  },
  {
    name: "Substack",
    href: "https://stevenpg1.substack.com/",
    linkTitle: ` ${SITE.title} on Substack`,
    active: true,
  },
];
