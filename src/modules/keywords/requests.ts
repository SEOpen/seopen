import { TTL } from "@/lib/dataforseo/client";
import { RESOLVE_POISONED } from "@/lib/dataforseo/poisoned";
import type { DfsSpec } from "./dfs";
import { costLabel } from "./format";
import { hasSearchOperators, type LookupQuote } from "./lookup-quote";

export { hasSearchOperators };

/** Labs pricing: $0.012 per task plus $0.00012 per returned row. */
export function labsCost(rows: number) {
  return 0.012 + 0.00012 * rows;
}

export interface Market {
  locationCode: number;
  languageCode: string;
}

/** Rows requested per idea list. Cost scales with rows actually returned. */
export const IDEAS_LIMIT = 500;

/** Question words matched as whole words anywhere in the phrase. */
export const QUESTION_WORDS = ["how", "what", "why", "when", "where", "who", "which", "can", "does", "do", "is", "are", "should", "will"];

const market = (m: Market) => ({ location_code: m.locationCode, language_code: m.languageCode });

export function keywordOverviewSpec(keyword: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/keyword_overview/live",
    task: { keywords: [keyword], ...market(m) },
    ttlSeconds: TTL.month,
    estUsd: labsCost(1),
    module: "keywords",
  };
}

/** Longest keyword DataForSEO accepts. */
export const MAX_KEYWORD_LENGTH = 700;

/**
 * The live top 10 of the market, or of one of its cities: SERP is the one research endpoint that takes a city.
 * $0.002 a page, 5x with search operators, and one more page's price for `resolve_poisoned_results`
 * (assumed at the same multiple, which may overstate it).
 */
export function serpSpec(keyword: string, m: Market, cityCode?: number): DfsSpec {
  return {
    path: "serp/google/organic/live/advanced",
    task: { keyword, ...market(m), ...(cityCode ? { location_code: cityCode } : {}), device: "desktop", depth: 10, ...RESOLVE_POISONED },
    ttlSeconds: TTL.day,
    estUsd: hasSearchOperators(keyword) ? 0.02 : 0.004,
    module: "keywords",
  };
}

/** Searches a month in one city, from Google Ads. Labs, which the other keyword metrics come from, only knows countries. */
export function cityVolumeSpec(keyword: string, m: Market, cityCode: number): DfsSpec {
  return {
    path: "keywords_data/google_ads/search_volume/live",
    task: { keywords: [keyword], location_code: cityCode, language_code: m.languageCode },
    ttlSeconds: TTL.month,
    estUsd: 0.09,
    module: "keywords",
  };
}

/** What a new keyword lookup costs for each kind of phrase, with and without a city, for a button that follows its form. */
export function keywordLookupQuote(m: Market): LookupQuote {
  const price = (keyword: string, withCity: boolean) => costLabel(keywordOverviewSpec(keyword, m).estUsd + serpSpec(keyword, m).estUsd + (withCity ? cityVolumeSpec(keyword, m, 0).estUsd : 0));
  return { kind: "keyword", plain: price("x", false), operators: price("site:x", false), city: price("x", true), cityOperators: price("site:x", true) };
}

export function suggestionsSpec(keyword: string, m: Market, limit = IDEAS_LIMIT): DfsSpec {
  return {
    path: "dataforseo_labs/google/keyword_suggestions/live",
    task: { keyword, ...market(m), limit, order_by: ["keyword_info.search_volume,desc"] },
    ttlSeconds: TTL.month,
    estUsd: labsCost(limit),
    module: "keywords",
  };
}

export function relatedSpec(keyword: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/related_keywords/live",
    task: { keyword, ...market(m), depth: 3, limit: IDEAS_LIMIT, order_by: ["keyword_data.keyword_info.search_volume,desc"] },
    ttlSeconds: TTL.month,
    estUsd: labsCost(IDEAS_LIMIT),
    module: "keywords",
  };
}

/** Phrase-match suggestions that contain a question word. */
export function questionsSpec(keyword: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/keyword_suggestions/live",
    task: {
      keyword,
      ...market(m),
      limit: IDEAS_LIMIT,
      filters: [["keyword", "regex", `(^| )(${QUESTION_WORDS.join("|")})( |$)`]],
      order_by: ["keyword_info.search_volume,desc"],
    },
    ttlSeconds: TTL.month,
    estUsd: labsCost(IDEAS_LIMIT),
    module: "keywords",
  };
}

export const IDEA_MODES = {
  suggestions: { label: "Suggestions", spec: suggestionsSpec, help: "Phrases that contain the seed" },
  related: { label: "Related", spec: relatedSpec, help: "Searches Google shows as related, three levels deep" },
  questions: { label: "Questions", spec: questionsSpec, help: "Suggestions phrased as a question" },
} as const;

export type IdeaMode = keyof typeof IDEA_MODES;
