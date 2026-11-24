import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/projects";
import type { RankKeyword, ResultRow } from "@/modules/rank/queries";
import { keywordMove, loadPanelKeywords } from "./dashboard-panel";

// The panel's loaders import server-only code. The tracked keywords and their rows are stood in for here.
vi.mock("server-only", () => ({}));

const tracked = { keywords: [] as Pick<RankKeyword, "id" | "keyword" | "active">[], dates: [] as string[], rows: [] as ResultRow[] };

vi.mock("@/modules/rank/queries", async (original) => ({
  ...(await original<typeof import("@/modules/rank/queries")>()),
  loadTracker: async () => ({ keywords: tracked.keywords, dates: tracked.dates, place: { code: 2840, includesUnstamped: true } }),
  loadResultsToCarry: async () => tracked.rows,
}));

const check = (date: string, position: number | null, notChecked = false) => ({ date, position, notChecked });

describe("loadPanelKeywords", () => {
  const row = (date: string, position: number | null, depth: number): ResultRow => ({
    keywordId: 1,
    date,
    position,
    depth,
    url: position == null ? null : "https://site.example/page",
    serpFeatures: [],
    ownedFeatures: [],
    aiOverview: false,
    aiOverviewCited: false,
    ownUrls: [],
    notChecked: false,
    aiOverviewLoaded: false,
  });
  const panel = async (rows: ResultRow[]) => {
    tracked.keywords = [{ id: 1, keyword: "deep keyword", active: true }];
    tracked.rows = rows;
    tracked.dates = [...new Set(rows.map((r) => r.date))].sort().reverse();
    const out = await loadPanelKeywords({ id: 1, workspaceId: 1, gscProperty: null } as Project);
    return out!.rows[0];
  };

  it("doesn't call a position beyond the last check's depth lost or not found", async () => {
    const r = await panel([row("2026-11-01", 50, 100), row("2026-11-02", null, 20)]);
    expect([r.position, r.status, r.delta, r.url]).toEqual([50, null, null, "/page"]);
  });

  it("doesn't call it new when the sweep that first saw it is before the window", async () => {
    const r = await panel([row("2026-10-25", 50, 100), row("2026-10-28", null, 20), row("2026-11-01", 50, 100), row("2026-11-04", null, 20)]);
    expect([r.position, r.previous, r.delta]).toEqual([50, 50, null]);
  });

  it("still calls a miss lost when the check looked deep enough", async () => {
    const r = await panel([row("2026-11-01", 8, 20), row("2026-11-02", null, 20)]);
    expect([r.position, r.status, r.delta?.text]).toEqual([null, "Not found", "lost"]);
  });

  it("marks a last known position that no look confirmed, as Rankings does", async () => {
    const r = await panel([row("2026-11-01", 1, 20), { ...row("2026-11-02", 1, 20), notChecked: true }]);
    expect([r.position, r.notConfirmed, r.delta]).toEqual([1, true, null]);
    expect((await panel([row("2026-11-01", 1, 20), row("2026-11-02", 1, 20)])).notConfirmed).toBe(false);
  });
});

describe("keywordMove", () => {
  it("has no change for a keyword with no checks", () => {
    expect(keywordMove(undefined)).toEqual({ previous: null, delta: null });
  });

  it("has no change with one check, ranking or not: nothing earlier to compare", () => {
    const ranked = check("2026-10-27", 12);
    expect(keywordMove({ first: ranked, last: ranked })).toEqual({ previous: null, delta: null });
    const missed = check("2026-10-27", null);
    expect(keywordMove({ first: missed, last: missed })).toEqual({ previous: null, delta: null });
  });

  it("shows a real move between two checks, better or worse", () => {
    expect(keywordMove({ first: check("2026-10-20", 12), last: check("2026-10-27", 9) })).toEqual({ previous: 12, delta: { text: "3", tone: "good", up: true } });
    expect(keywordMove({ first: check("2026-10-20", 9), last: check("2026-10-27", 12) })).toEqual({ previous: 9, delta: { text: "3", tone: "bad", up: false } });
  });

  it("shows no change, not a 0, when two checks held still, as Rankings draws it", () => {
    expect(keywordMove({ first: check("2026-10-20", 12), last: check("2026-10-27", 12) })).toEqual({ previous: 12, delta: null });
  });

  it("says new and lost only across two checks", () => {
    expect(keywordMove({ first: check("2026-10-20", null), last: check("2026-10-27", 12) }).delta?.text).toBe("new");
    expect(keywordMove({ first: check("2026-10-20", 12), last: check("2026-10-27", null) }).delta?.text).toBe("lost");
  });

  it("has no change when two checks both missed", () => {
    expect(keywordMove({ first: check("2026-10-20", null), last: check("2026-10-27", null) })).toEqual({ previous: null, delta: null });
  });

  it("has no change when the last check couldn't be confirmed", () => {
    expect(keywordMove({ first: check("2026-10-20", 12), last: check("2026-10-27", 9, true) })).toEqual({ previous: 12, delta: null });
  });
});
