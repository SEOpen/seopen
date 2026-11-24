import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NewLostPoint } from "./logic";
import { NewLostChart, newLostCharts } from "./new-lost-chart";

const DATA: NewLostPoint[] = [
  { date: "2026-10", newDomains: 2, lostDomains: -40, newBacklinks: 90, lostBacklinks: -5 },
  { date: "2026-11", newDomains: 7, lostDomains: 0, newBacklinks: 12, lostBacklinks: -3 },
];

describe("newLostCharts", () => {
  it("gives each month its first day and its name, with lost counts positive", () => {
    const { charts } = newLostCharts(DATA, "backlinks");
    expect(charts.map((c) => c.label)).toEqual(["New links", "Lost links"]);
    expect(charts[0].rows).toEqual([
      { date: "2026-10-01", label: "Oct 2026", value: 90 },
      { date: "2026-11-01", label: "Nov 2026", value: 12 },
    ]);
    expect(charts[1].rows.map((r) => r.value)).toEqual([5, 3]);
  });

  it("names referring domains as domains, not links", () => {
    const { charts } = newLostCharts(DATA, "domains");
    expect(charts.map((c) => c.label)).toEqual(["New domains", "Lost domains"]);
    expect(charts[1].rows.map((r) => r.value)).toEqual([40, 0]);
  });

  it("shares one axis top, from whichever side is taller", () => {
    expect(newLostCharts(DATA, "backlinks").yMax).toBe(90);
    expect(newLostCharts(DATA, "domains").yMax).toBe(40);
    expect(newLostCharts([], "domains").yMax).toBe(0);
  });
});

describe("NewLostChart", () => {
  it("draws two titled charts, each with a table view and a summary", () => {
    const html = renderToStaticMarkup(createElement(NewLostChart, { data: DATA, kind: "backlinks" }));
    expect(html).toContain(">New links</h3>");
    expect(html).toContain(">Lost links</h3>");
    expect(html.match(/Show as table/g)).toHaveLength(2);
    expect(html).toContain("Lost links, Oct 1 to Nov 1: latest 3, high 5, low 3");
    expect(html).toContain("Backlinks: 102 new and 8 lost across 2 months.");
  });
});
