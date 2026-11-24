import type { PageType, SerpType } from "./types";

/**
 * What kind of page each top 10 result is, from what the result itself shows: its type, title, URL and
 * site. Rules run in order and the first match wins, so a "best X vs Y" title counts as a comparison.
 * A result no rule matches stays unclassified rather than being guessed.
 */

interface ResultLike {
  type: string;
  url: string | null;
  domain: string | null;
  title: string | null;
}

const VIDEO_SITES = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|dailymotion\.com)$/;
const SHOPS = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|walmart\.com|target\.com|bestbuy\.com|aliexpress\.com)$/;

const TOOL_WORD = /\b(calculator|generator|checker|converter|estimator|planner|template|simulator)\b/;
const SEVERAL_TOOLS = /\b(calculators|generators|checkers|converters|estimators|planners|templates|simulators|tools|apps|software|extensions|plugins)\b/;
const NUMBERED = /^\s*(the\s+)?\d+\s|\b(top|best)\s+\d+\b|\b\d+\s+(best|top|ways|ideas|tips|examples)\b/;
const BEST_OF = /^\s*(the\s+)?best\b/;
/**
 * An address slug a list has: one that starts "best-" or "top-10-", or names several tools
 * ("/best-backlink-checker", "/blog/free-backlink-checker-tools"). A one-word segment such as "/tools/" is a
 * section, not a list.
 */
const LIST_SLUG = /(^|\/)(best|top-\d+)-[^/]|(^|\/)[^/]*-(calculators|generators|checkers|converters|estimators|planners|templates|simulators|tools|apps|software|extensions|plugins)(-[^/]*)?(\/|$)/;
/** Businesses a local search ranks, in the plural: "Top web design firms in Salem" is a directory's list. */
const BUSINESSES = /\b(companies|firms|agencies|studios|consultants|designers|developers|contractors|providers|specialists|experts|businesses|shops|services)\b/;
/** What a business's own page calls itself: "Web Consulting Services", "eCommerce Website Designers Firm", "plumber near me". */
const SERVICE_WORD = /\b(services?|agency|agencies|company|companies|firms?|consulting|consultants?|specialists?|contractors?|near me|repair|installation|cleaning)\b/;

const path = (url: string | null) => {
  try {
    return url ? new URL(url).pathname.toLowerCase() : "";
  } catch {
    return "";
  }
};

export function classifyResult(r: ResultLike): { type: SerpType | null; why: string } {
  const title = (r.title ?? "").toLowerCase();
  const p = path(r.url);
  const domain = (r.domain ?? "").toLowerCase();
  if (r.type === "video" || VIDEO_SITES.test(domain)) return { type: "video", why: r.type === "video" ? "a video result" : `a video on ${domain}` };
  if (/\b(vs\.?|versus|compared?|comparison)\b/.test(title) || /-vs-|\/vs\//.test(p)) return { type: "comparison", why: "title or address compares options" };
  if (/\balternatives?\b/.test(title)) return { type: "comparison", why: "title has “alternatives”" };
  // A numbered list, or a best-of that names several tools, is a list even when it names a tool type
  // ("10 best rank checkers", "Best backlink checker tools"); "Best free mortgage calculator" stays a tool.
  if (NUMBERED.test(title) || (BEST_OF.test(title) && SEVERAL_TOOLS.test(title))) return { type: "list", why: "title is a numbered or best-of list" };
  // A blog's "best backlink checker" post names the tool in its title, but its address says it's a list.
  if (LIST_SLUG.test(p)) return { type: "list", why: "address reads as a best-of list or a list of tools" };
  if (TOOL_WORD.test(title) || /\/(tools?|calculator|generator)s?\//.test(p)) return { type: "tool", why: "title or address names a tool" };
  if (BEST_OF.test(title)) return { type: "list", why: "title is a numbered or best-of list" };
  if (/\b(top|best|leading)\b/.test(title) && BUSINESSES.test(title)) return { type: "list", why: "title lists the top businesses of a kind" };
  if (SHOPS.test(domain) || /\/(products?|shop|store|item|dp|p|buy|pricing|plans)(\/|$)/.test(p) || /\b(buy|shop|for sale|pricing|price list|free trial|sign up)\b/.test(title)) return { type: "product", why: "a shop, product or pricing page" };
  if (/\b(how to|what is|what are|why|guide|tutorial|explained|tips|step by step|beginner)\b/.test(title) || /\/(blog|guides?|learn|articles?|resources|help|docs|wiki|news)\//.test(p)) return { type: "guide", why: "title or address reads as an article" };
  if (SERVICE_WORD.test(title)) return { type: "product", why: "title names a service or the business that offers it" };
  // No address is no home page: a result Google gave no link for stays unclassified.
  if (r.url && (p === "/" || p === "")) return { type: "product", why: "a site's home page" };
  return { type: null, why: "no rule matched" };
}

export interface SerpMix {
  byType: { type: SerpType; urls: string[] }[];
  dominant: SerpType | null;
  agree: number;
  total: number;
  warning: string | null;
}

/** Fewer than this many of 10 sharing a type means Google hasn't settled on one. */
export const AGREE_AT = 6;

export function serpMix(results: { type: SerpType | null; url: string | null }[]): SerpMix {
  const total = results.length;
  const groups = new Map<SerpType, string[]>();
  for (const r of results) if (r.type) groups.set(r.type, [...(groups.get(r.type) ?? []), r.url ?? "(address hidden)"]);
  const byType = [...groups.entries()].map(([type, urls]) => ({ type, urls })).sort((a, b) => b.urls.length - a.urls.length);
  const top = byType[0];
  // A tie at the top has no dominant type.
  const dominant = top && byType[1]?.urls.length !== top.urls.length ? top.type : null;
  const agree = top?.urls.length ?? 0;
  const of = Math.min(total, 10);
  const typed = byType.reduce((n, g) => n + g.urls.length, 0);
  // Under two of a type, "only 1 share a page type" says nothing: say no two share one, and how many could be typed at all.
  const none = !typed ? `None of the ${of} results could be given a page type` : typed < of ? `Only ${typed} of ${of} results could be given a page type, and no two share one` : `No two of the ${of} results share a page type`;
  const warning = !total
    ? null
    : agree < 2 && agree < of
      ? `${none}, so there's no pattern to follow. Read the results before choosing one.`
      : agree < Math.min(AGREE_AT, of)
        ? `Only ${agree} of ${of} results share a page type, so Google is still mixing kinds of page here. Read the results before choosing one.`
        : null;
  return { byType, dominant, agree, total, warning };
}

/** The page types each template is, for saying when it doesn't match what ranks. */
const TEMPLATE_SERP: Record<PageType, SerpType[]> = {
  guide: ["guide"],
  vs: ["comparison"],
  alternatives: ["comparison", "list"],
  best: ["list", "comparison"],
  pricing: ["product"],
};

export function templateFit(pageType: PageType, dominant: SerpType | null, label: (t: SerpType) => string): string | null {
  if (!dominant || TEMPLATE_SERP[pageType].includes(dominant)) return null;
  if (dominant === "guide" && pageType !== "guide") return `Most of the top 10 are articles, not pages that sell or compare. A ${label("guide").toLowerCase()} may rank where this page type won't.`;
  return `Most of the top 10 are ${label(dominant).toLowerCase()}s, which this page type isn't.`;
}
