import { describe, expect, it } from "vitest";
import { costLabel, maxCostLabel } from "./format";
import { hasSearchOperators, quoteLabel, type LookupQuote } from "./lookup-quote";
import { keywordLookupQuote } from "./requests";
import { rules } from "@/plan-policy/rules";

const form = (...pairs: [string, string][]) => new URLSearchParams(pairs);

describe("quoteLabel, flat", () => {
  it("says the one price whatever is typed", () => {
    expect(quoteLabel({ kind: "flat", label: "≈ 2 credits" }, form(["q", "anything"]))).toBe("≈ 2 credits");
  });
});

describe("quoteLabel, keyword research", () => {
  const quote = keywordLookupQuote({ locationCode: 2840, languageCode: "en" });

  it.skipIf(!rules.hasPlans)("prices a phrase with no city as the metrics and the top 10", () => {
    expect(quoteLabel(quote, form(["q", "coffee"], ["loc", "2840"], ["city", "0"], ["run", "1"]))).toBe("≈ 2 credits");
  });

  it.skipIf(!rules.hasPlans)("adds the city's search volume once a city is picked", () => {
    expect(quoteLabel(quote, form(["q", "coffee"], ["loc", "2840"], ["city", "1014221"], ["run", "1"]))).toBe("≈ 11 credits");
  });

  it.skipIf(!rules.hasPlans)("charges for the city even with no phrase typed yet, so the price doesn't jump on the first letter", () => {
    expect(quoteLabel(quote, form(["q", ""], ["city", "1014221"]))).toBe("≈ 11 credits");
  });

  it.skipIf(!rules.hasPlans)("leaves the city's search volume out when Google Ads refuses the phrase, since it's never asked", () => {
    expect(quoteLabel(quote, form(["q", "x".repeat(81)], ["city", "1014221"]))).toBe("≈ 2 credits");
  });

  it.skipIf(!rules.hasPlans)("costs more with a search operator", () => {
    expect(hasSearchOperators("site:example.com coffee")).toBe(true);
    expect(quoteLabel(quote, form(["q", "site:example.com coffee"], ["city", "0"]))).toBe("≈ 4 credits");
    expect(quoteLabel(quote, form(["q", "intitle:coffee"], ["city", "1014221"]))).toBe("≈ 13 credits");
  });

  it("is never free, because a changed form is a new lookup", () => {
    for (const q of ["coffee", "site:example.com"]) for (const city of ["0", "1014221"]) expect(quoteLabel(quote, form(["q", q], ["city", city]))).not.toBe(costLabel(0));
  });
});

describe("quoteLabel, keyword gap", () => {
  const prices = (each: number) => Array.from({ length: 5 }, (_, n) => maxCostLabel(each * Math.max(n, 2)));
  const quote: LookupQuote = { kind: "keywordGap", byLimit: { "100": prices(0.024), "500": prices(0.072), "1000": prices(0.132) } };
  const gap = (limit: string, q: string, ...vs: string[]) => form(["q", q], ...vs.map((d): [string, string] => ["vs", d]), ["limit", limit]);

  it.skipIf(!rules.hasPlans)("follows the number of domains", () => {
    expect(quoteLabel(quote, gap("500", "you.com", "a.com", "", ""))).toBe("≈ 15 credits max");
    expect(quoteLabel(quote, gap("500", "you.com", "a.com", "b.com", ""))).toBe("≈ 22 credits max");
    expect(quoteLabel(quote, gap("500", "you.com", "a.com", "b.com", "c.com"))).toBe("≈ 29 credits max");
  });

  it.skipIf(!rules.hasPlans)("follows the selected limit", () => {
    expect(quoteLabel(quote, gap("100", "you.com", "a.com", "b.com", "c.com"))).toBe("≈ 10 credits max");
    expect(quoteLabel(quote, gap("1000", "you.com", "a.com", "b.com", "c.com"))).toBe("≈ 53 credits max");
  });

  it.skipIf(!rules.hasPlans)("says the smallest comparison until there are two domains", () => {
    expect(quoteLabel(quote, gap("500", "", "", "", ""))).toBe("≈ 15 credits max");
    expect(quoteLabel(quote, gap("500", "you.com", "", "", ""))).toBe("≈ 15 credits max");
  });

  it.skipIf(!rules.hasPlans)("counts a domain once, and not your own", () => {
    expect(quoteLabel(quote, gap("500", "you.com", "a.com", "A.com", "you.com"))).toBe("≈ 15 credits max");
  });

  it.skipIf(!rules.hasPlans)("stops at the four domains the page looks up", () => {
    expect(quoteLabel(quote, gap("500", "you.com", "a.com, b.com, c.com", "d.com", "e.com"))).toBe("≈ 29 credits max");
  });

  it.skipIf(!rules.hasPlans)("takes the dearest limit for one it doesn't know, never a lower price", () => {
    expect(quoteLabel(quote, gap("7", "you.com", "a.com", "b.com", "c.com"))).toBe("≈ 53 credits max");
  });
});

describe("quoteLabel, link gap", () => {
  const each = 0.0312;
  const quote: LookupQuote = { kind: "linkGap", byCount: Array.from({ length: 6 }, (_, n) => maxCostLabel(each * (n || 5))) };
  const gap = (vs: string) => form(["q", "you.com"], ["run", "1"], ["vs", vs]);

  it.skipIf(!rules.hasPlans)("charges per competitor, not for your own domain", () => {
    expect(quoteLabel(quote, gap("a.com"))).toBe("≈ 4 credits max");
    expect(quoteLabel(quote, gap("a.com, b.com c.com"))).toBe("≈ 10 credits max");
    expect(quoteLabel(quote, gap("a.com, you.com"))).toBe("≈ 4 credits max");
  });

  it.skipIf(!rules.hasPlans)("stops at the five the page looks up", () => {
    expect(quoteLabel(quote, gap("a.com, b.com, c.com, d.com, e.com"))).toBe("≈ 16 credits max");
    expect(quoteLabel(quote, gap("a.com, b.com, c.com, d.com, e.com, f.com, g.com"))).toBe("≈ 16 credits max");
  });

  it.skipIf(!rules.hasPlans)("gives a cleared field the price the server set for it", () => {
    expect(quoteLabel(quote, gap(""))).toBe("≈ 16 credits max");
  });
});

describe("maxCostLabel", () => {
  it.skipIf(!rules.hasPlans)("marks a price as a ceiling and leaves free alone", () => {
    expect(maxCostLabel(0.072)).toBe("≈ 8 credits max");
    expect(maxCostLabel(0)).toBe("cached, free");
  });
});
