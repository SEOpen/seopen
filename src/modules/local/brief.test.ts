import { describe, expect, it } from "vitest";
import { businessLine, comparedStats, keywordMove, localFigures, localSentence, localWaiting, rankDelta, type KeywordReading } from "./brief";
import { statsFromPoints, type KeywordStats } from "./metrics";

describe("businessLine", () => {
  it("says the grid, the schedule and the last check in one sentence", () => {
    expect(businessLine({ gridSize: 5, radiusMiles: 5, everyDays: 7, lastChecked: "Nov 2, 12:00 PM" })).toBe("5×5 grid across 5 miles, checked every 7 days, last on Nov 2, 12:00 PM.");
  });

  it("reads right for one mile, no schedule and no check yet", () => {
    expect(businessLine({ gridSize: 3, radiusMiles: 1, everyDays: null, lastChecked: null })).toBe("3×3 grid across 1 mile, checked when you press Check now, not checked yet.");
  });
});

/** Stats for a grid: the ranks found, then how many points listed nothing, then how many failed. */
function stats(ranks: number[], none = 0, failed = 0): KeywordStats {
  return statsFromPoints([
    ...ranks.map((rank) => ({ status: "done" as const, rank })),
    ...Array.from({ length: none }, () => ({ status: "done" as const, rank: null })),
    ...Array.from({ length: failed }, () => ({ status: "failed" as const, rank: null })),
  ]);
}

const AT = "2026-11-02T12:00:00.000Z";
const OCT = "2026-10-26T12:00:00.000Z";
const base = { at: AT, previousAt: OCT, timeZone: "UTC" };

const up: KeywordReading = { cur: stats([2, 4]), prev: stats([6, 8]) };
const down: KeywordReading = { cur: stats([6, 8]), prev: stats([2, 4]) };
const same: KeywordReading = { cur: stats([3, 5]), prev: stats([3, 5]) };

describe("keywordMove", () => {
  it("goes by average rank, lower being better", () => {
    expect(keywordMove(up)).toBe("up");
    expect(keywordMove(down)).toBe("down");
    expect(keywordMove(same)).toBe("same");
  });

  it("counts appearing and vanishing as a move", () => {
    expect(keywordMove({ cur: stats([9], 1), prev: stats([], 2) })).toBe("up");
    expect(keywordMove({ cur: stats([], 2), prev: stats([9], 1) })).toBe("down");
  });

  it("falls back to how many points list you when the average holds", () => {
    expect(keywordMove({ cur: stats([5, 5, 5], 1), prev: stats([5, 5], 2) })).toBe("up");
    expect(keywordMove({ cur: stats([5, 5], 2), prev: stats([5, 5, 5], 1) })).toBe("down");
  });

  it("has nothing to say without answers on both sides", () => {
    expect(keywordMove({ cur: stats([3]), prev: null })).toBeNull();
    expect(keywordMove({ cur: stats([3]), prev: stats([], 0, 4) })).toBeNull();
    expect(keywordMove({ cur: stats([], 0, 4), prev: stats([3]) })).toBeNull();
  });
});

describe("localSentence", () => {
  it("says a move up, a move down, and both", () => {
    expect(localSentence({ ...base, rows: [up] })).toBe("One keyword moved up on Google Maps, compared with Oct 26.");
    expect(localSentence({ ...base, rows: [down, down] })).toBe("Two keywords moved down on Google Maps, compared with Oct 26.");
    expect(localSentence({ ...base, rows: [up, up, down] })).toBe("Two keywords moved up and one moved down on Google Maps, compared with Oct 26.");
  });

  it("says when nothing moved", () => {
    expect(localSentence({ ...base, rows: [same] })).toBe("Nothing moved since Oct 26.");
  });

  it("says when it's the first check", () => {
    expect(localSentence({ ...base, previousAt: null, rows: [{ cur: stats([3]), prev: null }] })).toBe("First check on Nov 2. Changes show after the next one.");
  });

  it("doesn't claim calm when nothing could be compared", () => {
    expect(localSentence({ ...base, rows: [{ cur: stats([3]), prev: null }] })).toBe("No results to compare with Oct 26 yet.");
  });

  it("names the check when an older one is on screen", () => {
    expect(localSentence({ ...base, latest: false, rows: [up] })).toBe("On Nov 2, one keyword moved up on Google Maps, compared with Oct 26.");
    expect(localSentence({ ...base, latest: false, rows: [same] })).toBe("Nothing moved between Oct 26 and Nov 2.");
  });

  it("doesn't compare a day with itself", () => {
    expect(localSentence({ ...base, previousAt: "2026-11-02T08:00:00.000Z", rows: [same] })).toBe("Nothing moved since the check before.");
  });
});

describe("localWaiting", () => {
  it("says what happens next", () => {
    expect(localWaiting({ running: true, scheduled: false })).toMatch(/running/);
    expect(localWaiting({ running: false, scheduled: true })).toMatch(/weekly check/);
    expect(localWaiting({ running: false, scheduled: false })).toBe("Not checked yet. Check now runs the first one.");
  });
});

describe("comparedStats", () => {
  it("leaves out a keyword only one check has", () => {
    const added: KeywordReading = { cur: stats([1, 1, 1]), prev: null };
    expect(comparedStats([up, added])).toEqual({ cur: up.cur, prev: up.prev });
    expect(comparedStats([added])).toBeNull();
  });
});

describe("rankDelta", () => {
  it("reads as better or worse", () => {
    expect(rankDelta(-1.2)).toEqual({ text: "1.2 better", tone: "good", up: true });
    expect(rankDelta(0.4)).toEqual({ text: "0.4 worse", tone: "bad", up: false });
    expect(rankDelta(0)).toMatchObject({ tone: "muted", up: null });
    expect(rankDelta(null)).toBeNull();
  });
});

describe("localFigures", () => {
  it("reads a position as better and small counts as plain differences", () => {
    const [rank, top3, found] = localFigures({ ...base, rows: [{ cur: stats([2, 3, 12], 2), prev: stats([3, 14], 3) }] });
    expect(rank).toMatchObject({ state: "value", value: "5.7", delta: { text: "2.8 better", tone: "good" }, position: { value: 17 / 3, previous: 8.5 }, caption: "average where you appear, vs Oct 26" });
    expect(top3).toMatchObject({ value: "2 of 5", delta: { text: "+1", tone: "good", up: true } });
    expect(found).toMatchObject({ value: "3 of 5", delta: { text: "+1", tone: "good" } });
  });

  it("shows a loss as a loss", () => {
    const [rank, top3, found] = localFigures({ ...base, rows: [{ cur: stats([8], 4), prev: stats([2, 3], 3) }] });
    expect(rank).toMatchObject({ delta: { text: "5.5 worse", tone: "bad", up: false } });
    expect(top3).toMatchObject({ value: "0 of 5", delta: { text: "−2", tone: "bad" } });
    expect(found).toMatchObject({ value: "1 of 5", delta: { text: "−1", tone: "bad" } });
  });

  it("says no change when nothing moved", () => {
    for (const f of localFigures({ ...base, rows: [same] })) expect(f).toMatchObject({ state: "value", delta: { tone: "muted", up: null } });
  });

  it("draws no earlier needle when a keyword was added since, so the gauge can't show a loss that didn't happen", () => {
    const steady: KeywordReading = { cur: stats([3]), prev: stats([3]) };
    const added: KeywordReading = { cur: stats([15]), prev: null };
    const [rank] = localFigures({ ...base, rows: [steady, added] });
    expect(rank).toMatchObject({ value: "9.0", delta: { tone: "muted" }, position: { value: 9, previous: null } });
  });

  it("has no change on a first check", () => {
    const figures = localFigures({ ...base, previousAt: null, rows: [{ cur: stats([3, 4]), prev: null }] });
    for (const f of figures) expect(f).toMatchObject({ state: "value", delta: null });
    expect(figures[0]).toMatchObject({ caption: "average where you appear, nothing earlier to compare" });
  });

  it("compares shares when the grid changed size", () => {
    const [, top3] = localFigures({ ...base, rows: [{ cur: stats([1, 1, 1, 1], 5), prev: stats([1], 3) }] });
    expect(top3).toMatchObject({ value: "4 of 9", delta: { text: "+19.4 pts", tone: "good" } });
  });

  it("says why there's no rank when the listing wasn't found", () => {
    const [rank, top3] = localFigures({ ...base, previousAt: null, rows: [{ cur: stats([], 4), prev: null }] });
    expect(rank).toMatchObject({ state: "empty", text: "Not in the top 20 at any point." });
    expect(top3).toMatchObject({ value: "0 of 4" });
  });

  it("names failed points apart, and shows nothing before an answer", () => {
    const [, , found] = localFigures({ ...base, previousAt: null, rows: [{ cur: stats([3], 1, 2), prev: null }] });
    expect(found).toMatchObject({ value: "1 of 2", caption: "points listing you in the top 20, 2 failed, nothing earlier to compare" });
    expect(localFigures({ ...base, rows: [{ cur: stats([], 0, 4), prev: null }] })).toEqual([]);
  });
});

describe("after a newer check failed", () => {
  const reading = (rank: number) => ({ cur: { total: 25, answered: 25, found: 25, top3: 0, rankSum: rank * 25, failed: 0 }, prev: { total: 25, answered: 25, found: 25, top3: 0, rankSum: 25 * 10, failed: 0 } }) as never;
  const at = "2026-11-05T12:00:00Z";
  const previousAt = "2026-10-29T12:00:00Z";

  it("dates what it says instead of calling it the latest", () => {
    const said = localSentence({ rows: [reading(5)], at, previousAt, timeZone: "UTC", newerFailed: true });
    expect(said).toMatch(/^On Nov 5, /);
    expect(localSentence({ rows: [reading(10)], at, previousAt, timeZone: "UTC", newerFailed: true })).toBe("Nothing moved between Oct 29 and Nov 5.");
  });

  it("doesn't promise changes after the next check when the next check failed", () => {
    expect(localSentence({ rows: [], at, previousAt: null, timeZone: "UTC", newerFailed: true })).toBe("Only the Nov 5 check has results so far.");
  });

  it("doesn't say not checked yet about a check that failed", () => {
    expect(localWaiting({ running: false, scheduled: true, noResults: "No results yet, because the last check failed." })).toBe("No results yet, because the last check failed.");
    expect(localWaiting({ running: true, scheduled: true, noResults: "No results yet, because the last check failed." })).toMatch(/running/);
    const line = (lastChecked: string | null) => businessLine({ gridSize: 5, radiusMiles: 5, everyDays: 7, lastChecked, failed: true });
    expect(line("Nov 5")).toBe("5×5 grid across 5 miles, checked every 7 days, last good check Nov 5.");
    expect(line(null)).toBe("5×5 grid across 5 miles, checked every 7 days, no successful check yet.");
  });
});
