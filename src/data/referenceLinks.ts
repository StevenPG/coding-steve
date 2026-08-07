export type ReferenceLink = {
  title: string;
  url: string;
  description?: string;
};

export type ReferenceLinkSection = {
  section: string;
  links: ReferenceLink[];
};

/**
 * Quick-hit external links worth bookmarking, grouped by topic.
 * Unlike the reference pages above, these aren't authored/maintained content
 * -- just useful things to find again. Add new entries wherever they fit.
 */
export const referenceLinkSections: ReferenceLinkSection[] = [
  {
    section: "Go",
    links: [
      {
        title: "100 Go Mistakes",
        url: "https://100go.co/",
        description: "Common Go mistakes and how to avoid them.",
      },
      {
        title: "Idiomatic Go",
        url: "https://dmitri.shuralyov.com/idiomatic-go",
        description: "A collection of common Go idioms and style tips.",
      },
    ],
  },
];
