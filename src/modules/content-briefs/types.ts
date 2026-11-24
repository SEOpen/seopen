/**
 * Content briefs (Keyword research → Briefs): what a page for one keyword should cover, never the
 * page's text. These are the shapes stored in `content_briefs.brief` and `content_briefs.fill`.
 * Plain data, safe in client components. Not the dashboard summaries in the modules' `brief.ts`.
 */

export const PAGE_TYPES = ["guide", "vs", "alternatives", "best", "pricing"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  guide: "Guide",
  vs: "X vs Y",
  alternatives: "X alternatives",
  best: "Best X for Y",
  pricing: "X pricing",
};

/** The kinds of page a top 10 result can be. */
export const SERP_TYPES = ["guide", "product", "comparison", "list", "tool", "video"] as const;
export type SerpType = (typeof SERP_TYPES)[number];

export const SERP_TYPE_LABEL: Record<SerpType, string> = {
  guide: "Guide or article",
  product: "Product or service page",
  comparison: "Comparison",
  list: "List",
  tool: "Tool",
  video: "Video",
};

/** Where a figure came from and when: `at` is an ISO timestamp, null when the source has no date. */
export interface Source {
  label: string;
  at: string | null;
}

export interface KeywordMetrics {
  keyword: string;
  volume: number | null;
  kd: number | null;
  intent: string | null;
}

export interface SerpEntry {
  position: number;
  url: string | null;
  domain: string | null;
  title: string | null;
  /** null when no rule matched: it counts toward the total but not toward any type. */
  type: SerpType | null;
  /** Why it got its type, such as "title has “vs”". */
  why: string;
  isProject: boolean;
}

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
}

export interface TopPage {
  position: number;
  url: string | null;
  domain: string | null;
  title: string | null;
  headings: Heading[];
  /** "read": headings came from the page. Otherwise only the title is known, and `why` says why. */
  read: "read" | "failed" | "hidden";
  why: string | null;
}

export interface OutlineItem {
  level: 2 | 3;
  text: string;
  /** Where the heading came from, such as "People also ask" or "2 of the top 3 pages". */
  from: string;
}

export interface OwnerInput {
  id: string;
  prompt: string;
}

export interface LinkSuggestion {
  url: string;
  why: string;
  source: Source;
}

/** One option on an alternatives, vs or best-for page. Filled in by the owner; prices need a checked-on date. */
export interface BriefOption {
  name: string;
  url: string | null;
  price: string | null;
  /** YYYY-MM-DD the price was read off the vendor's page. Required when `price` is set. */
  priceCheckedOn: string | null;
  /** One real drawback, in the owner's words. */
  drawback: string | null;
}

export interface ContentBrief {
  version: 1;
  market: { locationCode: number; languageCode: string; name: string };
  template: { pageType: PageType; x: string | null; y: string | null };
  target: KeywordMetrics & { source: Source; merged: KeywordMetrics[]; mergedSource: Source | null };
  serp: {
    source: Source | null;
    results: SerpEntry[];
    /** Each type found, most results first, with the URLs behind it. */
    byType: { type: SerpType; urls: string[] }[];
    dominant: SerpType | null;
    /** Results of the dominant type, out of `total`. */
    agree: number;
    total: number;
    warning: string | null;
    /** When the page type picked doesn't match what ranks. */
    fit: string | null;
  };
  aiOverview: {
    source: Source | null;
    present: boolean;
    /** False when the lookup didn't ask Google to load a late AI Overview, so one may be missing. */
    loaded: boolean;
    cited: { domain: string | null; url: string | null; title: string | null }[];
  };
  questions: { paa: string[]; paaSource: Source | null; keywords: KeywordMetrics[]; keywordsSource: Source | null };
  top3: { pages: TopPage[]; source: Source | null };
  outline: OutlineItem[];
  ownerInputs: OwnerInput[];
  internalLinks: { from: LinkSuggestion[]; to: LinkSuggestion[]; note: string | null };
  /** Options proposed when it was made, before the owner edited them. */
  options: BriefOption[];
  createdAt: string;
}

/** What the owner has written since. Anything missing is still "to fill". */
export interface BriefFill {
  angle?: string | null;
  inputs?: Record<string, string>;
  options?: BriefOption[];
}

/** The brief as one screen or export shows it: the snapshot and the owner's fill together. */
export interface BriefView {
  id: number;
  keyword: string;
  pageType: PageType;
  brief: ContentBrief;
  fill: BriefFill;
  creditsSpent: number;
  createdAt: Date;
  updatedAt: Date;
}
