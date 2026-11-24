import { describe, expect, it } from "vitest";
import { axisMax, chartReadout, columnPath, columnWidths, marksOn, marksSummary } from "./time-chart";

describe("columnWidths", () => {
  it("caps a column however much room its bucket has", () => {
    expect(columnWidths(200, false).bar).toBe(16);
    expect(columnWidths(200, true).bar).toBe(16);
  });

  it("keeps a thin column in a narrow bucket, with a floor", () => {
    expect(columnWidths(13, false).bar).toBeCloseTo(9.1);
    expect(columnWidths(2, false).bar).toBe(3);
  });

  it("stands the previous period's mark apart from the bar and thinner than it", () => {
    const { bar, previous, gap } = columnWidths(200, true);
    expect(gap).toBeGreaterThan(0);
    expect(previous).toBeLessThan(bar);
    const narrow = columnWidths(20, true);
    expect(narrow.bar + narrow.gap + narrow.previous).toBeLessThanOrEqual(20 * 0.7 + 1e-9);
  });

  it("has no second mark without a previous period", () => {
    expect(columnWidths(200, false)).toMatchObject({ previous: 0, gap: 0 });
  });
});

describe("columnPath", () => {
  it("rounds the top by at most 4px, however tall, and keeps within a short column", () => {
    expect(columnPath(0, 16, 10, 100)).toBe("M0,100V14Q0,10 4,10H12Q16,10 16,14V100Z");
    expect(columnPath(0, 16, 98, 100)).toBe("M0,100V100Q0,98 2,98H14Q16,98 16,100V100Z");
  });

  it("leaves the outline open along the baseline", () => {
    expect(columnPath(0, 8, 10, 100, false).endsWith("V100")).toBe(true);
  });
});

describe("chartReadout", () => {
  const series = [
    { key: "clicks", label: "Clicks" },
    { key: "before", label: "Previous 28 days" },
  ];
  const format = (v: number) => String(v);

  it("reads the row's label and each series", () => {
    expect(chartReadout({ date: "2026-10-12", label: "Oct 12", clicks: 180, before: 150 }, series, format)).toBe("Oct 12: Clicks 180, Previous 28 days 150");
  });

  it("says what's missing, and which kind of missing", () => {
    expect(chartReadout({ date: "2026-10-12", label: "Oct 12", clicks: null, before: null }, series, format, "clicks")).toBe("Oct 12: Clicks not found, Previous 28 days no data");
  });
});

describe("axisMax", () => {
  it("reaches the highest value with no yMax, and zero with no values", () => {
    expect(axisMax([3, 9, 4], false)).toBe(9);
    expect(axisMax([], false)).toBe(0);
  });

  it("holds the axis at yMax when the values stay under it", () => {
    expect(axisMax([3, 4], false, 40)).toBe(40);
    expect(axisMax([], false, 40)).toBe(40);
  });

  it("never cuts off a value above yMax", () => {
    expect(axisMax([3, 90], false, 40)).toBe(90);
  });

  it("leaves a rank axis to its own values", () => {
    expect(axisMax([3, 14], true, 40)).toBe(14);
  });
});

describe("marks", () => {
  const data = [{ date: "2026-11-02" }, { date: "2026-11-03" }, { date: "2026-11-04" }];
  const marks = [
    { date: "2026-11-03", label: "Title is too long" },
    { date: "2026-10-01", label: "Before the chart" },
  ];

  it("names only the marks the chart's dates reach, in the summary", () => {
    expect(marksSummary(marks, data, "Fix live")).toBe("Fix live on Nov 3, 2026: Title is too long");
    expect(marksSummary([], data, "Fix live")).toBe("");
  });

  it("finds the marks on a row's date for the hover and the table", () => {
    expect(marksOn(marks, "2026-11-03")).toEqual([marks[0]]);
    expect(marksOn(marks, "2026-11-04")).toEqual([]);
  });
});
