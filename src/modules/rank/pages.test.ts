import { describe, expect, it } from "vitest";
import { ctr } from "./metrics";
import { buildPages, cannibalPages, droppedPages, findCannibalization } from "./pages";
import type { RankKeyword, ResultRow } from "./queries";

const kw = (id: number, keyword: string, searchVolume: number | null): RankKeyword => ({
  id,
  workspaceId: 1,
  projectId: 1,
  keyword,
  tags: [],
  device: "desktop",
  active: true,
  searchVolume,
  cpc: null,
  difficulty: null,
  volumeUpdatedAt: null,
  createdAt: new Date(),
});

const row = (keywordId: number, date: string, position: number | null, url: string | null, own: [number, string][] = []): ResultRow => ({
  notChecked: false,
  depth: 100,
  aiOverviewLoaded: false,
  keywordId,
  date,
  position,
  url,
  serpFeatures: [],
  ownedFeatures: [],
  aiOverview: false,
  aiOverviewCited: false,
  ownUrls: own.map(([p, u]) => ({ p, u })),
});

const keywords = [kw(1, "mac shared notes", 1000), kw(2, "team notes mac", 500), kw(3, "mac journal", 200)];

describe("a deep position across the start of the window", () => {
  const rows = [row(1, "2026-10-25", 40, "https://a.com/x"), { ...row(1, "2026-10-28", null, null), depth: 20 }, { ...row(1, "2026-11-04", null, null), depth: 20 }];

  it("doesn't read the page as gaining a keyword or dropping out", () => {
    const keywords = [kw(1, "alpha", 100)];
    expect(buildPages(keywords, rows, "2026-10-28").map((p) => [p.url, p.keywords, p.keywordsDelta])).toEqual([["https://a.com/x", 1, 0]]);
    expect(droppedPages(keywords, rows, "2026-10-28")).toEqual([]);
  });
});

describe("buildPages", () => {
  it("groups the last check by URL and compares keyword counts with the first", () => {
    const pages = buildPages(keywords, [
      row(1, "2026-10-01", 5, "https://a.com/x"),
      row(2, "2026-10-01", 8, "https://a.com/x"),
      row(1, "2026-10-08", 3, "https://a.com/x"),
      row(2, "2026-10-08", 12, "https://a.com/y"),
      row(3, "2026-10-08", null, null),
    ]);
    expect(pages).toHaveLength(2);
    const x = pages.find((p) => p.url === "https://a.com/x")!;
    expect(x.keywords).toBe(1);
    expect(x.keywordsDelta).toBe(-1);
    expect(x.topKeyword).toBe("mac shared notes");
    expect(x.traffic).toBeCloseTo(Math.round(ctr(3) * 1000 * 10) / 10);
    const y = pages.find((p) => p.url === "https://a.com/y")!;
    expect(y.keywordsDelta).toBe(1);
    expect(pages[0].url).toBe("https://a.com/x");
  });
});

describe("droppedPages", () => {
  it("lists pages that ranked on the first check and for nothing on the last", () => {
    expect(
      droppedPages(keywords, [
        row(1, "2026-10-01", 5, "https://a.com/x"),
        row(2, "2026-10-01", 8, "https://a.com/gone"),
        row(3, "2026-10-01", 9, "https://a.com/gone"),
        row(1, "2026-10-08", 3, "https://a.com/x"),
        row(2, "2026-10-08", 12, "https://a.com/x"),
        row(3, "2026-10-08", null, null),
      ]),
    ).toEqual([{ url: "https://a.com/gone", keywords: 2 }]);
  });

  it("keeps a page that still ranks for something, and has nothing to say on one check", () => {
    expect(droppedPages(keywords, [row(1, "2026-10-01", 5, "https://a.com/x"), row(2, "2026-10-01", 8, "https://a.com/x"), row(1, "2026-10-08", 3, "https://a.com/x"), row(2, "2026-10-08", null, null)])).toEqual([]);
    expect(droppedPages(keywords, [row(1, "2026-10-01", 5, "https://a.com/x")])).toEqual([]);
  });
});

describe("findCannibalization", () => {
  it("flags URL swaps and same-SERP doubles, and ignores stable keywords", () => {
    const rows = [
      row(1, "2026-10-01", 4, "https://a.com/x", [[4, "https://a.com/x"]]),
      row(1, "2026-10-02", 6, "https://a.com/y", [[6, "https://a.com/y"]]),
      row(1, "2026-10-03", 5, "https://a.com/x", [[5, "https://a.com/x"]]),
      row(2, "2026-10-01", 9, "https://a.com/z", [
        [9, "https://a.com/z"],
        [14, "https://a.com/x"],
      ]),
      row(3, "2026-10-01", 2, "https://a.com/s", [[2, "https://a.com/s"]]),
      row(3, "2026-10-02", 2, "https://a.com/s", [[2, "https://a.com/s"]]),
    ];
    const c = findCannibalization(keywords, rows);
    expect(c.map((r) => r.keyword)).toEqual(["mac shared notes", "team notes mac"]);
    expect(c[0]).toMatchObject({ flips: 2, multiDays: 0, bestPosition: 4, latestUrl: "https://a.com/x", checks: 3 });
    expect(c[0].urls).toEqual(["https://a.com/x", "https://a.com/y"]);
    expect(c[1]).toMatchObject({ flips: 0, multiDays: 1, bestPosition: 9 });

    const pages = cannibalPages(c);
    expect(pages[0]).toEqual({ url: "https://a.com/x", keywords: 2, volume: 1500 });
  });

  it("does not count a drop out of the results as a swap", () => {
    const c = findCannibalization(keywords, [
      row(1, "2026-10-01", 4, "https://a.com/x", [[4, "https://a.com/x"]]),
      row(1, "2026-10-02", null, null),
      row(1, "2026-10-03", 4, "https://a.com/x", [[4, "https://a.com/x"]]),
    ]);
    expect(c).toEqual([]);
  });
});
