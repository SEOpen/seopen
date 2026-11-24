import { describe, expect, it } from "vitest";
import { historyFrom } from "./requests";
import { buildGap, competitorRows, distribution, filterView, gapCounts, gapTabs, historySeries, isHostname, kpis, pageRows, rankedRows, sectionOf, sectionRows, withData } from "./transform";
import type { OrganicMetrics, RankedKeywordItem } from "./types";

describe("withData", () => {
  const columns = [{ key: "a" }, { key: "b" }, { key: "c" }];

  it("hides a column empty in every row", () => {
    expect(withData(columns, [{ a: 1, b: null, c: "" }, { a: 0 }]).map((c) => c.key)).toEqual(["a"]);
  });

  it("keeps a column it's told to, and all of them with no rows", () => {
    expect(withData(columns, [{ a: 1 }], ["c"]).map((c) => c.key)).toEqual(["a", "c"]);
    expect(withData(columns, [])).toBe(columns);
  });
});

const metrics = (over: Partial<OrganicMetrics> = {}): OrganicMetrics => ({
  pos_1: 1,
  pos_2_3: 2,
  pos_4_10: 3,
  pos_11_20: 4,
  pos_21_30: 1,
  pos_31_40: 1,
  pos_41_50: 1,
  pos_51_60: 1,
  pos_61_70: 0,
  pos_71_80: 0,
  pos_81_90: 0,
  pos_91_100: 1,
  etv: 8.86,
  count: 15,
  estimated_paid_traffic_cost: 192.3,
  is_new: 1,
  is_up: 2,
  is_down: 3,
  is_lost: 4,
  ...over,
});

/** `pos` is the organic position (rank_group); `abs` overrides rank_absolute, and `prev` is absolute. */
function ranked(
  keyword: string,
  pos: number,
  opts: { etv?: number; prev?: number | null; isNew?: boolean; lost?: boolean; volume?: number; abs?: number; type?: string } = {},
): RankedKeywordItem {
  const abs = opts.abs ?? pos;
  const prev = opts.prev === undefined ? abs : opts.prev;
  return {
    keyword_data: {
      keyword,
      keyword_info: { search_volume: opts.volume ?? 100, cpc: 1, competition: 0.1, competition_level: "LOW", monthly_searches: null },
      keyword_properties: { keyword_difficulty: null },
      search_intent_info: { main_intent: "informational" },
    },
    ranked_serp_element: {
      serp_item: {
        type: opts.type ?? "organic",
        rank_group: pos,
        rank_absolute: abs,
        url: `https://example.com/${keyword.replace(/ /g, "-")}`,
        relative_url: null,
        etv: opts.etv ?? 1,
        estimated_paid_traffic_cost: null,
        rank_changes: {
          previous_rank_absolute: opts.isNew ? null : prev,
          is_new: !!opts.isNew,
          is_up: !opts.isNew && prev != null && prev > abs,
          is_down: !opts.isNew && prev != null && prev < abs,
        },
      },
      serp_item_types: ["organic"],
      keyword_difficulty: 22,
      is_lost: !!opts.lost,
    },
  };
}

describe("kpis and distribution", () => {
  it("derives top-3 and top-10 counts", () => {
    expect(kpis(metrics())).toEqual({ keywords: 15, traffic: 9, trafficValue: 192.3, top3: 3, top10: 6 });
    expect(kpis(null)).toBeNull();
  });

  it("buckets positions", () => {
    expect(distribution(metrics()).map((b) => b.count)).toEqual([3, 3, 4, 3, 2]);
  });
});

describe("historySeries", () => {
  it("sorts months and skips missing metrics", () => {
    const series = historySeries([
      { year: 2026, month: 10, metrics: { organic: metrics({ etv: 20, count: 9 }) } },
      { year: 2026, month: 2, metrics: { organic: metrics({ etv: 5.4, count: 4 }) } },
      { year: 2026, month: 3, metrics: { organic: null } },
    ]);
    expect(series).toEqual([
      { date: "2026-02", traffic: 5, keywords: 4, top10: 6 },
      { date: "2026-10", traffic: 20, keywords: 9, top10: 6 },
    ]);
  });

  it("asks for 24 months from the first of the month", () => {
    expect(historyFrom(new Date("2026-10-29T12:00:00Z"))).toBe("2024-10-01");
  });
});

describe("rankedRows", () => {
  const rows = rankedRows([
    ranked("a", 15, { prev: 16, etv: 3 }),
    ranked("b", 25, { prev: 22, etv: 1 }),
    ranked("c", 40, { isNew: true, etv: 0 }),
    ranked("d", 60, { lost: true, etv: 5 }),
    ranked("e", 26, { etv: 0 }),
  ]);

  it("classifies movement and computes change as previous − current", () => {
    expect(rows.map((r) => [r.keyword, r.status, r.change])).toEqual([
      ["a", "improved", 1],
      ["b", "declined", -3],
      ["c", "new", null],
      ["d", "lost", null],
      ["e", "same", 0],
    ]);
  });

  it("puts lost keywords' last position in previous and excludes them from traffic share", () => {
    const lost = rows.find((r) => r.keyword === "d")!;
    expect(lost).toMatchObject({ position: null, previous: 60, traffic: 0, share: 0 });
    expect(rows.find((r) => r.keyword === "a")!.share).toBeCloseTo(0.75);
  });

  it("falls back to the SERP element's difficulty", () => {
    expect(rows[0].kd).toBe(22);
  });

  it("reads a difficulty of 0 on both blocks as unknown", () => {
    const item = ranked("z", 4);
    item.keyword_data.keyword_properties = { keyword_difficulty: 0 };
    item.ranked_serp_element.keyword_difficulty = 0;
    expect(rankedRows([item])[0].kd).toBeNull();
  });

  it("shows the organic position but computes change from absolute ranks", () => {
    const [row] = rankedRows([ranked("f", 3, { abs: 7, prev: 9 })]);
    expect(row).toMatchObject({ position: 3, absolute: 7, previous: 9, change: 2, status: "improved" });
    expect(row.change).toBe(row.previous! - row.absolute!);
  });

  it("drops paid items", () => {
    const mixed = rankedRows([ranked("g", 1, { type: "paid", etv: 50 }), ranked("h", 4, { etv: 2 })]);
    expect(mixed.map((r) => r.keyword)).toEqual(["h"]);
    expect(mixed[0].share).toBe(1);
  });

  it("filters views; All hides lost", () => {
    expect(filterView(rows, "all")).toHaveLength(4);
    expect(filterView(rows, "lost").map((r) => r.keyword)).toEqual(["d"]);
    expect(filterView(rows, "new").map((r) => r.keyword)).toEqual(["c"]);
  });
});

describe("pageRows and competitorRows", () => {
  it("computes path and traffic share", () => {
    const rows = pageRows([
      { page_address: "https://example.com/", metrics: { organic: metrics({ etv: 6 }) } },
      { page_address: "https://example.com/a?b=1", metrics: { organic: metrics({ etv: 2 }) } },
    ]);
    expect(rows.map((r) => [r.path, r.share])).toEqual([
      ["/", 0.75],
      ["/a?b=1", 0.25],
    ]);
  });

  it("shows no traffic value, not $0, for a page with traffic whose keywords have no CPC data", () => {
    const rows = pageRows([
      { page_address: "https://example.com/services/seo/", metrics: { organic: metrics({ etv: 28, estimated_paid_traffic_cost: 0 }) } },
      { page_address: "https://example.com/quiet", metrics: { organic: metrics({ etv: 0, estimated_paid_traffic_cost: 0 }) } },
      { page_address: "https://example.com/paid", metrics: { organic: metrics({ etv: 10, estimated_paid_traffic_cost: 42.5 }) } },
    ]);
    expect(rows.map((r) => r.trafficValue)).toEqual([null, 0, 42.5]);
  });

  it("drops the target and computes overlap from its own row", () => {
    const full = (count: number) => ({ organic: metrics({ count }) });
    const items = [
      { domain: "example.com", avg_position: 25.14, intersections: 7, full_domain_metrics: full(7), metrics: null, competitor_metrics: null },
      { domain: "rival.com", avg_position: 11.17, intersections: 6, full_domain_metrics: full(9000), metrics: null, competitor_metrics: null },
    ];
    const rows = competitorRows(items, "example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "rival.com", common: 6, avgPosition: 11.2, keywords: 9000 });
    expect(rows[0].overlap).toBeCloseTo(6 / 7);
    expect(competitorRows(items, "example.com", 12)[0].overlap).toBeCloseTo(0.5);
  });
});

describe("keyword gap", () => {
  it("assigns tabs from positions (index 0 is you)", () => {
    expect(gapTabs([3, 5, 8])).toEqual(["all", "shared", "strong"]);
    expect(gapTabs([9, 5, 8])).toEqual(["all", "shared", "weak"]);
    expect(gapTabs([6, 5, 8])).toEqual(["all", "shared"]);
    expect(gapTabs([null, 5, 8])).toEqual(["all", "untapped", "missing"]);
    expect(gapTabs([null, 5, null])).toEqual(["all", "untapped"]);
    expect(gapTabs([4, null, null])).toEqual(["all", "unique"]);
    expect(gapTabs([4, 2, null])).toEqual(["all", "weak"]);
    expect(gapTabs([4, null, 9])).toEqual(["all", "strong"]);
  });

  it("merges each domain's rankings, ignoring lost ones", () => {
    const gap = buildGap([
      [ranked("shared kw", 4, { volume: 500 }), ranked("only me", 10, { volume: 50 }), ranked("gone", 3, { lost: true })],
      [ranked("shared kw", 2, { volume: 500 }), ranked("their kw", 7, { volume: 900 })],
      null,
    ]);
    expect(gap.map((r) => [r.keyword, r.positions])).toEqual([
      ["their kw", [null, 7, null]],
      ["shared kw", [4, 2, null]],
      ["only me", [10, null, null]],
    ]);
    const counts = gapCounts(gap);
    expect(counts).toMatchObject({ all: 3, untapped: 1, missing: 0, weak: 1, unique: 1, shared: 0, strong: 0 });
  });

  it("ignores paid items and compares organic positions", () => {
    const gap = buildGap([
      [ranked("ad only", 1, { type: "paid" }), ranked("both", 2, { abs: 6 })],
      [ranked("both", 3, { abs: 4 })],
    ]);
    expect(gap.map((r) => [r.keyword, r.positions])).toEqual([["both", [2, 3]]]);
    expect(gap[0].tabs).toContain("strong");
  });
});

describe("isHostname", () => {
  it("accepts dotted hostnames up to 253 characters", () => {
    expect(isHostname("example.com")).toBe(true);
    expect(isHostname("shop.example.co.uk")).toBe(true);
    expect(isHostname("xn--bcher-kva.example")).toBe(true);
    expect(isHostname(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const d of ["", "localhost", "mac journal", "-bad.com", "bad-.com", "a..com", "exa_mple.com", `${"a".repeat(64)}.com`]) expect(isHostname(d)).toBe(false);
    expect(isHostname(`${"a.".repeat(127)}com`)).toBe(false);
  });
});

describe("sectionOf and sectionRows", () => {
  it("names a page by its first folder, the home page by /", () => {
    expect(sectionOf("https://example.com/")).toBe("/");
    expect(sectionOf("https://example.com/blog/a/b?c=1")).toBe("/blog/");
    expect(sectionOf("https://example.com/pricing")).toBe("/pricing/");
  });

  it("adds pages up by section, most traffic first, naming each section's biggest page", () => {
    const rows = sectionRows(
      pageRows([
        { page_address: "https://example.com/blog/a", metrics: { organic: metrics({ etv: 1, count: 2 }) } },
        { page_address: "https://example.com/blog/b", metrics: { organic: metrics({ etv: 5, count: 3 }) } },
        { page_address: "https://example.com/", metrics: { organic: metrics({ etv: 4, count: 7 }) } },
      ]),
    );
    expect(rows.map((r) => [r.section, r.pages, r.keywords, r.topPage])).toEqual([
      ["/blog/", 2, 5, "https://example.com/blog/b"],
      ["/", 1, 7, "https://example.com/"],
    ]);
    expect(rows[0].share).toBeCloseTo(0.6);
    expect(rows[0]).not.toHaveProperty("topTraffic");
  });
});
