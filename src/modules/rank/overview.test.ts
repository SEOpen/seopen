import { describe, expect, it } from "vitest";
import { rankSentence } from "./brief";
import { buildCompetitorView } from "./competitors";
import { ctr, CTR_TOP20_TOTAL } from "./metrics";
import { briefingKind, buildOverview, parseFilters, summaryDelta } from "./overview";
import type { DomainRow, RankKeyword, ResultRow } from "./queries";

const kw = (id: number, keyword: string, tags: string[], searchVolume: number | null, active = true): RankKeyword => ({
  id,
  workspaceId: 1,
  projectId: 1,
  keyword,
  tags,
  device: "desktop",
  active,
  searchVolume,
  cpc: null,
  difficulty: null,
  volumeUpdatedAt: null,
  createdAt: new Date(),
});

const res = (keywordId: number, date: string, position: number | null, extra: Partial<ResultRow> = {}): ResultRow => ({
  notChecked: false,
  depth: 100,
  aiOverviewLoaded: false,
  keywordId,
  date,
  position,
  url: position ? `https://ours.com/${keywordId}` : null,
  serpFeatures: [],
  ownedFeatures: [],
  aiOverview: false,
  aiOverviewCited: false,
  ownUrls: [],
  ...extra,
});

const keywords = [
  kw(1, "alpha", ["core"], 1000),
  kw(2, "beta", ["core", "brand"], 100),
  kw(3, "gamma", [], null),
  kw(4, "paused", [], 5000, false),
];

const results = [
  res(1, "2026-10-01", 8),
  res(2, "2026-10-01", 2),
  res(3, "2026-10-01", null),
  res(4, "2026-10-01", 1),
  res(1, "2026-10-08", 3, { serpFeatures: ["ai_overview", "images"], ownedFeatures: ["ai_overview"], aiOverview: true, aiOverviewCited: true, aiOverviewLoaded: true }),
  res(2, "2026-10-08", null, { serpFeatures: ["ai_overview"], aiOverview: true, aiOverviewLoaded: true }),
  res(3, "2026-10-08", 15),
];

describe("buildOverview", () => {
  const o = buildOverview(keywords, results, {});

  it("notes Search Console only beside a keyword no look found, within the check's depth", () => {
    const rows = [res(1, "2026-11-04", null, { depth: 20 }), res(2, "2026-11-04", null, { depth: 20 }), res(3, "2026-11-04", 5, { depth: 20 })];
    const list = [kw(1, "Alpha", [], 10), kw(2, "beta", [], 10), kw(3, "gamma", [], 10)];
    const { rows: out } = buildOverview(list, rows, {}, new Map([["alpha", 3.6], ["beta", 35], ["gamma", 2]]));
    expect(out.map((r) => r.searchConsole)).toEqual([3.6, null, null]);
  });

  it("skips paused keywords and classifies moves", () => {
    expect(o.rows.map((r) => [r.keyword, r.change, r.delta])).toEqual([
      ["alpha", "improved", 5],
      ["beta", "lost", null],
      ["gamma", "new", null],
    ]);
    expect(o.improved).toBe(2);
    expect(o.declined).toBe(1);
  });

  it("summarises each date and the change between them", () => {
    expect(o.series.map((s) => s.date)).toEqual(["2026-10-01", "2026-10-08"]);
    expect(o.end!.visibility).toBeCloseTo((ctr(3) + ctr(15)) / (3 * ctr(1)));
    expect(o.ai).toEqual({ date: "2026-10-08", cited: 1, present: 2 });
    expect(o.end!.traffic).toBeCloseTo(ctr(3) * 1000);
    expect(summaryDelta(o, "top10")).toBe(-1);
    expect(summaryDelta(o, "top20")).toBe(0);
  });

  it("filters rows and the summaries with them", () => {
    const core = buildOverview(keywords, results, { tag: "core" });
    expect(core.rows.map((r) => r.keyword)).toEqual(["alpha", "beta"]);
    expect(core.end!.keywords).toBe(2);
    expect(buildOverview(keywords, results, { bucket: "1-3" }).rows.map((r) => r.keyword)).toEqual(["alpha"]);
    expect(buildOverview(keywords, results, { change: "moved" }).rows).toHaveLength(3);
    expect(buildOverview(keywords, results, { aio: "cited" }).rows.map((r) => r.keyword)).toEqual(["alpha"]);
    expect(buildOverview(keywords, results, { aio: "absent" }).rows.map((r) => r.keyword)).toEqual(["gamma"]);
    expect(buildOverview(keywords, results, { feature: "images" }).rows.map((r) => r.keyword)).toEqual(["alpha"]);
    expect(buildOverview(keywords, results, { feature: "owned-any" }).rows.map((r) => r.keyword)).toEqual(["alpha"]);
  });

  it("reads AI Overviews only from checks that loaded their sources", () => {
    const rows = [
      res(1, "2026-10-05", 3, { aiOverview: true, aiOverviewCited: true, aiOverviewLoaded: true, depth: 100 }),
      res(1, "2026-10-06", 3, { depth: 20 }),
      res(2, "2026-10-05", 4, { aiOverview: true, aiOverviewLoaded: true, depth: 100 }),
      res(2, "2026-10-06", 4, { aiOverview: true, depth: 20 }),
    ];
    const v = buildOverview(keywords, rows, {});
    expect(v.ai).toEqual({ date: "2026-10-05", cited: 1, present: 2 });
    expect(v.rows.map((r) => [r.keyword, r.aio])).toEqual([
      ["alpha", "cited"],
      ["beta", "present"],
      ["gamma", null],
    ]);
    expect(buildOverview(keywords, rows.filter((r) => r.date === "2026-10-06"), {}).ai).toBeNull();
    expect(buildOverview(keywords, rows.filter((r) => r.date === "2026-10-06"), {}).rows[0].aio).toBeNull();
  });

  it("calls a keyword no check found \"none\", however many checks there were", () => {
    const one = buildOverview(keywords, [res(1, "2026-10-08", null), res(2, "2026-10-08", 5)], {});
    expect(one.rows.find((r) => r.id === 1)?.change).toBe("none");
    expect(one.rows.find((r) => r.id === 2)?.change).toBe("unchanged");
    const two = buildOverview(keywords, [res(1, "2026-10-01", null), res(1, "2026-10-08", null)], {});
    expect(two.rows.find((r) => r.id === 1)?.change).toBe("none");
    expect(buildOverview(keywords, [res(1, "2026-10-08", null)], { change: "none" }).rows.map((r) => r.id)).toContain(1);
  });

  it("dates the check an AI Overview reading comes from", () => {
    const o = buildOverview(keywords, [res(1, "2026-10-05", 4, { aiOverview: true, aiOverviewLoaded: true }), res(1, "2026-10-06", 4)], {});
    expect(o.rows.find((r) => r.id === 1)).toMatchObject({ aio: "present", aioDate: "2026-10-05", features: [] });
    expect(o.rows.find((r) => r.id === 2)).toMatchObject({ aio: null, aioDate: null });
  });

  it("shows no move on a position no look could confirm, and keeps counting it", () => {
    const rows = [res(1, "2026-10-01", 14), res(1, "2026-10-08", 9, { notChecked: true }), res(2, "2026-10-01", null), res(2, "2026-10-08", 6, { notChecked: true }), res(3, "2026-10-01", 4), res(3, "2026-10-08", 3)];
    const o = buildOverview(keywords, rows, {});
    expect(o.rows.find((r) => r.id === 1)).toMatchObject({ position: 9, start: 14, delta: null, change: "unchanged", notChecked: true });
    expect(o.rows.find((r) => r.id === 2)).toMatchObject({ position: 6, delta: null, change: "unchanged", notChecked: true });
    expect(o.rows.find((r) => r.id === 3)).toMatchObject({ delta: 1, change: "improved", notChecked: false, depth: 100 });
    expect(o.end).toMatchObject({ top10: 3, top10NotConfirmed: 2 });
    expect(o.start).toMatchObject({ top10NotConfirmed: 0, visibilityNotConfirmed: 0, trafficNotConfirmed: 0 });
    expect(o.improved).toBe(1);
  });

  it("doesn't call a position beyond a check's depth lost", () => {
    const rows = [res(1, "2026-10-05", 50, { depth: 100 }), res(1, "2026-10-06", null, { depth: 20 })];
    const v = buildOverview(keywords, rows, {});
    const alpha = v.rows[0];
    expect([alpha.position, alpha.change, alpha.delta, alpha.deeperCheckDate]).toEqual([50, "unchanged", 0, "2026-10-05"]);
    expect(alpha.url).toBe("https://ours.com/1");
    expect(v.declined).toBe(0);
    expect(v.end!.top100).toBe(1);
    expect(v.end!.avgPosition).toBe(50);
  });

  it("doesn't call a steady deep position new when the window opens on a shallow check", () => {
    // A week from Wednesday to Wednesday: the sweep that saw it the Sunday before is outside the window.
    const rows = [res(1, "2026-10-25", 40, { depth: 100 }), res(1, "2026-10-28", null, { depth: 20 }), res(1, "2026-11-01", 40, { depth: 100 }), res(1, "2026-11-04", null, { depth: 20 })];
    const v = buildOverview(keywords, rows, {}, undefined, "2026-10-28");
    const alpha = v.rows[0];
    expect([alpha.position, alpha.start, alpha.change, alpha.deeperCheckDate]).toEqual([40, 40, "unchanged", "2026-11-01"]);
    expect(v.improved).toBe(0);
    expect([v.start!.date, v.start!.top100, v.start!.avgPosition, v.end!.top100, v.end!.avgPosition]).toEqual(["2026-10-28", 1, 40, 1, 40]);
    expect(rankSentence(v)).toBe("Nothing moved since Oct 28.");
  });

  it("still calls a deep position new when no earlier check saw it", () => {
    const rows = [res(1, "2026-10-28", null, { depth: 20 }), res(1, "2026-11-01", 40, { depth: 100 }), res(1, "2026-11-04", null, { depth: 20 })];
    expect(buildOverview(keywords, rows, {}, undefined, "2026-10-28").rows[0].change).toBe("new");
  });

  it("still calls a miss lost when the check looked deep enough", () => {
    const rows = [res(1, "2026-10-05", 8, { depth: 20 }), res(1, "2026-10-06", null, { depth: 20 })];
    const alpha = buildOverview(keywords, rows, {}).rows[0];
    expect([alpha.position, alpha.change, alpha.deeperCheckDate]).toEqual([null, "lost", null]);
  });

  it("reads filters from search params", () => {
    expect(parseFilters({ bucket: "4-10", tag: ["core", "x"], aio: "" })).toEqual({
      bucket: "4-10",
      change: undefined,
      tag: "core",
      feature: undefined,
      aio: undefined,
      url: undefined,
    });
  });
});

describe("briefingKind", () => {
  const all = buildOverview(keywords, results, {});

  it("reports results when the filter leaves some", () => {
    expect(briefingKind(buildOverview(keywords, results, { tag: "core" }), all)).toBe("results");
    expect(briefingKind(all, all)).toBe("results");
  });

  it("doesn't call a filter that matches nothing a missing first check", () => {
    const filtered = buildOverview(keywords, results, { change: "unchanged" });
    expect(filtered.end).toBeNull();
    expect(briefingKind(filtered, all)).toBe("no-match");
  });

  it("tells keywords waiting for their first check from a filter that matches nothing", () => {
    const withNew = [...keywords, kw(5, "fresh", ["fresh"], 10)];
    expect(briefingKind(buildOverview(withNew, results, { tag: "fresh" }), buildOverview(withNew, results, {}))).toBe("not-checked");
  });

  it("is waiting for the first check, filtered or not, when nothing has been checked", () => {
    const none = buildOverview(keywords, [], {});
    expect(briefingKind(none, none)).toBe("no-checks");
    expect(briefingKind(buildOverview(keywords, [], { change: "lost" }), none)).toBe("no-checks");
  });
});

describe("buildCompetitorView", () => {
  const rows: DomainRow[] = [
    { keywordId: 1, date: "2026-10-08", position: 3, notChecked: false, depth: 20, domains: { "ours.com": { p: 3, u: "u" }, "rival.com": { p: 1, u: "r" }, "other.net": { p: 2, u: "o" } } },
    { keywordId: 2, date: "2026-10-08", position: null, notChecked: false, depth: 20, domains: { "blog.rival.com": { p: 4, u: "r2" }, "other.net": { p: 1, u: "o2" } } },
  ];
  const v = buildCompetitorView("ours.com", ["rival.com"], keywords, rows);

  it("scores the project and competitors on the same SERPs, counting subdomains", () => {
    const rival = v.end.get("rival.com")!;
    expect(rival.top3).toBe(1);
    expect(rival.avgPosition).toBe(2.5);
    expect(rival.shareOfVoice).toBeCloseTo((1000 * ctr(1) + 100 * ctr(4)) / (1100 * CTR_TOP20_TOTAL));
    expect(v.end.get("ours.com")!.avgPosition).toBe(3);
    expect(v.seriesSov[0]["ours.com"]).toBeCloseTo((1000 * ctr(3)) / (1100 * CTR_TOP20_TOTAL));
  });

  it("carries through how much of your visibility no look confirmed, and it adds up to your row", () => {
    const [carried, found] = rows;
    const unconfirmed = buildCompetitorView("ours.com", ["rival.com"], keywords, [{ ...carried, notChecked: true }, found]);
    const ours = unconfirmed.end.get("ours.com")!;
    expect(ours.visibilityNotConfirmed).toBeCloseTo(ctr(3) / (2 * ctr(1)));
    expect(ours.visibilityNotConfirmed).toBeCloseTo(ours.visibility!);
    expect(v.end.get("ours.com")!.visibilityNotConfirmed).toBe(0);
  });

  it("counts the newest check's keywords no look confirmed, for the chart's caption", () => {
    const [carried, found] = rows;
    expect(buildCompetitorView("ours.com", ["rival.com"], keywords, [{ ...carried, notChecked: true }, found]).endNotConfirmed).toBe(1);
    expect(v.endNotConfirmed).toBe(0);
  });

  it("carries a rival's sweep position through the shallower checks after it, as Rankings carries yours", () => {
    const sweep: DomainRow = { keywordId: 1, date: "2026-10-04", position: 45, notChecked: false, depth: 100, domains: { "ours.com": { p: 45, u: "u" }, "rival.com": { p: 50, u: "r" } } };
    const daily: DomainRow = { keywordId: 1, date: "2026-10-05", position: null, notChecked: false, depth: 20, domains: { "other.net": { p: 1, u: "o" } } };
    const carried = buildCompetitorView("ours.com", ["rival.com"], keywords, [sweep, daily], "2026-10-05");
    expect(carried.series.map((r) => r.date)).toEqual(["2026-10-05"]);
    expect(carried.end.get("rival.com")!.avgPosition).toBe(50);
    expect(carried.end.get("ours.com")!.avgPosition).toBe(45);
    // A check deep enough to have seen it is a real miss.
    const missed = buildCompetitorView("ours.com", ["rival.com"], keywords, [sweep, { ...daily, depth: 100 }], "2026-10-05");
    expect(missed.end.get("rival.com")!.avgPosition).toBeNull();
  });

  it("discovers untracked domains", () => {
    expect(v.discovered.map((d) => d.domain)).toEqual(["other.net"]);
    expect(v.discovered[0]).toMatchObject({ keywords: 2, avgPosition: 1.5 });
  });
});
