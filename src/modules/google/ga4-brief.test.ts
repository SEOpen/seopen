import { describe, expect, it } from "vitest";
import { analyticsFigures, analyticsSentence, comparesFairly, earlierLabel, earlierPeriod, landingPageColumns, type AnalyticsBrief, type AnalyticsTotals } from "./ga4-brief";

const totals = (over: Partial<AnalyticsTotals> = {}): AnalyticsTotals => ({ sessions: 100, engagedSessions: 60, keyEvents: 0, totalRevenue: 0, ...over });

const CURRENT = { start: "2026-10-07", end: "2026-11-03" };
const PREVIOUS = { start: "2026-09-09", end: "2026-10-06" };

const brief = (over: Partial<AnalyticsBrief> = {}): AnalyticsBrief => ({
  source: "ga4",
  periods: { current: CURRENT, previous: PREVIOUS },
  compare: "prev",
  first: "2025-01-01",
  current: totals(),
  previous: totals(),
  pages: 12,
  ...over,
});

describe("analyticsSentence", () => {
  it("says a move up with its window", () => {
    expect(analyticsSentence(brief({ current: totals({ sessions: 150 }) }))).toBe("Organic sessions are up 50%, compared with the 28 days before.");
  });

  it("says a move down, last year's window too", () => {
    expect(analyticsSentence(brief({ current: totals({ sessions: 70 }) }))).toBe("Organic sessions are down 30%, compared with the 28 days before.");
    expect(analyticsSentence(brief({ compare: "yoy", current: totals({ sessions: 70 }) }))).toBe("Organic sessions are down 30%, compared with the same days last year.");
  });

  it("puts the bad news first when both moved, and revenue reads as one thing", () => {
    const b = brief({ current: totals({ sessions: 150, totalRevenue: 500 }), previous: totals({ totalRevenue: 1000 }) });
    expect(analyticsSentence(b)).toBe("Revenue is down 50%, but organic sessions are up 50%, compared with the 28 days before.");
  });

  it("shows small counts as from → to rather than a percentage", () => {
    expect(analyticsSentence(brief({ current: totals({ sessions: 3 }), previous: totals({ sessions: 5 }) }))).toBe("Organic sessions went from 5 to 3, compared with the 28 days before.");
    expect(analyticsSentence(brief({ current: totals({ sessions: 40 }), previous: totals({ sessions: 0 }) }))).toBe("Organic sessions went from 0 to 40, compared with the 28 days before.");
  });

  it("is calm when nothing moved", () => {
    expect(analyticsSentence(brief())).toBe("Nothing moved: 100 organic sessions in the 28 days to Nov 3, the same as the 28 days before.");
    expect(analyticsSentence(brief({ current: totals({ sessions: 103 }) }))).toBe("Little changed: 103 organic sessions in the 28 days to Nov 3, against 100 in the 28 days before.");
    expect(analyticsSentence(brief({ current: totals({ sessions: 0 }), previous: totals({ sessions: 0 }) }))).toBe("No organic sessions in the 28 days to Nov 3, and none in the 28 days before.");
  });

  it("says when history has only just started", () => {
    const b = brief({ first: "2026-11-01", periods: { current: CURRENT, previous: null }, previous: null, current: totals({ sessions: 2 }) });
    expect(analyticsSentence(b)).toBe("Two organic sessions since Nov 1. Changes show once there's an earlier period to compare.");
  });

  it("doesn't compare against a period that's only partly stored", () => {
    const b = brief({ first: "2026-10-01", current: totals({ sessions: 500 }), previous: totals({ sessions: 20 }) });
    expect(analyticsSentence(b)).toBe("500 organic sessions in the 28 days to Nov 3. The earlier period is only partly stored, so there's no fair comparison yet.");
  });

  it("just says the number when comparing is off", () => {
    expect(analyticsSentence(brief({ compare: "none", periods: { current: CURRENT, previous: null }, previous: null }))).toBe("100 organic sessions in the 28 days to Nov 3.");
  });

  it("leaves GA4's key events and revenue out of a PostHog project", () => {
    const b = brief({ source: "posthog", current: totals({ keyEvents: 90 }), previous: totals({ keyEvents: 30 }) });
    expect(analyticsSentence(b)).toMatch(/^Nothing moved/);
  });
});

describe("analyticsFigures", () => {
  it("leads on sessions, engaged, key events and revenue, with what each covers", () => {
    const [sessions, engaged, keyEvents, revenue] = analyticsFigures(
      brief({ current: totals({ sessions: 150, engagedSessions: 90, keyEvents: 25, totalRevenue: 1200 }), previous: totals({ keyEvents: 50, totalRevenue: 1000 }) }),
    );
    expect(sessions).toMatchObject({ value: "150", delta: { tone: "good", text: "+50%" }, caption: "28 days to Nov 3, vs the 28 before" });
    expect(engaged).toMatchObject({ value: "90", caption: "60.0% of sessions, vs the 28 before" });
    expect(keyEvents).toMatchObject({ value: "25", delta: { tone: "bad", text: "−25" } });
    expect(revenue).toMatchObject({ value: "$1,200", delta: { tone: "good", text: "+20%" } });
  });

  it("shows small counts as absolute change", () => {
    const [sessions] = analyticsFigures(brief({ current: totals({ sessions: 3 }), previous: totals({ sessions: 5 }) }));
    expect(sessions).toMatchObject({ delta: { text: "−2", tone: "bad" } });
  });

  it("has no change on a first reading or a partly stored period", () => {
    const first = analyticsFigures(brief({ first: "2026-11-01", periods: { current: CURRENT, previous: null }, previous: null }));
    expect(first[0]).toMatchObject({ delta: null, caption: "since Nov 1, nothing earlier to compare" });
    const partial = analyticsFigures(brief({ first: "2026-10-01" }));
    expect(partial[0]).toMatchObject({ delta: null, caption: "28 days to Nov 3, earlier period only partly stored" });
  });

  it("drops the comparison from captions when it's off", () => {
    const [sessions] = analyticsFigures(brief({ compare: "none", periods: { current: CURRENT, previous: null }, previous: null }));
    expect(sessions).toMatchObject({ delta: null, caption: "28 days to Nov 3" });
  });

  it("says no revenue was recorded rather than showing $0", () => {
    expect(analyticsFigures(brief())[3]).toMatchObject({ state: "empty", label: "Revenue" });
  });

  it("keeps a revenue that fell to nothing", () => {
    expect(analyticsFigures(brief({ previous: totals({ totalRevenue: 500 }) }))[3]).toMatchObject({ state: "value", value: "$0" });
  });

  it("reads revenue as a percentage at any size, since a plain difference has no currency", () => {
    const revenue = (now: number, before: number) => analyticsFigures(brief({ current: totals({ totalRevenue: now }), previous: totals({ totalRevenue: before }) }))[3];
    expect(revenue(8, 5)).toMatchObject({ value: "$8", delta: { text: "+60%", tone: "good" } });
    expect(revenue(0, 500)).toMatchObject({ delta: { text: "−100%", tone: "bad" } });
    expect(revenue(500, 0)).toMatchObject({ value: "$500", delta: null });
  });

  it("gives a Plausible project PostHog's three figures, with engaged as not bounced", () => {
    expect(analyticsFigures(brief({ source: "plausible" })).map((f) => f.id)).toEqual(["sessions", "engaged", "pages"]);
    expect(analyticsFigures(brief({ source: "plausible" }))[1]).toMatchObject({ caption: expect.stringContaining("not bounced") });
  });

  it("gives a PostHog project three figures", () => {
    const figures = analyticsFigures(brief({ source: "posthog" }));
    expect(figures.map((f) => f.label)).toEqual(["Organic sessions", "Engaged sessions", "Landing pages"]);
    expect(figures[1]).toMatchObject({ caption: "60.0% not bounced, vs the 28 before" });
  });
});

describe("landingPageColumns", () => {
  const keys = (rows: Parameters<typeof landingPageColumns>[0], source: "ga4" | "posthog" = "ga4", compare = true) => landingPageColumns(rows, { source, compare }).map((c) => c.key);
  const full = { keyEvents: 2, totalRevenue: 10, gscClicks: 0, gscImpressions: 5, gscCtr: 0, gscPosition: 8 };
  const base = ["landingPage", "sessions", "sessionsDelta", "engagementRate"];

  it("keeps a column any row has a reading for, a Search Console 0 included", () => {
    expect(keys([full, { keyEvents: 0, totalRevenue: 0, gscClicks: null, gscImpressions: null, gscCtr: null, gscPosition: null }])).toEqual([...base, "keyEvents", "totalRevenue", "gscClicks", "gscImpressions", "gscCtr", "gscPosition"]);
  });

  it("hides columns empty in every row", () => {
    expect(keys([{ keyEvents: 0, totalRevenue: 0, gscClicks: null, gscImpressions: null, gscCtr: null, gscPosition: null }])).toEqual(base);
  });

  it("leaves out GA4's columns on PostHog, and the change without a fair comparison", () => {
    expect(keys([full], "posthog", false)).toEqual(["landingPage", "sessions", "engagementRate", "gscClicks", "gscImpressions", "gscCtr", "gscPosition"]);
  });
});

describe("plain words", () => {
  it("names the earlier period", () => {
    const periods = { current: CURRENT, previous: PREVIOUS };
    expect(earlierPeriod("prev", periods)).toBe("the 28 days before");
    expect(earlierLabel("prev", periods)).toBe("Previous 28 days");
    expect(earlierPeriod("yoy", periods)).toBe("the same days last year");
    expect(earlierLabel("yoy", periods)).toBe("Same days last year");
  });

  it("only compares a period stored in full", () => {
    const periods = { current: CURRENT, previous: PREVIOUS };
    expect(comparesFairly(periods, "2026-09-09")).toBe(true);
    expect(comparesFairly(periods, "2026-09-10")).toBe(false);
    expect(comparesFairly({ current: CURRENT, previous: null }, "2026-09-09")).toBe(false);
  });
});
