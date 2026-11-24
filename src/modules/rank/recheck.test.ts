import { describe, expect, it } from "vitest";
import { baselineFrom, bestLook, carryDeepPositions, MAX_NOT_CHECKED_DAYS, MAX_MISS_DAYS, needsRecheck, nextStep, searchConsoleHint, type Baseline } from "./recheck";

const base = (b: Partial<Baseline> = {}): Baseline => ({ last: 5, best: 5, notCheckedDays: 0, ...b });
const row = (date: string, position: number | null, notChecked = false) => ({ date, position, notChecked });
const look = (position: number | null, id = "") => ({ position, id });

describe("baselineFrom", () => {
  it("has nothing to go on without history", () => {
    expect(baselineFrom([], "2026-11-03")).toEqual({ last: null, best: null, notCheckedDays: 0 });
  });

  it("takes the best position of the last two weeks and the latest row as last", () => {
    const rows = [row("2026-11-02", 9), row("2026-11-01", 4), row("2026-10-20", 7), row("2026-10-19", 1)];
    expect(baselineFrom(rows, "2026-11-03")).toEqual({ last: 9, best: 4, notCheckedDays: 0 });
  });

  it("forgets a position older than the window, unless it's the latest row", () => {
    expect(baselineFrom([row("2026-11-02", null), row("2026-10-01", 3)], "2026-11-03").best).toBeNull();
    expect(baselineFrom([row("2026-10-01", 3)], "2026-11-03")).toEqual({ last: 3, best: 3, notCheckedDays: 0 });
  });

  it("counts not-checked days in a row from the newest", () => {
    const rows = [row("2026-11-02", 5, true), row("2026-11-01", 5, true), row("2026-10-31", 5), row("2026-10-30", 5, true)];
    expect(baselineFrom(rows, "2026-11-03").notCheckedDays).toBe(2);
  });
});

describe("needsRecheck", () => {
  it("rechecks a keyword that ranked and is now missing", () => {
    expect(needsRecheck(null, base(), 20)).toBe(true);
  });

  it("keeps rechecking a recently ranking keyword already recorded as missing", () => {
    expect(needsRecheck(null, base({ last: null, best: 5 }), 20)).toBe(true);
  });

  it("doesn't recheck a keyword that never ranked in the window", () => {
    expect(needsRecheck(null, base({ last: null, best: null }), 20)).toBe(false);
  });

  it("doesn't recheck a miss the depth explains", () => {
    expect(needsRecheck(null, base({ last: 50, best: 50 }), 20)).toBe(false);
    expect(needsRecheck(null, base({ last: 50, best: 50 }), 100)).toBe(true);
  });

  it("rechecks from 10 places below the recent best", () => {
    expect(needsRecheck(14, base({ best: 5 }), 20)).toBe(false);
    expect(needsRecheck(15, base({ best: 5 }), 20)).toBe(true);
  });

  // The threshold stays at 10 until there are real looks per keyword to tune it on. This is what it leaves out, on purpose.
  it("leaves a move of under 10 places alone, even off page one", () => {
    expect(needsRecheck(12, base({ last: 6, best: 6 }), 20)).toBe(false);
    expect(needsRecheck(8, base({ last: 3, best: 3 }), 20)).toBe(false);
    expect(needsRecheck(16, base({ last: 6, best: 6 }), 20)).toBe(true);
  });

  it("has nothing to compare a found keyword with when it has no history", () => {
    expect(needsRecheck(12, base({ last: null, best: null }), 20)).toBe(false);
  });

  it("doesn't recheck a recovery from not ranking", () => {
    expect(needsRecheck(18, base({ last: null, best: 5 }), 20)).toBe(false);
  });

  it("rechecks an early miss with nothing else to go on", () => {
    const never = { last: null, best: null };
    expect(needsRecheck(null, base({ ...never, earlyMiss: true }), 20)).toBe(true);
    expect(needsRecheck(null, base({ ...never, earlyMiss: false }), 20)).toBe(false);
  });

  it("doesn't let an early miss overrule the depth or Search Console", () => {
    expect(needsRecheck(null, base({ last: 50, best: 50, earlyMiss: true }), 20)).toBe(false);
    expect(needsRecheck(null, base({ last: null, best: null, searchConsole: 35, earlyMiss: true }), 20)).toBe(false);
  });

  it("rechecks a miss when Search Console puts the keyword within the depth", () => {
    const never = { last: null, best: null };
    expect(needsRecheck(null, base({ ...never, searchConsole: 3.9 }), 20)).toBe(true);
    expect(needsRecheck(null, base({ ...never, searchConsole: 20 }), 20)).toBe(true);
    expect(needsRecheck(null, base({ ...never, searchConsole: 35 }), 20)).toBe(false);
    expect(needsRecheck(null, base({ ...never, searchConsole: null }), 20)).toBe(false);
  });

  it("leaves a found keyword alone whatever Search Console says", () => {
    expect(needsRecheck(18, base({ last: null, best: null, searchConsole: 3.9 }), 20)).toBe(false);
  });
});

describe("searchConsoleHint", () => {
  const at = (date: string, position: number | null, locationCode: number | null = 1) => ({ date, position, notChecked: false, locationCode });
  const misses = (n: number) => Array.from({ length: n }, (_, i) => at(`2026-11-${String(10 - i).padStart(2, "0")}`, null));

  it("passes the average on until the keyword has missed for too many days", () => {
    expect(searchConsoleHint(3.9, [], "2026-11-11", 1)).toBe(3.9);
    expect(searchConsoleHint(3.9, misses(MAX_MISS_DAYS - 1), "2026-11-11", 1)).toBe(3.9);
    expect(searchConsoleHint(3.9, misses(MAX_MISS_DAYS), "2026-11-11", 1)).toBeNull();
  });

  it("has nothing to say without an average", () => {
    expect(searchConsoleHint(null, [], "2026-11-11", 1)).toBeNull();
  });

  it("starts counting again after a position", () => {
    expect(searchConsoleHint(3.9, [at("2026-11-10", null), at("2026-11-09", 7), ...misses(3).map((r) => ({ ...r, date: "2026-11-01" }))], "2026-11-11", 1)).toBe(3.9);
  });

  it("doesn't count another place, rows with no place, or today's own row", () => {
    const earlier = [at("2026-11-07", null, 2), at("2026-11-06", null, 2), at("2026-11-05", null, 2)];
    expect(searchConsoleHint(3.9, earlier, "2026-11-11", 1)).toBe(3.9);
    expect(searchConsoleHint(3.9, [at("2026-11-07", null, null), at("2026-11-06", null, null), at("2026-11-05", null, null)], "2026-11-11", 1)).toBe(3.9);
    expect(searchConsoleHint(3.9, [at("2026-11-11", null), at("2026-11-10", null), at("2026-11-09", null)], "2026-11-11", 1)).toBe(3.9);
  });
});

describe("bestLook", () => {
  it("takes the highest position, the latest on a tie, and null when none found it", () => {
    expect(bestLook([look(null), look(12), look(4)])?.position).toBe(4);
    expect(bestLook([look(4, "a"), look(4, "b")])?.id).toBe("b");
    expect(bestLook([look(null), look(null)])).toBeNull();
  });
});

describe("nextStep", () => {
  const opts = { depth: 20, canRecheck: true };

  it("stores a believable first look", () => {
    const l = look(6);
    expect(nextStep([l], base(), opts)).toEqual({ kind: "store", look: l });
  });

  it("stores a miss of a keyword with no recent position", () => {
    const l = look(null);
    expect(nextStep([l], base({ last: null, best: null }), opts)).toEqual({ kind: "store", look: l });
  });

  it("asks for another look after a miss, and stops as soon as one finds it", () => {
    expect(nextStep([look(null)], base(), opts).kind).toBe("recheck");
    const found = look(4);
    expect(nextStep([look(null), found], base(), opts)).toEqual({ kind: "store", look: found });
  });

  it("asks for another look while the best is still far below, then keeps the best of three", () => {
    expect(nextStep([look(18)], base(), opts).kind).toBe("recheck");
    expect(nextStep([look(18), look(null)], base(), opts).kind).toBe("recheck");
    const best = look(15);
    expect(nextStep([look(18), best, look(null)], base(), opts)).toEqual({ kind: "store", look: best });
  });

  it("never asks for a fourth look", () => {
    expect(nextStep([look(null), look(null), look(null)], base(), opts).kind).not.toBe("recheck");
  });

  it("marks a ranking keyword not checked when all three looks miss", () => {
    expect(nextStep([look(null), look(null), look(null)], base(), opts)).toEqual({ kind: "not_checked" });
  });

  it("marks it not checked after fewer looks when no more can be had", () => {
    expect(nextStep([look(null)], base(), { depth: 20, canRecheck: false })).toEqual({ kind: "not_checked" });
  });

  it("records it as not ranking once the not-checked days run out", () => {
    const latest = look(null, "latest");
    const looks = [look(null), look(null), latest];
    expect(nextStep(looks, base({ notCheckedDays: MAX_NOT_CHECKED_DAYS - 1 }), opts).kind).toBe("not_checked");
    expect(nextStep(looks, base({ notCheckedDays: MAX_NOT_CHECKED_DAYS }), opts)).toEqual({ kind: "store", look: latest });
  });

  it("doesn't carry a last position beyond the check's depth", () => {
    const latest = look(null, "latest");
    expect(nextStep([look(null), look(null), latest], base({ last: 50, best: 5 }), opts)).toEqual({ kind: "store", look: latest });
  });

  it("keeps a keyword already recorded as not ranking there, with nothing to carry", () => {
    const latest = look(null, "latest");
    expect(nextStep([look(null), look(null), latest], base({ last: null, best: 5 }), opts)).toEqual({ kind: "store", look: latest });
  });
});

describe("carryDeepPositions", () => {
  const r = (date: string, position: number | null, depth: number, keywordId = 1, notChecked = false) => ({ keywordId, date, position, depth, url: position ? `https://a.com/${position}` : null, notChecked });
  const read = (rows: ReturnType<typeof r>[]) => carryDeepPositions(rows).map((x) => [x.position, x.deeperCheckDate]);

  it("keeps a sweep's position through the shallower checks after it", () => {
    const out = carryDeepPositions([r("2026-11-02", 50, 100), r("2026-11-03", null, 20), r("2026-11-04", null, 20)]);
    expect(out.map((x) => [x.position, x.url, x.deeperCheckDate])).toEqual([
      [50, "https://a.com/50", null],
      [50, "https://a.com/50", "2026-11-02"],
      [50, "https://a.com/50", "2026-11-02"],
    ]);
  });

  it("doesn't carry a position the check would have seen", () => {
    expect(read([r("2026-11-02", 15, 100), r("2026-11-03", null, 20)])).toEqual([
      [15, null],
      [null, null],
    ]);
  });

  it("believes a deep check that misses it, and doesn't bring the position back later", () => {
    expect(read([r("2026-11-02", 50, 100), r("2026-11-09", null, 100), r("2026-11-10", null, 20)])).toEqual([
      [50, null],
      [null, null],
      [null, null],
    ]);
  });

  it("stops carrying once the position is older than the recent window", () => {
    expect(read([r("2026-10-01", 50, 100), r("2026-10-15", null, 20), r("2026-10-16", null, 20), r("2026-10-17", null, 20)])).toEqual([
      [50, null],
      [50, "2026-10-01"],
      [null, null],
      [null, null],
    ]);
  });

  it("carries from rows before `from` without returning them", () => {
    const rows = [r("2026-10-25", 50, 100), r("2026-10-28", null, 20), r("2026-11-01", 50, 100), r("2026-11-04", null, 20)];
    expect(carryDeepPositions(rows, "2026-10-28").map((x) => [x.date, x.position, x.deeperCheckDate])).toEqual([
      ["2026-10-28", 50, "2026-10-25"],
      ["2026-11-01", 50, null],
      ["2026-11-04", 50, "2026-11-01"],
    ]);
  });

  it("keeps keywords apart, and a not-checked repeat isn't a new sighting", () => {
    expect(read([r("2026-11-02", 50, 100, 1), r("2026-11-03", null, 20, 2)])).toEqual([
      [50, null],
      [null, null],
    ]);
    expect(read([r("2026-10-01", 50, 100), r("2026-10-14", 50, 100, 1, true), r("2026-10-17", null, 20)])).toEqual([
      [50, null],
      [50, null],
      [null, null],
    ]);
  });
});
