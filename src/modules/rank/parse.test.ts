import { describe, expect, it } from "vitest";
import owned from "./fixtures/serp-owned.json";
import live from "./fixtures/serp-live-sample.json";
import { bareHost, makeTag, matchesDomain, parseKeywordList, parseSerp, parseTag, parseTags } from "./parse";
import type { SerpAdvancedResult } from "./types";

describe("parseSerp on a SERP we rank on", () => {
  const r = parseSerp(owned as SerpAdvancedResult, "alphanote.example");

  it("takes our best organic position and URL", () => {
    expect(r.position).toBe(2);
    expect(r.rankAbsolute).toBe(4);
    expect(r.url).toBe("https://www.alphanote.example/journals");
  });

  it("lists every URL of ours, subdomains included, but not lookalike domains", () => {
    expect(r.ownUrls).toEqual([
      { p: 2, u: "https://www.alphanote.example/journals" },
      { p: 4, u: "https://blog.alphanote.example/best-journals" },
    ]);
  });

  it("records features present and the ones we own", () => {
    expect(r.serpFeatures).toEqual(["ai_overview", "featured_snippet", "people_also_ask"]);
    expect(r.ownedFeatures).toEqual(["ai_overview", "featured_snippet"]);
    expect(r.aiOverview).toBe(true);
    expect(r.aiOverviewCited).toBe(true);
  });

  it("keeps each domain's best organic hit, without www", () => {
    expect(r.domains["reddit.com"]).toEqual({ p: 3, u: "https://www.reddit.com/r/MacOS/1" });
    expect(r.domains["alphanote.example"].p).toBe(2);
    expect(r.domains["blog.alphanote.example"].p).toBe(4);
    expect(r.domains["notalphanote.example"].p).toBe(6);
  });

  it("keeps a compact snapshot and metadata", () => {
    expect(r.top).toHaveLength(9);
    expect(r.top[0]).toMatchObject({ type: "featured_snippet", pos: 1, domain: "alphanote.example" });
    expect(r.top[2]).toMatchObject({ type: "organic", pos: 1, abs: 3, domain: "plainpadnotes.github.io" });
    expect(r.seResultsCount).toBe(48200);
    expect(r.checkedAt.toISOString()).toBe("2026-10-29T06:12:03.000Z");
  });
});

describe("parseSerp past the top 20", () => {
  // Made up: 60 organic results on .example domains, under two features.
  const organic = Array.from({ length: 60 }, (_, i) => {
    const domain = i + 1 === 40 ? "ours.example" : `rival-${i + 1}.example`;
    return { type: "organic", rank_group: i + 1, rank_absolute: i + 3, domain, url: `https://${domain}/` };
  });
  const features = [
    { type: "ai_overview", rank_group: 1, rank_absolute: 1 },
    { type: "people_also_ask", rank_group: 1, rank_absolute: 2 },
  ];
  const r = parseSerp({ items: [...features, ...organic] } as SerpAdvancedResult, "ours.example");

  it("finds a #40, by organic position and not by place on the page", () => {
    expect([r.position, r.rankAbsolute, r.url]).toEqual([40, 42, "https://ours.example/"]);
    expect(r.domains["rival-60.example"].p).toBe(60);
  });

  it("keeps only the first 20 items for the snapshot, which isn't where the position comes from", () => {
    expect(r.top).toHaveLength(20);
    expect(r.top.some((t) => t.domain === "ours.example")).toBe(false);
  });
});

describe("parseSerp on the live sample (we don't rank)", () => {
  const result = live.tasks[0].result[0] as unknown as SerpAdvancedResult;
  const r = parseSerp(result, "alphanote.example");

  it("reports not ranking and an uncited AI Overview", () => {
    expect(r.position).toBeNull();
    expect(r.url).toBeNull();
    expect(r.ownUrls).toEqual([]);
    expect(r.aiOverview).toBe(true);
    expect(r.aiOverviewCited).toBe(false);
    expect(r.ownedFeatures).toEqual([]);
  });

  it("still records competitors from the same SERP", () => {
    expect(r.domains["reddit.com"].p).toBe(1);
    expect(r.domains["youtube.com"].p).toBe(2);
  });

  it("detects a citation for a domain the AI Overview references", () => {
    expect(parseSerp(result, "github.com").aiOverviewCited).toBe(true);
    expect(parseSerp(result, "support.apple.com").aiOverviewCited).toBe(true);
  });
});

describe("parseSerp edge cases", () => {
  it("handles a SERP with no items", () => {
    const r = parseSerp({ keyword: "x", datetime: "2026-10-29 00:00:00 +00:00", item_types: null, items: null }, "alphanote.example");
    expect(r.position).toBeNull();
    expect(r.top).toEqual([]);
    expect(r.domains).toEqual({});
  });
});

describe("helpers", () => {
  it("normalises hosts and matches subdomains", () => {
    expect(bareHost("WWW.Alphanote.example.")).toBe("alphanote.example");
    expect(matchesDomain("blog.alphanote.example", "alphanote.example")).toBe(true);
    expect(matchesDomain("notalphanote.example", "alphanote.example")).toBe(false);
    expect(matchesDomain(null, "alphanote.example")).toBe(false);
  });

  it("round-trips task tags and rejects foreign ones", () => {
    expect(parseTag(makeTag(12, 345))).toEqual({ runId: 12, keywordId: 345 });
    expect(parseTag("seopen:ai:r1:k2")).toBeNull();
    expect(parseTag(null)).toBeNull();
  });

  it("splits pasted keyword lists and tags", () => {
    expect(parseKeywordList("Mac Journal\n  mac  journal , daily notes\n\n")).toEqual([
      "mac journal",
      "daily notes",
    ]);
    expect(parseTags("Brand, product ,brand")).toEqual(["brand", "product"]);
  });
});

describe("parseSerp on google.com/goto results", () => {
  // DataForSEO started wrapping organic results this way in November 2026; breadcrumb keeps the real site.
  const result = {
    keyword: "salem web design",
    datetime: "2026-11-03 20:00:00 +00:00",
    item_types: ["organic"],
    se_results_count: 100,
    items: [
      { type: "organic", rank_group: 1, rank_absolute: 1, domain: "www.pinegatestudio.example", url: "https://www.pinegatestudio.example/" },
      { type: "organic", rank_group: 2, rank_absolute: 2, domain: "google.com", url: "https://google.com/goto?url=CAESew", breadcrumb: "https://www.linkedin.com › services" },
      { type: "organic", rank_group: 3, rank_absolute: 3, domain: "google.com", url: "https://google.com/goto?url=CAESXQ", breadcrumb: "https://betaweb.example › location › web-design-salem" },
    ],
  } as SerpAdvancedResult;
  const r = parseSerp(result, "betaweb.example");

  it("finds our own wrapped result and credits the real sites, not google.com", () => {
    expect(r.position).toBe(3);
    expect(r.url).toBe("https://betaweb.example/");
    expect(Object.keys(r.domains).sort()).toEqual(["betaweb.example", "linkedin.com", "pinegatestudio.example"]);
    expect(r.top.map((t) => t.domain)).toEqual(["pinegatestudio.example", "linkedin.com", "betaweb.example"]);
  });
});
