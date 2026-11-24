import { describe, expect, it } from "vitest";
import { countryCode } from "./country";
import { fixtureApis } from "./fixtures";

describe("countryCode", () => {
  it("takes Search Console's three-letter code in any case, as stored", () => {
    expect(countryCode("usa")).toBe("usa");
    expect(countryCode(" ESP ")).toBe("esp");
    expect(countryCode("us")).toBeNull();
    expect(countryCode("united states")).toBeNull();
  });
});

describe("the fixture Search Console's filters", () => {
  const site = "sc-domain:alphanote.example";
  const range = { startDate: "2026-10-01", endDate: "2026-10-14" };

  it("sums a period without the date dimension, one row per search", async () => {
    const { rows } = await fixtureApis.gsc.query(site, { ...range, dimensions: ["query"] });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.keys[0])).size).toBe(rows.length);
  });

  it("keeps one country's share, matches text and stops at maxRows", async () => {
    const all = await fixtureApis.gsc.query(site, { ...range, dimensions: ["query"] });
    const us = await fixtureApis.gsc.query(site, { ...range, dimensions: ["query"], filters: [{ dimension: "country", operator: "equals", expression: "usa" }] });
    const sum = (rows: { clicks: number }[]) => rows.reduce((n, r) => n + r.clicks, 0);
    expect(sum(us.rows)).toBeLessThan(sum(all.rows));
    const word = all.rows[0].keys[0].split(" ")[0];
    const matched = await fixtureApis.gsc.query(site, { ...range, dimensions: ["query"], filters: [{ dimension: "query", operator: "contains", expression: word.toUpperCase() }] });
    expect(matched.rows.every((r) => r.keys[0].includes(word))).toBe(true);
    const two = await fixtureApis.gsc.query(site, { ...range, dimensions: ["query"], maxRows: 2 });
    expect(two.rows).toHaveLength(2);
  });
});
