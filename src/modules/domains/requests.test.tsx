import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { costLabel, maxCostLabel } from "@/modules/keywords/format";
import { competitorsSpec, historySpec, pagesSpec, priceQuote, rankedKeywordsSpec, rankOverviewSpec, withinQuote } from "./requests";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));

const { NotLoaded } = await import("@/modules/keywords/components/research-ui");

const m = { locationCode: 2840, languageCode: "en" };
const specs = [rankOverviewSpec("a.com", m), historySpec("a.com", m), rankedKeywordsSpec("a.com", m), pagesSpec("a.com", m), competitorsSpec("a.com", m)];
const total = specs.reduce((n, s) => n + s.estUsd, 0);

describe("what a Domain analysis lookup says it costs", () => {
  it.skipIf(!rules.hasPlans)("is a ceiling, because Labs bills per row returned", () => {
    expect(maxCostLabel(total)).toBe("≈ 28 credits max");
  });

  it.skipIf(!rules.hasPlans)("can charge a small domain about 20 credits, under the ceiling: the base fees alone", () => {
    const base = 0.012 * 4 + 0.12 + 0.0012 * 25;
    expect(costLabel(base)).toBe("≈ 20 credits");
    expect(base).toBeLessThan(total);
  });

  it.skipIf(!rules.hasPlans)("is 15 when only the 2-year history is left to load", () => {
    expect(maxCostLabel(historySpec("a.com", m).estUsd)).toBe("≈ 15 credits max");
  });

  it("asks for a new history when a new month starts, while the others stay saved", () => {
    const task = (d: string) => historySpec("a.com", m, new Date(d)).task;
    expect(task("2026-10-31T12:00:00Z")).not.toEqual(task("2026-11-01T12:00:00Z"));
    expect(task("2026-11-01T12:00:00Z")).toEqual(task("2026-11-30T12:00:00Z"));
  });

  it.skipIf(!rules.hasPlans)("shows the ceiling only where a page asks for it", () => {
    expect(renderToStaticMarkup(<NotLoaded costUsd={0.15} ceiling />)).toContain("≈ 15 credits max");
    expect(renderToStaticMarkup(<NotLoaded costUsd={0.15} />)).not.toContain("max");
  });
});

describe("price quotes", () => {
  const lookup = "a.com|2840";

  it("lets a click spend what it showed, or less", () => {
    expect(withinQuote(priceQuote(lookup, 0.15), lookup, 0.15)).toBe(true);
    expect(withinQuote(priceQuote(lookup, total), lookup, total)).toBe(true);
    expect(withinQuote(priceQuote(lookup, 0.15), lookup, 0)).toBe(true);
  });

  it("stops a click when saved results expired after the price was shown", () => {
    expect(withinQuote(priceQuote(lookup, 0.15), lookup, total)).toBe(false);
    expect(withinQuote(priceQuote(lookup, 0), lookup, 0.024)).toBe(false);
  });

  it("leaves a different lookup alone: its button showed its own price", () => {
    expect(withinQuote(priceQuote(lookup, 0), "b.com|2840", total)).toBe(true);
    expect(withinQuote(priceQuote(lookup, 0), "a.com|2826", total)).toBe(true);
  });

  it("allows a link with no quote, and stops one with a broken quote", () => {
    expect(withinQuote(undefined, lookup, total)).toBe(true);
    expect(withinQuote(`${lookup}|nonsense`, lookup, total)).toBe(false);
  });
});
