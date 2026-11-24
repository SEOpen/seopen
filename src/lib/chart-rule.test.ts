import { describe, expect, it } from "vitest";
import { chartSummary, chooseChart, chooseLines, fillDays, legendSeries, niceTicks, positionTicks, rulerLabels, timeOf, weeklyBuckets } from "./chart-rule";

const series = (values: (number | null)[]) => values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, value }));

describe("chooseLines", () => {
  const moving = [10, 20, 15, 30];
  const flat = [10, 10, 10, 10];

  it("has no chart to draw from two or three checks", () => {
    expect(chooseLines([series([1, 5]), series([2, 6])])).toEqual({ kind: "text" });
    expect(chooseLines([series([1, 5, 3]), series([2, 6, 4])])).toEqual({ kind: "text" });
  });
  it("has no chart to draw when every series is flat", () => {
    expect(chooseLines([series(flat), series([3, 3, 3, 3])])).toEqual({ kind: "text" });
  });
  it("draws when the first series moved", () => {
    expect(chooseLines([series(moving), series(flat)])).toEqual({ kind: "chart", dots: true });
  });
  it("still draws a flat first series when another one moved", () => {
    expect(chooseLines([series(flat), series(moving)])).toEqual({ kind: "chart", dots: true });
  });
  it("marks points on a short run only, counting checks rather than one series' readings", () => {
    const long = Array(8).fill(0).map((_, i) => i);
    expect(chooseLines([series(long), series(long)])).toEqual({ kind: "chart", dots: false });
    expect(chooseLines([series(long), series([1, 2, 1, 2, null, null, null, null])])).toEqual({ kind: "chart", dots: false });
  });
  it("treats a miss on the first series as worth drawing, even in two checks", () => {
    expect(chooseLines([series([5, null])], { misses: true })).toEqual({ kind: "chart", dots: true });
  });
  it("doesn't count another series' nulls as misses", () => {
    expect(chooseLines([series([5, 7]), series([3, null])], { misses: true })).toEqual({ kind: "text" });
  });
  it("has nothing to draw with no series or no readings", () => {
    expect(chooseLines([])).toEqual({ kind: "text" });
    expect(chooseLines([series([null, null])], { misses: true })).toEqual({ kind: "text" });
  });
});

describe("legendSeries", () => {
  const you = { key: "you", label: "You", role: "primary" };
  const rival = (name: string) => ({ key: name, label: name, role: "context" });

  it("collapses grey competitor lines to one entry beside you", () => {
    const entries = legendSeries([you, rival("a.com"), rival("b.com"), rival("c.com")]);
    expect(entries.map((e) => e.label)).toEqual(["You", "Competitors"]);
    expect(entries[1]).toMatchObject({ role: "context" });
  });
  it("keeps a lone competitor's name, since it can only be that line", () => {
    expect(legendSeries([you, rival("a.com")]).map((e) => e.label)).toEqual(["You", "a.com"]);
  });
  it("leaves other roles alone, and doesn't change the series it was given", () => {
    const input = [{ key: "a", label: "Top 3", role: "entity" }, { key: "b", label: "Top 10", role: "entity" }, { key: "p", label: "Previous period", role: "previous" }];
    expect(legendSeries(input)).toEqual(input);
    const rivals = [rival("a.com"), rival("b.com")];
    legendSeries(rivals);
    expect(rivals[0].label).toBe("a.com");
  });
});

describe("chooseChart", () => {
  it("says why when there is nothing", () => {
    expect(chooseChart([]).kind).toBe("empty");
    expect(chooseChart(series([null, null])).kind).toBe("empty");
  });
  it("shows one reading as a number", () => {
    expect(chooseChart(series([null, 4]))).toEqual({ kind: "single", point: { date: "2026-10-02", value: 4 } });
  });
  it("shows two or three readings as from and to", () => {
    expect(chooseChart(series([1, 5, 3]))).toMatchObject({ kind: "few", first: { value: 1 }, last: { value: 3 } });
  });
  it("keeps the middle of three readings, so a recent flat stretch still shows", () => {
    expect(chooseChart(series([70, 73, 73]))).toMatchObject({ kind: "few", first: { value: 70 }, middle: { value: 73 }, last: { value: 73 } });
    expect(chooseChart(series([70, null, 73, 73]))).toMatchObject({ kind: "few", middle: { value: 73 } });
    expect(chooseChart(series([70, 73]))).not.toHaveProperty("middle");
  });
  it("calls a flat series no change", () => {
    expect(chooseChart(series([7, 7, 7, 7, 7]))).toEqual({ kind: "flat", count: 5, value: 7 });
  });
  it("calls two equal readings no change too, not from and to", () => {
    expect(chooseChart(series([82, null, 82]))).toEqual({ kind: "flat", count: 2, value: 82 });
  });
  it("doesn't chart a count too small to mean anything", () => {
    expect(chooseChart(series([1, 0, 0, 2, 0, 0, 0, 0]), { counts: true })).toEqual({ kind: "number", total: 3 });
  });
  it("sums sparse counts into weeks, or days within a week", () => {
    expect(chooseChart(series(Array(28).fill(0).map((_, i) => i % 3)), { counts: true })).toEqual({ kind: "columns", bucket: "week" });
    expect(chooseChart(series([1, 3, 0, 2, 4, 1, 2]), { counts: true })).toEqual({ kind: "columns", bucket: "day" });
  });
  it("never sums a level, however small", () => {
    expect(chooseChart(series([1, 2, 1, 3, 2, 1, 2, 2]))).toEqual({ kind: "line", dots: false });
  });
  it("draws a dot on every point of a short line", () => {
    expect(chooseChart(series([10, 20, 15, 30]))).toEqual({ kind: "line", dots: true });
  });
  it("draws a daily count that is big enough as a line", () => {
    expect(chooseChart(series(Array(28).fill(0).map((_, i) => 40 + i)), { counts: true })).toEqual({ kind: "line", dots: false });
  });

  describe("when a null is a check that found nothing", () => {
    const misses = { misses: true };
    it("still has nothing to draw with no finds at all", () => {
      expect(chooseChart([], misses).kind).toBe("empty");
      expect(chooseChart(series([null, null]), misses).kind).toBe("empty");
    });
    it("charts a keyword that ranked once and then fell out", () => {
      expect(chooseChart(series([5, null, null, null, null, null, null, null, null, null]), misses)).toEqual({ kind: "line", dots: false });
    });
    it("never calls a keyword steady when some checks missed it", () => {
      expect(chooseChart(series([5, 5, 5, 5, 5, null, null, null, null, null]), misses).kind).toBe("line");
      expect(chooseChart(series([5, null, 5]), misses)).toEqual({ kind: "line", dots: true });
    });
    it("never gives a from and to that hides a miss", () => {
      expect(chooseChart(series([5, null, 7]), misses).kind).toBe("line");
    });
    it("keeps the text forms when every check found it", () => {
      expect(chooseChart(series([12]), misses).kind).toBe("single");
      expect(chooseChart(series([5, 7]), misses).kind).toBe("few");
      expect(chooseChart(series([5, 5, 5, 5]), misses)).toEqual({ kind: "flat", count: 4, value: 5 });
    });
    it("leaves Search Console's nulls as no reading", () => {
      expect(chooseChart(series([5, null, null])).kind).toBe("single");
      expect(chooseChart(series([5, null, 5]))).toEqual({ kind: "flat", count: 2, value: 5 });
      expect(chooseChart(series([5, null, 7])).kind).toBe("few");
    });
  });
});

describe("chartSummary", () => {
  const plain = (v: number) => String(v);
  it("reads the real values when a null is no reading", () => {
    expect(chartSummary("Position", series([5, null]), plain)).toBe("Position, Oct 1 to Oct 2: latest 5, high 5, low 5");
    expect(chartSummary("Position", series([null, null]), plain)).toBe("Position: no data");
  });
  it("says the newest check found nothing, rather than giving an old position as the latest", () => {
    expect(chartSummary("Position", series([5, 7, null]), plain, "not found")).toBe("Position, Oct 1 to Oct 3: latest not found, high 7, low 5, not found in 1 of 3 checks");
  });
  it("counts earlier misses when the newest check found it", () => {
    expect(chartSummary("Position", series([null, 7]), plain, "not found")).toBe("Position, Oct 1 to Oct 2: latest 7, high 7, low 7, not found in 1 of 2 checks");
  });
  it("copes with no finds and with no checks", () => {
    expect(chartSummary("Position", series([null, null]), plain, "not found")).toBe("Position: not found in any check");
    expect(chartSummary("Position", [], plain, "not found")).toBe("Position: no data");
  });
  it("says nothing about misses when every check found it", () => {
    expect(chartSummary("Position", series([5, 7]), plain, "not found")).toBe("Position, Oct 1 to Oct 2: latest 7, high 7, low 5");
  });
  it("names a monthly series' first and last months with their years", () => {
    // Domain analysis: one reading a month, Nov 2024 to Oct 2026. It used to read "Nov 1 to Oct 1".
    const months = Array.from({ length: 24 }, (_, i) => ({ date: new Date(Date.UTC(2024, 10 + i, 1)).toISOString().slice(0, 10), value: 30 + i }));
    expect(chartSummary("Est. traffic", months, plain, undefined, true)).toBe("Est. traffic, Nov 2024 to Oct 2026: latest 53, high 53, low 30");
    expect(chartSummary("Est. traffic", months.slice(0, 2), plain, undefined, true)).toBe("Est. traffic, Nov 2024 to Dec 2024: latest 31, high 31, low 30");
  });
  it("gives the days their years when the span crosses one", () => {
    const days = [
      { date: "2025-12-30", value: 4 },
      { date: "2026-01-05", value: 6 },
    ];
    expect(chartSummary("Clicks", days, plain)).toBe("Clicks, Dec 30, 2025 to Jan 5, 2026: latest 6, high 6, low 4");
  });
});

describe("fillDays", () => {
  it("zero-fills synced days with no row", () => {
    const out = fillDays([{ date: "2026-10-02", n: 5 }], "2026-10-01", "2026-10-03", (r) => r.n);
    expect(out.map((p) => p.value)).toEqual([0, 5, 0]);
  });
  it("leaves a gap when asked to", () => {
    const out = fillDays([{ date: "2026-10-02", n: 5 }], "2026-10-01", "2026-10-02", (r) => r.n, null);
    expect(out.map((p) => p.value)).toEqual([null, 5]);
  });
});

describe("weeklyBuckets", () => {
  it("counts back from the last day and leaves out a short first week", () => {
    const days = series(Array(10).fill(1));
    const out = weeklyBuckets(days);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: "2026-10-04", date: "2026-10-10", value: 7, previous: null });
  });
  it("lines the previous period up from the end", () => {
    const out = weeklyBuckets(series(Array(14).fill(2)), series(Array(14).fill(1)));
    expect(out.map((b) => b.previous)).toEqual([7, 7]);
  });
  it("has no weeks with no data", () => {
    expect(weeklyBuckets([])).toEqual([]);
    expect(weeklyBuckets(series([1, 2, 3]))).toEqual([]);
  });
  it("leaves the earlier week empty when it isn't stored at all, not zero", () => {
    const out = weeklyBuckets(series(Array(14).fill(2)), series([...Array(7).fill(null), ...Array(7).fill(1)]));
    expect(out.map((b) => b.previous)).toEqual([null, 7]);
  });
  it("gives a partly stored earlier week no total, since a low one would read as a real count", () => {
    const out = weeklyBuckets(series(Array(14).fill(2)), series([...Array(9).fill(null), ...Array(5).fill(1)]));
    expect(out.map((b) => b.previous)).toEqual([null, null]);
    const late = weeklyBuckets(series(Array(7).fill(2)), series([null, 1, 1, 1, 1, 1, 1]));
    expect(late[0].previous).toBeNull();
  });
  it("keeps a stored day with no activity as a real zero", () => {
    const out = weeklyBuckets(series(Array(7).fill(2)), series(Array(7).fill(0)));
    expect(out[0]).toMatchObject({ value: 14, previous: 0 });
  });
  it("leaves the current week empty when any day of it isn't stored", () => {
    expect(weeklyBuckets(series(Array(7).fill(null)))[0].value).toBeNull();
    expect(weeklyBuckets(series([null, 1, 1, 1, 1, 1, 1]))[0].value).toBeNull();
  });
  it("has no earlier week when the earlier period is shorter than the bucket", () => {
    expect(weeklyBuckets(series(Array(7).fill(2)), series([1, 1, 1]))[0].previous).toBeNull();
  });
});

describe("axes", () => {
  it("always starts from zero with whole steps for counts", () => {
    expect(niceTicks(5, true)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(0, true)).toEqual([0, 1]);
  });
  it("marks positions at page boundaries only", () => {
    expect(positionTicks(14)).toEqual([1, 10, 20]);
    expect(positionTicks(37)).toEqual([1, 10, 20, 50]);
    expect(positionTicks(100)).toEqual([1, 10, 20, 50, 100]);
  });
  it("runs the position axis on past 100, so an average never draws off the scale", () => {
    expect(positionTicks(102.4)).toEqual([1, 50, 100, 150]);
    expect(positionTicks(130)).toEqual([1, 50, 100, 150]);
    expect(positionTicks(151)).toEqual([1, 50, 100, 150, 200]);
    for (const worst of [100.1, 102.4, 151, 399, 1200]) expect(positionTicks(worst).at(-1)).toBeGreaterThanOrEqual(worst);
  });
  it("labels the last date and keeps labels to what fits", () => {
    const end = timeOf("2026-10-28");
    const labels = rulerLabels(timeOf("2026-10-01"), end, 800);
    expect(labels.at(-1)?.t).toBe(end);
    expect(labels.length).toBeLessThanOrEqual(11);
  });
  it("labels months on a long range", () => {
    const labels = rulerLabels(timeOf("2026-01-15"), timeOf("2026-10-15"), 800);
    expect(labels[0].label).toBe("Feb");
  });
});
