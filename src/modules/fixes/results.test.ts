import { describe, expect, it } from "vitest";
import type { FixResult } from "@/db/schema/fixes";
import { latestResult, measuringLine, readResult, resultLines, resultSentence, VISITS_MEANING, visitsSentence } from "./results";

const m = (clicks: number, impressions = clicks * 20) => ({ clicks, impressions, position: null });
const siteFlat = { before: m(1000), after: m(1030) };
const result = (days: number, before: number, after: number, site = siteFlat): FixResult => ({
  days,
  before: { from: "2026-10-01", to: "2026-10-14", ...m(before) },
  after: { from: "2026-10-15", to: "2026-10-28", ...m(after) },
  site,
  computedAt: "2026-11-01T00:00:00Z",
});

describe("measuringLine", () => {
  const at = new Date("2026-11-06T18:00:00Z");
  it("says when a live fix's results come, counted from the day it went live", () => {
    expect(measuringLine({ status: "live", liveAt: at, appliedAt: at, liveCheck: null })).toBe("Measured from Nov 6, the day it was seen live. The 7-day result shows once Search Console has data to Nov 13, and the 28-day one once it has Dec 4.");
  });

  it("counts from the day it was marked changed when SEOpen couldn't see the change", () => {
    expect(measuringLine({ status: "applied", liveAt: null, appliedAt: at, liveCheck: { state: "cannot_check" } })).toBe("Measured from Nov 6, the day it was marked changed, because SEOpen can't see this change on the page. The 7-day result shows once Search Console has data to Nov 13, and the 28-day one once it has Dec 4.");
  });

  it("waits for the change to reach the page, and says nothing once it's measured", () => {
    expect(measuringLine({ status: "applied", liveAt: null, appliedAt: at, liveCheck: { state: "still_there" } })).toBe("Measuring starts on the day the change shows on the live page, or the next crawl stops finding it.");
    expect(measuringLine({ status: "measured", liveAt: at, appliedAt: at, liveCheck: null })).toBeNull();
    expect(measuringLine({ status: "open", liveAt: null, appliedAt: null, liveCheck: null })).toBeNull();
  });
});

describe("visitsSentence", () => {
  it("puts Plausible's visits beside Search Console's clicks and claims nothing about the fix", () => {
    expect(visitsSentence(result(14, 40, 47), { before: 52, after: 61, over: "page" })).toBe("14 days before and after: Search Console clicks 40, then 47. Plausible organic visits 52, then 61.");
  });

  it("says when the numbers are the whole site's", () => {
    expect(visitsSentence(result(7, 1000, 1200), { before: 2000, after: 2100, over: "site" })).toBe("7 days before and after, across the whole site: Search Console clicks 1,000, then 1,200. Plausible organic visits 2,000, then 2,100.");
  });

  it("says exactly what the visits count, and that they aren't only Google", () => {
    expect(VISITS_MEANING).toMatch(/started on the page/);
    expect(VISITS_MEANING).toMatch(/Organic Search/);
    expect(VISITS_MEANING).toMatch(/medium organic/);
    expect(VISITS_MEANING).toMatch(/isn't only Google/);
  });
});

describe("readResult", () => {
  it("reads clicks when there are enough", () => {
    const r = readResult(m(40), m(47), siteFlat);
    expect(r).toMatchObject({ metric: "clicks", direction: "up", change: 18, siteChange: 3 });
  });

  it("falls back to impressions, then admits too little data", () => {
    expect(readResult(m(2, 300), m(3, 400), siteFlat).metric).toBe("impressions");
    expect(readResult(m(2, 30), m(3, 40), siteFlat).direction).toBe("too_little_data");
  });

  it("calls a small move flat, and a fall a fall", () => {
    expect(readResult(m(100), m(103), siteFlat).direction).toBe("flat");
    expect(readResult(m(100), m(60), siteFlat)).toMatchObject({ direction: "down", change: -40 });
  });

  it("doesn't divide by nothing", () => {
    expect(readResult(m(0, 100), m(30, 400), siteFlat)).toMatchObject({ direction: "up", change: null, from: 0, to: 30 });
  });
});

describe("resultSentence", () => {
  it("says what happened beside the whole site", () => {
    expect(resultSentence(readResult(m(40), m(47), siteFlat), 14)).toBe("Clicks up 18% in 14 days, from 40 to 47, while the whole site rose 3%.");
  });

  it("says when a fix did nothing", () => {
    expect(resultSentence(readResult(m(100), m(103), siteFlat), 28)).toBe("Clicks held about level in 28 days, at 103, while the whole site rose 3%. No clear change yet.");
  });

  it("says when a fall came with the rest of the site", () => {
    expect(resultSentence(readResult(m(100), m(60), { before: m(1000), after: m(700) }), 7)).toBe("Clicks down 40% in 7 days, from 100 to 60, while the whole site fell 30%.");
  });

  it("won't guess from too little", () => {
    expect(resultSentence(readResult(m(1, 10), m(2, 10), siteFlat), 7)).toBe("Too little traffic in 7 days to tell.");
  });
});

describe("resultLines", () => {
  const fix = (id: number, url: string, liveDay: string, results: Record<string, FixResult>, code = "title-too-long") => ({ id, code, url, liveDay, results });

  it("adds up one kind of fix from one day", () => {
    const lines = resultLines([fix(1, "https://x.com/a", "2026-11-18", { "14": result(14, 30, 40) }), fix(2, "https://x.com/b", "2026-11-18", { "14": result(14, 10, 7) })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ count: 2, days: 14 });
    expect(lines[0].sentence).toBe("Fixed 2 titles on Nov 18. Clicks up 18% in 14 days, from 40 to 47, while the whole site rose 3%.");
  });

  it("reads a group at the checkpoint they all reached", () => {
    const lines = resultLines([fix(1, "https://x.com/a", "2026-11-18", { "7": result(7, 30, 30), "14": result(14, 30, 40) }), fix(2, "https://x.com/b", "2026-11-18", { "7": result(7, 30, 30) })]);
    expect(lines[0].days).toBe(7);
  });

  it("counts a page once when two findings share it", () => {
    const lines = resultLines([fix(1, "https://x.com/a", "2026-11-18", { "14": result(14, 30, 40) }), fix(2, "https://x.com/a", "2026-11-18", { "14": result(14, 30, 40) }, "title-too-short")]);
    expect(lines[0].reading).toMatchObject({ from: 30, to: 40 });
  });

  it("leaves out fixes with nothing measured, and doesn't compare a site-wide fix with itself", () => {
    expect(resultLines([fix(1, "https://x.com/a", "2026-11-18", {})])).toEqual([]);
    const [line] = resultLines([fix(1, "https://x.com/", "2026-11-18", { "14": result(14, 30, 40) }, "no-sitemap")]);
    expect(line.sentence).toBe("Fixed 1 sitemap on Nov 18. Clicks up 33% in 14 days, from 30 to 40.");
  });

  it("orders newest first", () => {
    const lines = resultLines([fix(1, "https://x.com/a", "2026-10-01", { "14": result(14, 30, 40) }), fix(2, "https://x.com/b", "2026-11-18", { "14": result(14, 30, 40) })]);
    expect(lines.map((l) => l.liveDay)).toEqual(["2026-11-18", "2026-10-01"]);
  });

  it("finds the longest checkpoint", () => {
    expect(latestResult({ "7": result(7, 1, 1), "28": result(28, 1, 1), "14": result(14, 1, 1) })?.days).toBe(28);
    expect(latestResult(null)).toBeNull();
  });
});

describe("resultLines for logged changes", () => {
  it("says changed, not fixed, and keeps them apart from fixes on the same day", () => {
    const lines = resultLines([
      { id: 1, code: "manual-change", url: "https://x.com/a", liveDay: "2026-11-18", results: { "14": result(14, 30, 40) } },
      { id: 2, code: "thin-content", url: "https://x.com/b", liveDay: "2026-11-18", results: { "14": result(14, 30, 40) } },
    ]);
    expect(lines.map((l) => l.sentence.split(".")[0]).sort()).toEqual(["Changed 1 page on Nov 18", "Fixed 1 page on Nov 18"]);
  });
});

describe("measuringLine for a logged change", () => {
  it("doesn't promise a crawl will settle it", () => {
    expect(measuringLine({ status: "applied", liveAt: null, appliedAt: new Date(), liveCheck: null, code: "manual-change" })).toBe("Measuring starts on the day the change shows on the live page.");
  });
});

describe("a new page", () => {
  it("reads a page with no traffic before as up from none, with no percentage", () => {
    const r = readResult(m(0, 0), m(25, 900), siteFlat);
    expect(r).toMatchObject({ metric: "clicks", direction: "up", change: null, from: 0, to: 25 });
    expect(resultSentence(r, 28)).toBe("Clicks up from none to 25 in 28 days, while the whole site rose 3%.");
    expect(resultSentence(readResult(m(0, 0), m(2, 40), siteFlat), 7)).toBe("Too little traffic in 7 days to tell.");
  });
});
