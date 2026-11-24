import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/projects";
import { dashboard as ga4 } from "./ga4-dashboard";
import { dashboard as gsc } from "./dashboard";
import { addDays } from "./windowing";

vi.mock("server-only", () => ({}));
vi.mock("./data", () => ({
  gscDataRange: vi.fn(),
  gscSeries: vi.fn(),
  gscTotals: vi.fn(),
  ga4DataRange: vi.fn(),
  ga4Series: vi.fn(),
  ga4Totals: vi.fn(),
  analyticsCheckedThrough: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ projectScope: () => ({}) }));

const data = await import("./data");
const mocks = data as unknown as Record<"gscDataRange" | "gscSeries" | "gscTotals" | "ga4DataRange" | "ga4Series" | "ga4Totals" | "analyticsCheckedThrough", ReturnType<typeof vi.fn>>;

const LAST = "2026-10-30";
const project = { gscProperty: "sc-domain:example.com", ga4Property: "1", posthogProject: null } as unknown as Project;
/** Stored history that started `n` days ago, counting the last day. */
const stored = (n: number) => ({ first: addDays(LAST, -(n - 1)), last: LAST });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gscTotals.mockResolvedValue({ clicks: 10, impressions: 100, ctr: 0.1, position: 5 });
  mocks.ga4Totals.mockResolvedValue({ sessions: 10, engagedSessions: 5, keyEvents: 0, totalRevenue: 0 });
  mocks.gscSeries.mockResolvedValue([]);
  mocks.ga4Series.mockResolvedValue([]);
  mocks.analyticsCheckedThrough.mockResolvedValue(LAST);
});

describe("Analytics' card once data stopped arriving", () => {
  it("marks the window stopped when the sync asked weeks past the newest day, and says no change as news", async () => {
    mocks.ga4DataRange.mockResolvedValue(stored(400));
    mocks.analyticsCheckedThrough.mockResolvedValue(addDays(LAST, 36));
    const d = (await ga4.load(project))!;
    expect(d.stopped).toBe(true);
    expect(ga4.changes!(d)).toEqual([]);
    expect(mocks.analyticsCheckedThrough).toHaveBeenCalledWith({}, "ga4");
  });

  it("isn't stopped a few quiet days in, or before the first sync", async () => {
    mocks.ga4DataRange.mockResolvedValue(stored(400));
    mocks.analyticsCheckedThrough.mockResolvedValue(addDays(LAST, 5));
    expect((await ga4.load(project))!.stopped).toBeUndefined();
    mocks.analyticsCheckedThrough.mockResolvedValue(null);
    expect((await ga4.load(project))!.stopped).toBeUndefined();
  });
});

const modules = [
  { name: "Search Console", module: gsc, range: "gscDataRange", totals: "gscTotals", unconnected: { ...project, gscProperty: null }, described: async () => gsc.describe((await gsc.load(project))!) },
  { name: "Analytics", module: ga4, range: "ga4DataRange", totals: "ga4Totals", unconnected: { ...project, ga4Property: null }, described: async () => ga4.describe((await ga4.load(project))!) },
] as const;

describe.each(modules)("$name's load", ({ module, range, totals, unconnected, described }) => {
  it("has nothing when it isn't connected, or nothing is stored", async () => {
    expect(await module.load(unconnected as unknown as Project)).toBeNull();
    mocks[range].mockResolvedValue(null);
    expect(await module.load(project)).toBeNull();
  });

  it("has nothing earlier with one stored day", async () => {
    mocks[range].mockResolvedValue(stored(1));
    const d = await module.load(project);
    expect(d?.previous).toBeNull();
    expect(d?.series.map((p) => p.date)).toEqual([LAST]);
    expect(mocks[totals]).toHaveBeenCalledTimes(1);
  });

  it.each([29, 30, 55])("doesn't compare against an earlier period only partly stored: %i days", async (days) => {
    mocks[range].mockResolvedValue(stored(days));
    const d = await module.load(project);
    expect(d?.previous).toBeNull();
    expect(mocks[totals]).toHaveBeenCalledTimes(1);
  });

  it("compares once the whole earlier period is stored", async () => {
    mocks[range].mockResolvedValue(stored(56));
    const d = await module.load(project);
    expect(d?.previous).not.toBeNull();
    expect(mocks[totals]).toHaveBeenCalledTimes(2);
    expect(mocks[totals].mock.calls[1][1]).toEqual({ start: stored(56).first, end: addDays(LAST, -28) });
  });

  it("describes the days stored, not always 28", async () => {
    mocks[range].mockResolvedValue(stored(5));
    expect(await described()).toBe("5 days to Oct 30, 2026");
    mocks[range].mockResolvedValue(stored(1));
    expect(await described()).toBe("1 day to Oct 30, 2026");
    mocks[range].mockResolvedValue(stored(40));
    expect(await described()).toBe("28 days to Oct 30, 2026");
  });
});

describe("Search Console's daily series", () => {
  it("has every stored day of the window, so it starts where history does on a quiet site", async () => {
    mocks.gscDataRange.mockResolvedValue(stored(5));
    mocks.gscSeries.mockResolvedValue([{ date: LAST, clicks: 3, impressions: 40, ctr: 0.075, position: 8 }]);
    const d = await gsc.load(project);
    expect(d?.series).toHaveLength(5);
    expect(d?.series[0]).toEqual({ date: stored(5).first, clicks: 0, position: null });
    expect(d?.series[4]).toEqual({ date: LAST, clicks: 3, position: 8 });
  });

  it("stays inside the window on a long history", async () => {
    mocks.gscDataRange.mockResolvedValue(stored(400));
    const d = await gsc.load(project);
    expect(d?.series).toHaveLength(28);
    expect(d?.series[0].date).toBe(addDays(LAST, -27));
  });

  it("has no position on a stored day with no impressions", async () => {
    mocks.gscDataRange.mockResolvedValue(stored(1));
    mocks.gscSeries.mockResolvedValue([{ date: LAST, clicks: 0, impressions: 0, ctr: 0, position: 0 }]);
    expect((await gsc.load(project))?.series[0].position).toBeNull();
  });
});
