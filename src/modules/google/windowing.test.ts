import { describe, expect, it } from "vitest";
import {
  addDays,
  alignCompare,
  chunkRange,
  daysBetween,
  eachDay,
  historyStart,
  newestFinalDate,
  pctChange,
  performanceRows,
  planSync,
  resolvePeriods,
  storedDays,
  todayIn,
  type WindowState,
} from "./windowing";

const fresh = (backfillStart: string): WindowState => ({ backfillStart, backfillCursor: null, backfillDone: false, latestStored: null });

describe("date helpers", () => {
  it("adds days across month and leap boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-10-01", "2026-10-29")).toBe(28);
  });

  it("lists days inclusively and chunks ranges oldest first", () => {
    expect(eachDay({ start: "2026-10-27", end: "2026-10-29" })).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(chunkRange({ start: "2026-01-01", end: "2026-01-10" }, 4)).toEqual([
      { start: "2026-01-01", end: "2026-01-04" },
      { start: "2026-01-05", end: "2026-01-08" },
      { start: "2026-01-09", end: "2026-01-10" },
    ]);
  });

  it("computes today in Pacific Time, not UTC", () => {
    // 06:30 UTC on Oct 29 is still Oct 28 in Los Angeles.
    expect(todayIn("America/Los_Angeles", new Date("2026-10-29T06:30:00Z"))).toBe("2026-10-28");
  });

  it("starts history 16 months back with a small margin", () => {
    expect(historyStart("2026-10-29")).toBe("2025-07-01");
  });
});

describe("planSync", () => {
  it("first run: re-pulls the last 5 days and starts the backfill at the earliest data, oldest first", () => {
    const plan = planSync({
      newest: "2026-10-26",
      recentDays: 5,
      budgetDays: 30,
      state: fresh("2025-07-01"),
      earliestWithData: "2025-09-15",
    });
    expect(plan.recent).toEqual({ start: "2026-10-22", end: "2026-10-26" });
    expect(plan.backfill).toEqual({ start: "2025-09-15", end: "2025-10-14" });
    expect(plan.next).toEqual({ backfillCursor: "2025-10-15", backfillDone: false });
  });

  it("continues from the cursor and finishes just before the recent window", () => {
    const plan = planSync({
      newest: "2026-10-26",
      recentDays: 5,
      budgetDays: 30,
      state: { backfillStart: "2025-07-01", backfillCursor: "2026-10-01", backfillDone: false, latestStored: "2026-10-26" },
    });
    expect(plan.backfill).toEqual({ start: "2026-10-01", end: "2026-10-21" });
    expect(plan.next).toEqual({ backfillCursor: null, backfillDone: true });
  });

  it("covers the whole 16-month window across runs without gaps or overlaps", () => {
    let state = fresh(historyStart("2026-10-29"));
    const fetched: string[] = [];
    let plan;
    let runs = 0;
    do {
      plan = planSync({ newest: "2026-10-26", recentDays: 5, budgetDays: 30, state });
      if (plan.backfill) fetched.push(...eachDay(plan.backfill));
      state = { ...state, ...plan.next, latestStored: "2026-10-26" };
      runs++;
    } while (!plan.next.backfillDone && runs < 100);
    fetched.push(...eachDay(plan.recent!));
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched).toEqual(eachDay({ start: "2025-07-01", end: "2026-10-26" }));
    expect(runs).toBe(Math.ceil(daysBetween("2025-07-01", "2026-10-22") / 30));
  });

  it("once done, only the recent window runs", () => {
    const plan = planSync({
      newest: "2026-10-27",
      recentDays: 5,
      budgetDays: 30,
      state: { backfillStart: "2025-07-02", backfillCursor: null, backfillDone: true, latestStored: "2026-10-26" },
    });
    expect(plan.recent).toEqual({ start: "2026-10-23", end: "2026-10-27" });
    expect(plan.backfill).toBeNull();
    expect(plan.next.backfillDone).toBe(true);
  });

  it("re-opens the backfill for a gap left while the worker was off", () => {
    const plan = planSync({
      newest: "2026-10-26",
      recentDays: 5,
      budgetDays: 30,
      state: { backfillStart: "2025-07-01", backfillCursor: null, backfillDone: true, latestStored: "2026-10-01" },
    });
    expect(plan.backfill).toEqual({ start: "2026-10-02", end: "2026-10-21" });
    expect(plan.next.backfillDone).toBe(true);
  });

  it("slides a stale cursor forward to the window start", () => {
    const plan = planSync({
      newest: "2026-10-26",
      recentDays: 5,
      budgetDays: 10,
      state: { backfillStart: "2025-07-10", backfillCursor: "2025-07-01", backfillDone: false, latestStored: null },
    });
    expect(plan.backfill?.start).toBe("2025-07-10");
  });

  it("does nothing when the property has no final data yet", () => {
    const plan = planSync({ newest: null, recentDays: 5, budgetDays: 30, state: fresh("2025-07-01") });
    expect(plan.recent).toBeNull();
    expect(plan.backfill).toBeNull();
  });

  it("never starts the recent window before the backfill start", () => {
    const plan = planSync({ newest: "2025-07-03", recentDays: 5, budgetDays: 30, state: fresh("2025-07-01") });
    expect(plan.recent).toEqual({ start: "2025-07-01", end: "2025-07-03" });
    expect(plan.backfill).toBeNull();
    expect(plan.next.backfillDone).toBe(true);
  });
});

describe("newestFinalDate", () => {
  it("drops dates on or after first_incomplete_date", () => {
    expect(newestFinalDate(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"], "2026-10-26")).toBe("2026-10-25");
    expect(newestFinalDate(["2026-10-24", "2026-10-25"], null)).toBe("2026-10-25");
    expect(newestFinalDate([], null)).toBeNull();
  });
});

describe("storedDays", () => {
  const end = "2026-10-30";
  const from = (date: string, previous: unknown = null) => ({ end, previous, series: [{ date }] });
  it("counts from where the series starts on a new property", () => {
    expect(storedDays(from("2026-10-26"), 28)).toBe(5);
    expect(storedDays(from(end), 28)).toBe(1);
  });
  it("never counts more than the window", () => {
    expect(storedDays(from("2026-01-01"), 28)).toBe(28);
  });
  it("is the whole window with an earlier period stored, or with no daily rows", () => {
    expect(storedDays(from("2026-10-26", {}), 28)).toBe(28);
    expect(storedDays({ end, previous: null, series: [] }, 28)).toBe(28);
  });
});

describe("resolvePeriods", () => {
  it("compares with the previous period of the same length", () => {
    expect(resolvePeriods("2026-10-26", 28, "prev")).toEqual({
      current: { start: "2026-09-29", end: "2026-10-26" },
      previous: { start: "2026-09-01", end: "2026-09-28" },
    });
  });

  it("compares year over year on the same weekdays", () => {
    const p = resolvePeriods("2026-10-26", 28, "yoy");
    expect(p.previous).toEqual({ start: "2025-09-30", end: "2025-10-27" });
  });

  it("supports no comparison", () => {
    expect(resolvePeriods("2026-10-26", 7, "none").previous).toBeNull();
  });

  it("pctChange has no baseline for zero", () => {
    expect(pctChange(15, 10)).toBeCloseTo(0.5);
    expect(pctChange(5, 0)).toBeNull();
  });
});

describe("alignCompare", () => {
  const periods = { current: { start: "2026-10-05", end: "2026-10-07" }, previous: { start: "2026-10-02", end: "2026-10-04" } };
  it("gives every day in the range a row, a count of zero when there's no row, and a gap for a rate", () => {
    const out = alignCompare([{ date: "2026-10-05", clicks: 5, position: 3 }], [{ date: "2026-10-03", clicks: 2, position: 8 }], periods, ["clicks", "position"], { zero: ["clicks"] });
    expect(out).toEqual([
      { date: "2026-10-05", clicks: 5, position: 3, prev_clicks: 0, prev_position: null },
      { date: "2026-10-06", clicks: 0, position: null, prev_clicks: 2, prev_position: 8 },
      { date: "2026-10-07", clicks: 0, position: null, prev_clicks: 0, prev_position: null },
    ]);
  });
  it("knows nothing before stored history: the period starts there and the one before has gaps", () => {
    const out = alignCompare([{ date: "2026-10-06", clicks: 1 }], [], { current: periods.current, previous: periods.previous }, ["clicks"], { zero: ["clicks"], first: "2026-10-04" });
    expect(out[0]).toEqual({ date: "2026-10-05", clicks: 0, prev_clicks: null });
    expect(out.map((r) => r.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    const earlier = alignCompare([], [], { current: { start: "2026-10-03", end: "2026-10-05" }, previous: null }, ["clicks"], { zero: ["clicks"], first: "2026-10-04" });
    expect(earlier.map((r) => r.date)).toEqual(["2026-10-04", "2026-10-05"]);
  });
});

describe("performanceRows", () => {
  const periods = { current: { start: "2026-10-05", end: "2026-10-06" }, previous: { start: "2026-10-03", end: "2026-10-04" } };
  const day = (date: string, clicks: number, impressions: number, position: number) => ({ date, clicks, impressions, position });

  it("works out CTR, and gives a rate no value on a day with no row or no impressions", () => {
    const out = performanceRows([day("2026-10-05", 5, 100, 3), day("2026-10-06", 0, 0, 0)], [day("2026-10-03", 2, 10, 8)], periods);
    expect(out).toEqual([
      { date: "2026-10-05", clicks: 5, impressions: 100, ctr: 0.05, position: 3, prev_clicks: 2, prev_impressions: 10, prev_ctr: 0.2, prev_position: 8 },
      { date: "2026-10-06", clicks: 0, impressions: 0, ctr: null, position: null, prev_clicks: 0, prev_impressions: 0, prev_ctr: null, prev_position: null },
    ]);
  });

  it("has no earlier values with no compare period", () => {
    const [row] = performanceRows([], [], { current: periods.current, previous: null });
    expect(row).toMatchObject({ clicks: 0, ctr: null, prev_clicks: null, prev_position: null });
  });
});
