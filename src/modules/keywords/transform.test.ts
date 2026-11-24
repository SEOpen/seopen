import { keywordQuery } from "./market";
import { hasSearchOperators, MAX_KEYWORD_LENGTH, serpSpec } from "./requests";
import { describe, expect, it } from "vitest";
import { columnsWithData, filterRows, hasTerm, relatedRows, serpRows, toKeywordRow, volumeTrend, wordGroups, type KeywordRow } from "./transform";
import type { KeywordData, SerpResult } from "./types";

const kd = (keyword: string, volume: number | null, extra: Partial<KeywordData> = {}): KeywordData => ({
  keyword,
  keyword_info: { search_volume: volume, cpc: 1.28, competition: 0.01, competition_level: "LOW", monthly_searches: null },
  keyword_properties: { keyword_difficulty: 14 },
  search_intent_info: { main_intent: "transactional" },
  ...extra,
});

const row = (keyword: string, volume: number | null, over: Partial<KeywordRow> = {}): KeywordRow => ({ ...toKeywordRow(kd(keyword, volume)), ...over });

describe("toKeywordRow", () => {
  it("flattens the Labs keyword block", () => {
    expect(toKeywordRow(kd("mac journal", 2900))).toEqual({
      keyword: "mac journal",
      volume: 2900,
      kd: 14,
      cpc: 1.28,
      competition: 0.01,
      intent: "transactional",
      words: 2,
    });
  });

  it("reads a difficulty of 0 as unknown and rounds CPC to the cent", () => {
    const r = toKeywordRow(kd("open source seo audit tool", 40, { keyword_properties: { keyword_difficulty: 0 }, keyword_info: { search_volume: 40, cpc: 9.930000305175781, competition: 0.1, competition_level: "LOW", monthly_searches: null } }));
    expect(r).toMatchObject({ kd: null, cpc: 9.93 });
  });

  it("tolerates missing blocks", () => {
    const r = toKeywordRow({ keyword: "x y z", keyword_info: null, keyword_properties: null, search_intent_info: null });
    expect(r).toMatchObject({ volume: null, kd: null, cpc: null, intent: null, words: 3 });
  });
});

describe("relatedRows", () => {
  it("dedupes keywords and keeps the shallowest depth", () => {
    const rows = relatedRows([
      { depth: 2, keyword_data: kd("a b", 10) },
      { depth: 1, keyword_data: kd("a b", 10) },
      { depth: 3, keyword_data: kd("c", 5) },
    ]);
    expect(rows.map((r) => [r.keyword, r.depth])).toEqual([
      ["a b", 1],
      ["c", 3],
    ]);
  });
});

describe("volumeTrend", () => {
  it("returns the last 12 months oldest first", () => {
    const monthly = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9 - i, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, search_volume: 100 + i };
    });
    const trend = volumeTrend(monthly);
    expect(trend).toHaveLength(12);
    expect(trend[0]).toEqual({ date: "2025-11-01", value: 111 });
    expect(trend[11]).toEqual({ date: "2026-10-01", value: 100 });
  });

  it("keeps a month with no number as a gap, not a zero", () => {
    expect(volumeTrend([{ year: 2026, month: 9, search_volume: null }])).toEqual([{ date: "2026-09-01", value: null }]);
  });

  it("handles null", () => {
    expect(volumeTrend(null)).toEqual([]);
  });
});

describe("columnsWithData", () => {
  const columns = [{ key: "keyword" }, { key: "kd" }, { key: "source" }, { key: "volume" }];

  it("hides a column empty in every row, and keeps zero", () => {
    const rows = [
      { keyword: "a", kd: null, source: "", volume: 0 },
      { keyword: "b", source: null, volume: null },
    ];
    expect(columnsWithData(columns, rows).map((c) => c.key)).toEqual(["keyword", "volume"]);
  });

  it("keeps a column with data in any row", () => {
    expect(columnsWithData(columns, [{ keyword: "a", kd: null }, { keyword: "b", kd: 12 }]).map((c) => c.key)).toEqual(["keyword", "kd"]);
  });
});

describe("serpRows", () => {
  const result: SerpResult = {
    keyword: "mac journal",
    datetime: "",
    check_url: "",
    item_types: ["ai_overview", "organic"],
    se_results_count: 126,
    items: [
      { type: "ai_overview", rank_group: 1, rank_absolute: 1, references: [{ domain: "apple.com", url: "u", title: null }] },
      { type: "organic", rank_group: 1, rank_absolute: 2, domain: "www.reddit.com", url: "https://www.reddit.com/r/x", title: "Reddit" },
      { type: "organic", rank_group: 2, rank_absolute: 3, domain: "blog.alphanote.example", url: "https://blog.alphanote.example/", title: "Mine" },
    ],
  };

  it("uses organic rank for organic rows and strips www", () => {
    const rows = serpRows(result, "alphanote.example");
    expect(rows.map((r) => [r.type, r.position, r.domain])).toEqual([
      ["ai_overview", 1, null],
      ["organic", 1, "reddit.com"],
      ["organic", 2, "blog.alphanote.example"],
    ]);
    expect(rows[0].title).toBe("1 source cited");
  });

  it("counts an AI Overview's sources in its parts too (QA B11)", () => {
    const nested = { ...result, items: [{ type: "ai_overview", rank_group: 1, rank_absolute: 1, items: [{ references: [{ domain: "a.example", url: "https://a.example/x", title: null }] }, { references: [{ domain: "b.example", url: "https://b.example/y", title: null }, { domain: "a.example", url: "https://a.example/x", title: null }] }] }] };
    expect(serpRows(nested)[0].title).toBe("2 sources cited");
    expect(serpRows({ ...result, items: [{ type: "ai_overview", rank_group: 1, rank_absolute: 1 }] })[0].title).toBe("No sources cited");
  });

  it("flags the project's domain and its subdomains", () => {
    expect(serpRows(result, "alphanote.example").map((r) => r.isProject)).toEqual([false, false, true]);
    expect(serpRows(result, null).some((r) => r.isProject)).toBe(false);
  });

  it("says when a row's URL is only the site's origin, with Google's breadcrumb", () => {
    const wrapped: SerpResult = {
      ...result,
      items: [
        { type: "organic", rank_group: 1, rank_absolute: 1, domain: "google.com", url: "https://google.com/goto?url=CAES", breadcrumb: "https://www.sitepoint.com › blog › backlink-checkers", title: "Top 10 Best Free Backlink Checker Tools" },
        { type: "organic", rank_group: 2, rank_absolute: 2, domain: "blog.alphanote.example", url: "https://blog.alphanote.example/post", breadcrumb: "https://blog.alphanote.example › post", title: "Mine" },
      ],
    };
    expect(serpRows(wrapped, "alphanote.example").map((r) => [r.domain, r.url, r.originOnly, r.breadcrumb])).toEqual([
      ["sitepoint.com", "https://www.sitepoint.com/", true, "blog › backlink-checkers"],
      ["blog.alphanote.example", "https://blog.alphanote.example/post", false, null],
    ]);
  });
});

describe("wordGroups", () => {
  const rows = [
    row("mac journal clock", 100),
    row("clock journal for mac", 50),
    row("mac journal daily", 30),
    row("daily journal", 20),
    row("free mac journal", 10),
  ];

  it("counts shared words, skipping stopwords and seed words", () => {
    const groups = wordGroups(rows, "mac journal");
    expect(groups[0]).toEqual({ word: "clock", count: 2, volume: 150 });
    expect(groups.find((g) => g.word === "daily")).toEqual({ word: "daily", count: 2, volume: 50 });
    expect(groups.find((g) => g.word === "clock")).toEqual({ word: "clock", count: 2, volume: 150 });
    expect(groups.find((g) => g.word === "for")).toBeUndefined();
    expect(groups.find((g) => g.word === "mac")).toBeUndefined();
    expect(groups.find((g) => g.word === "free")).toBeUndefined(); // only once
  });

  it("includes two-word phrases that aren't the seed itself", () => {
    const groups = wordGroups(rows, "mac journal");
    expect(groups.find((g) => g.word === "mac journal")).toBeUndefined();
    expect(wordGroups(rows, "").find((g) => g.word === "mac journal")?.count).toBe(3);
  });
});

describe("filterRows", () => {
  const rows = [
    row("mac journal clock", 100, { kd: 10, intent: "informational" }),
    row("clock", 5000, { kd: 70, intent: "navigational", cpc: null }),
    row("daily journal for mac", 20, { kd: null }),
  ];

  it("applies ranges inclusively and drops rows missing a filtered value", () => {
    expect(filterRows(rows, { volume: [20, 100] }).map((r) => r.keyword)).toEqual(["mac journal clock", "daily journal for mac"]);
    expect(filterRows(rows, { kd: [null, 50] }).map((r) => r.keyword)).toEqual(["mac journal clock"]);
    expect(filterRows(rows, { cpc: [null, null] })).toHaveLength(3);
  });

  it("filters by words, intent, include and exclude terms", () => {
    expect(filterRows(rows, { words: [3, null] }).map((r) => r.keyword)).toEqual(["mac journal clock", "daily journal for mac"]);
    expect(filterRows(rows, { intents: ["navigational"] }).map((r) => r.keyword)).toEqual(["clock"]);
    expect(filterRows(rows, { include: ["clock"] })).toHaveLength(2);
    expect(filterRows(rows, { include: ["mac journal"], exclude: ["clock"] })).toHaveLength(0);
    expect(filterRows(rows, { exclude: ["clock"] }).map((r) => r.keyword)).toEqual(["daily journal for mac"]);
  });

  it("matches whole words only", () => {
    expect(hasTerm("mac journals", "journal")).toBe(false);
    expect(hasTerm("Mac  Journal", "mac journal")).toBe(true);
  });
});

describe("query validation", () => {
  it("caps keywords at 700 characters", () => {
    expect(keywordQuery("  Mac Journal ")).toEqual({ q: "mac journal", tooLong: false });
    expect(keywordQuery("a".repeat(MAX_KEYWORD_LENGTH))).toMatchObject({ tooLong: false });
    expect(keywordQuery("a".repeat(MAX_KEYWORD_LENGTH + 1))).toEqual({ q: "", tooLong: true });
  });

  it("prices SERP checks with search operators at 5×", () => {
    const us = { locationCode: 2840, languageCode: "en" };
    expect(hasSearchOperators("site:example.com journal")).toBe(true);
    expect(hasSearchOperators("mac journal")).toBe(false);
    expect(serpSpec("intitle:journal", us).estUsd).toBeCloseTo(serpSpec("journal", us).estUsd * 5);
  });
});
