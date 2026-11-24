import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RankingsTable, stopTrackingQuestion, type RankingRow } from "./rankings-table";

vi.mock("../actions", () => ({ removeKeywords: vi.fn(), tagKeywords: vi.fn() }));
// Upgrade now posts to a billing action that only loads on the server.
vi.mock("@/components/plan-upgrade", () => ({ UpgradeNow: () => null }));

const row: RankingRow = {
  id: 1,
  keyword: "seo",
  tags: [],
  device: "desktop",
  position: null,
  start: null,
  delta: null,
  change: "same" as RankingRow["change"],
  url: null,
  volume: null,
  traffic: 0,
  features: [],
  owned: [],
  aio: null,
  checked: false,
  notChecked: false,
  deeperCheckDate: null,
};

describe("position", () => {
  it("sets a keyword still waiting for its first check in sans, inside the mono column", () => {
    expect(renderToStaticMarkup(<RankingsTable rows={[row]} projectId={1} />)).toMatch(/font-sans[^>]*>pending</);
  });

  it("says a repeated position isn't confirmed, because the keyword was looked for", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[{ ...row, checked: true, position: 5, notChecked: true }]} projectId={1} />);
    expect(html).toContain("not confirmed");
    expect(html).not.toContain("not checked");
  });

  it("says not found when Search Console has a keyword no look found", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[{ ...row, checked: true, searchConsole: 3.64 }]} projectId={1} />);
    expect(html).toContain("not found");
    expect(html).toContain("around 3.6 across every location");
    expect(renderToStaticMarkup(<RankingsTable rows={[{ ...row, checked: true }]} projectId={1} />)).not.toContain("not found");
  });

  it("says why every checked keyword with no position has none", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[{ ...row, checked: true, depth: 20 }]} projectId={1} />);
    expect(html).toMatch(/>not in top 20</);
    expect(html).toContain("Not in the top 20 results on the latest check.");
    // Search Console's word replaces it, so the cell says one thing.
    expect(renderToStaticMarkup(<RankingsTable rows={[{ ...row, checked: true, depth: 20, searchConsole: 3.64 }]} projectId={1} />)).not.toContain("not in top 20");
  });
});

describe("volume", () => {
  it("says which place its search volumes are for", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[row]} projectId={1} volumePlace="Salem, New Hampshire" />);
    expect(html).toContain('title="Searches a month in Salem, New Hampshire"');
  });
});

describe("stopTrackingQuestion", () => {
  const rows = [
    { id: 1, keyword: "seo" },
    { id: 2, keyword: "rank tracker" },
  ];

  it("says its history for one keyword, and their history for more", () => {
    expect(stopTrackingQuestion(rows, new Set([1]))).toBe("Stop tracking 1 keyword (seo) and delete its history?");
    expect(stopTrackingQuestion(rows, new Set([1, 2]))).toBe("Stop tracking 2 keywords (seo, rank tracker) and delete their history?");
  });

  it("counts only the keywords still on the page", () => {
    expect(stopTrackingQuestion(rows, new Set([1, 99]))).toBe("Stop tracking 1 keyword (seo) and delete its history?");
  });
});

describe("a keyword with no result", () => {
  it("reads pending, and not checked once the newest check failed", () => {
    const pending = renderToStaticMarkup(<RankingsTable rows={[row]} projectId={1} />);
    expect(pending).toContain("pending");
    const failed = renderToStaticMarkup(<RankingsTable rows={[row]} projectId={1} checkFailed />);
    expect(failed).toContain("not checked");
    expect(failed).not.toContain("pending");
  });
});

describe("links", () => {
  const tagged = { ...row, id: 7, tags: ["brand name"] };

  it("keep the range and place the page shows", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[tagged]} projectId={1} linkParams={{ range: "90", place: "1023191" }} />);
    expect(html).toContain('href="/rank?range=90&amp;place=1023191&amp;tag=brand+name"');
    expect(html).toContain('href="/rank/7?range=90&amp;place=1023191"');
  });

  it("stay plain with nothing to keep", () => {
    const html = renderToStaticMarkup(<RankingsTable rows={[tagged]} projectId={1} />);
    expect(html).toContain('href="/rank?tag=brand+name"');
    expect(html).toContain('href="/rank/7"');
  });
});
