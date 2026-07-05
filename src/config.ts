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
  postPerPage: 6,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
};

export const ADSENSE = {
  enable: true,
  clientId: "ca-pub-9553425410079173",
  // Create display ad units in the AdSense dashboard (Ads -> By ad unit ->
  // Display ad) and paste each unit's slot ID below. An AdUnit renders only
  // when its slot ID is filled in, so empty strings are safe to deploy.
  slots: {
    belowPost: "", // shown after article content on post pages
    postList: "", // shown below the paginated post list
  },
} as const;

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
