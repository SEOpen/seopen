import type { KeywordData, SerpResult } from "@/modules/keywords/types";
import type { BuildInput } from "./build";

/** Made-up lookups for tests: one keyword's metrics, a top 10 with an AI Overview and People also ask, and question keywords. */

export const kw = (keyword: string, volume: number, kd = 20, intent = "informational"): KeywordData => ({
  keyword,
  keyword_info: { search_volume: volume, cpc: 1, competition: 0.2, competition_level: "LOW", monthly_searches: [] },
  keyword_properties: { keyword_difficulty: kd },
  search_intent_info: { main_intent: intent },
});

const organic = (n: number, url: string, title: string) => ({ type: "organic", rank_group: n, rank_absolute: n + 1, url, domain: new URL(url).hostname, title });

export const SERP: SerpResult = {
  keyword: "prune roses",
  datetime: "2026-11-10 10:00:00 +00:00",
  check_url: "https://www.google.com/search?q=prune+roses",
  item_types: ["ai_overview", "organic", "people_also_ask"],
  se_results_count: 1000,
  items: [
    {
      type: "ai_overview",
      rank_group: 1,
      rank_absolute: 1,
      references: [
        { domain: "www.rhs.example", url: "https://www.rhs.example/prune", title: "Pruning roses" },
        { domain: "www.rhs.example", url: "https://www.rhs.example/prune", title: "Pruning roses" },
      ],
    },
    organic(1, "https://www.rhs.example/prune", "How to prune roses"),
    organic(2, "https://garden.example/blog/roses", "Pruning roses: a guide"),
    organic(3, "https://fernhill.example/roses", "Rose pruning at Fernhill"),
    { type: "people_also_ask", rank_group: 1, rank_absolute: 5, items: [{ type: "people_also_ask_element", title: "When should roses be pruned?" }, { type: "people_also_ask_element", title: "How far back do you cut roses?" }] } as never,
    organic(4, "https://www.youtube.com/watch?v=1", "Pruning roses video"),
    organic(5, "https://tips.example/guide", "Rose pruning tips"),
  ],
};

export function buildInput(over: Partial<BuildInput> = {}): BuildInput {
  const at = new Date("2026-11-10T10:00:00.000Z");
  return {
    keyword: "prune roses",
    pageType: "guide",
    subjects: { x: null, y: null },
    market: { locationCode: 2840, languageCode: "en", name: "United States" },
    own: { name: "Fernhill", domain: "fernhill.example" },
    overview: { value: kw("prune roses", 2400, 31), at },
    merged: { value: [kw("pruning roses", 900, 28)], at },
    serp: { value: SERP, at, aioLoaded: true },
    questions: { value: [kw("when to prune roses", 1600), kw("how to prune roses", 1300), kw("prune roses", 2400)], at },
    top3: {
      value: [
        { position: 1, url: "https://www.rhs.example/prune", domain: "rhs.example", title: "How to prune roses", read: "read", why: null, headings: [{ level: 2, text: "When to prune" }, { level: 2, text: "Tools" }] },
        { position: 2, url: "https://garden.example/blog/roses", domain: "garden.example", title: "Pruning roses: a guide", read: "read", why: null, headings: [{ level: 2, text: "When to prune?" }] },
        { position: 3, url: null, domain: "fernhill.example", title: "Rose pruning at Fernhill", read: "hidden", why: "Google hides this result's address, so the page couldn't be read.", headings: [] },
      ],
      at,
    },
    links: { from: [], to: [], note: "There's no Search Console data or finished site audit for this project yet, so there are no internal link suggestions." },
    options: [],
    now: at,
    ...over,
  };
}
