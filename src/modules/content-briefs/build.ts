import { isGoogleRedirect, serpTarget } from "@/lib/dataforseo/serp-target";
import { toKeywordRow } from "@/modules/keywords/transform";
import type { KeywordData, SerpItem, SerpResult } from "@/modules/keywords/types";
import { nestOutline, plainLine, sharedHeadings } from "./headings";
import { classifyResult, serpMix, templateFit } from "./serp-type";
import { ownerInputs, templateHeadings } from "./templates";
import { SERP_TYPE_LABEL, type BriefOption, type ContentBrief, type KeywordMetrics, type OutlineItem, type PageType, type SerpEntry, type Source, type TopPage } from "./types";

/**
 * Builds a brief from what was looked up, pure. No model writes anything: the outline is the
 * template's headings, headings the top 3 pages share, and the questions people ask, each saying
 * where it came from. Text from other sites is kept as one plain line.
 */

/** A SERP item with the parts of People also ask this reads. */
export type BriefSerpItem = SerpItem & { items?: { type?: string; title?: string | null }[] | null };

export interface Loaded<T> {
  value: T;
  /** When the data was fetched, which a cached copy keeps. */
  at: Date | null;
}

export interface BuildInput {
  keyword: string;
  pageType: PageType;
  subjects: { x: string | null; y: string | null };
  market: { locationCode: number; languageCode: string; name: string };
  own: { name: string; domain: string };
  overview: Loaded<KeywordData | null>;
  merged: Loaded<KeywordData[]> | null;
  serp: Loaded<SerpResult | null> & { aioLoaded: boolean };
  questions: Loaded<KeywordData[]>;
  /** The top 3 organic pages with whatever headings could be read. */
  top3: Loaded<TopPage[]>;
  links: ContentBrief["internalLinks"];
  options: BriefOption[];
  now: Date;
}

export const SOURCES = {
  overview: "Keyword overview, DataForSEO Labs",
  merged: "Keyword overview, DataForSEO Labs",
  serp: "Google top 10, live lookup through DataForSEO",
  questions: "Question keywords, DataForSEO Labs",
  pages: "Read from each page",
} as const;

const source = (label: string, at: Date | null): Source => ({ label, at: at ? at.toISOString() : null });
const metrics = (d: KeywordData): KeywordMetrics => {
  const r = toKeywordRow(d);
  return { keyword: d.keyword, volume: r.volume, kd: r.kd, intent: r.intent };
};

const bareDomain = (d: string | null | undefined) => (d ?? "").toLowerCase().replace(/^www\./, "");

/** Organic and video results in page order, each with its page type. */
export function serpEntries(result: SerpResult | null, ownDomain: string): SerpEntry[] {
  const own = bareDomain(ownDomain);
  return ((result?.items ?? []) as BriefSerpItem[])
    .filter((i) => i.type === "organic" || i.type === "video")
    .slice(0, 10)
    .map((item, i) => {
      const target = serpTarget(item);
      const domain = target.domain ? bareDomain(target.domain) : null;
      const title = item.title ? plainLine(item.title) : null;
      const kind = classifyResult({ type: item.type, url: isGoogleRedirect(item.url) ? null : target.url, domain, title });
      return { position: item.type === "organic" ? item.rank_group : i + 1, url: target.url, domain, title, type: kind.type, why: kind.why, isProject: !!domain && !!own && (domain === own || domain.endsWith(`.${own}`)) };
    });
}

/** People also ask questions on the page, in order. */
export function paaQuestions(result: SerpResult | null): string[] {
  const out: string[] = [];
  for (const item of (result?.items ?? []) as BriefSerpItem[]) {
    if (item.type !== "people_also_ask") continue;
    for (const q of item.items ?? []) if (q.title) out.push(plainLine(q.title));
  }
  return [...new Set(out)];
}

export function aiOverview(result: SerpResult | null): { present: boolean; cited: ContentBrief["aiOverview"]["cited"] } {
  const item = ((result?.items ?? []) as BriefSerpItem[]).find((i) => i.type === "ai_overview");
  if (!item) return { present: false, cited: [] };
  const seen = new Set<string>();
  const cited = (item.references ?? [])
    .map((r) => ({ domain: r.domain ? bareDomain(r.domain) : null, url: r.url ?? null, title: r.title ? plainLine(r.title) : null }))
    .filter((r) => {
      const k = r.url ?? r.domain ?? "";
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return { present: true, cited };
}

const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

export function buildOutline(pageType: PageType, subjects: BuildInput["subjects"], options: BriefOption[], top3: TopPage[], paa: string[], questionKeywords: KeywordMetrics[]): OutlineItem[] {
  const template = templateHeadings(pageType, subjects, options);
  const read = top3.filter((p) => p.read === "read");
  const used = new Set(template.map((h) => normal(h.text)));
  // A heading the top pages share joins as an H2 whatever level each page gave it: the outline
  // doesn't carry their parents, so an H3 from them would have nothing to sit under.
  const shared: OutlineItem[] = [];
  if (read.length >= 2) {
    for (const h of sharedHeadings(read.map((p) => p.headings))) {
      if (used.has(normal(h.text))) continue;
      used.add(normal(h.text));
      shared.push({ level: 2, text: h.text, from: `${h.pages} of the top 3 pages` });
    }
  }
  const questions: OutlineItem[] = [];
  for (const q of paa.slice(0, 6)) {
    if (used.has(normal(q))) continue;
    used.add(normal(q));
    questions.push({ level: 3, text: q, from: "People also ask" });
  }
  for (const k of [...questionKeywords].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))) {
    if (questions.length >= 8) break;
    const text = k.keyword.charAt(0).toUpperCase() + k.keyword.slice(1) + (k.keyword.endsWith("?") ? "" : "?");
    if (used.has(normal(text))) continue;
    used.add(normal(text));
    questions.push({ level: 3, text, from: "Question keywords" });
  }
  const questionBlock: OutlineItem[] = questions.length ? [{ level: 2, text: "Questions people ask", from: "People also ask and question keywords" }, ...questions] : [];
  return nestOutline(pageType === "guide" ? [...shared, ...template, ...questionBlock] : [...template, ...shared, ...questionBlock]);
}

export function buildBrief(input: BuildInput): ContentBrief {
  const serp = input.serp.value;
  const results = serpEntries(serp, input.own.domain);
  const mix = serpMix(results);
  const aio = aiOverview(serp);
  const paa = paaQuestions(serp);
  const target = input.overview.value ? metrics(input.overview.value) : { keyword: input.keyword, volume: null, kd: null, intent: null };
  const questionKeywords = input.questions.value
    .map(metrics)
    .filter((k) => k.keyword.toLowerCase() !== input.keyword.toLowerCase())
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 15);
  const serpSource = serp ? source(SOURCES.serp, input.serp.at) : null;

  return {
    version: 1,
    market: input.market,
    template: { pageType: input.pageType, ...input.subjects },
    target: {
      ...target,
      keyword: input.keyword,
      source: source(SOURCES.overview, input.overview.at),
      merged: input.merged ? input.merged.value.map(metrics) : [],
      mergedSource: input.merged ? source(SOURCES.merged, input.merged.at) : null,
    },
    serp: { source: serpSource, results, ...mix, fit: templateFit(input.pageType, mix.dominant, (t) => SERP_TYPE_LABEL[t]) },
    aiOverview: { source: serpSource, present: aio.present, loaded: input.serp.aioLoaded, cited: aio.cited },
    questions: { paa, paaSource: serpSource, keywords: questionKeywords, keywordsSource: source(SOURCES.questions, input.questions.at) },
    top3: { pages: input.top3.value, source: input.top3.value.length ? source(SOURCES.pages, input.top3.at) : null },
    outline: buildOutline(input.pageType, input.subjects, input.options, input.top3.value, paa, questionKeywords),
    ownerInputs: ownerInputs(input.pageType, input.subjects),
    internalLinks: input.links,
    options: input.options,
    createdAt: input.now.toISOString(),
  };
}
