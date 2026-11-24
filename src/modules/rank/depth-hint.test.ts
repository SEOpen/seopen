import { describe, expect, it } from "vitest";
import { rules } from "@/plan-policy/rules";
import { depthHint, depthHintSince, type DepthHintInput } from "./depth-hint";

const row = (id: number, keyword: string, position: number | null, checked = true) => ({ id, keyword, position, checked });
const settings = { dailyDepth: 20, sweepDepth: 100, sweepWeekday: 0, enabled: true };
const input = (over: Partial<DepthHintInput> = {}): DepthHintInput => ({
  rows: [row(1, "seo tool", null), row(2, "rank tracker", null), row(3, "site audit", 4), row(4, "new one", null, false)],
  deepestLook: new Map([
    [1, 20],
    [2, 20],
    [3, 20],
  ]),
  searchConsole: new Map([
    ["seo tool", 67.4],
    ["rank tracker", 87.2],
    ["site audit", 5],
    ["new one", 90],
  ]),
  settings,
  ...over,
});

describe("depthHint", () => {
  it("counts keywords with no position that Search Console has past the daily depth, and the depth that covers them", () => {
    const h = depthHint(input())!;
    expect(h).toMatchObject({ keywords: 2, deepest: 87, depth: 20, suggestedDepth: 100, covered: 2, unitsNow: 2, unitsSuggested: 10, projectKeywords: 4, sweepDepth: 100, sweepCovers: 2, lookedAlready: 0 });
    expect(h.message).toBe(
      "2 keywords with no position here average past the top 20 in Search Console over the last 28 days, down to #87. The daily check only reads the top 20. " +
        (rules.hasPlans
          ? "Checking the top 100 would read as deep as all their averages. Each keyword would then count as 10 toward your plan's keyword limit instead of 2, one for each 10 results checked, so this project's 4 keywords would count as 40 instead of 8. "
          : "Checking the top 100 would read as deep as all their averages. Each keyword's daily check would then read 10 pages of 10 results instead of 2, and DataForSEO charges for every page. ") +
        "The weekly check reads the top 100, so they may show a position after its next run.",
    );
  });

  it("picks the shallowest allowed depth that covers the deepest", () => {
    const h = depthHint(input({ searchConsole: new Map([["seo tool", 24], ["rank tracker", 29.6]]) }))!;
    expect(h.suggestedDepth).toBe(30);
    expect(h.unitsSuggested).toBe(3);
    expect(depthHint(input({ searchConsole: new Map([["seo tool", 30.4]]) }))!.suggestedDepth).toBe(50);
  });

  it("leaves out keywords found, never checked, with no Search Console data, or within the depth", () => {
    expect(depthHint(input({ searchConsole: new Map([["site audit", 50], ["new one", 50], ["seo tool", 18]]) }))).toBeNull();
    expect(depthHint(input({ searchConsole: new Map() }))).toBeNull();
  });

  it("says when the deepest is past every depth a daily check reads", () => {
    const h = depthHint(input({ searchConsole: new Map([["seo tool", 140]]), settings: { ...settings, dailyDepth: 100, sweepDepth: 100 } }))!;
    expect(h.suggestedDepth).toBeNull();
    expect(h.sweepDepth).toBeNull();
    expect(h.message).toBe("1 keyword with no position here averages #140 in Search Console over the last 28 days, past the top 100 the daily check reads. That's past the top 100, the deepest a daily check reads.");
  });

  it("covers what it can when some are past the top 100", () => {
    const h = depthHint(input({ searchConsole: new Map([["seo tool", 67], ["rank tracker", 130]]) }))!;
    expect(h).toMatchObject({ suggestedDepth: 100, covered: 1, sweepCovers: 1 });
    expect(h.message).toContain("Checking the top 100 would read as deep as the averages of 1 of them.");
    expect(h.message).toContain("so 1 of them may show a position after its next run.");
  });

  it("says nothing of the weekly check when it's off, turned off with the tracker, or no deeper", () => {
    for (const s of [{ sweepWeekday: -1 }, { enabled: false }, { sweepDepth: 20 }]) {
      const h = depthHint(input({ settings: { ...settings, ...s } }))!;
      expect(h.sweepDepth).toBeNull();
      expect(h.message).not.toContain("weekly");
    }
  });

  it("says when a check already read deep enough and didn't find them, instead of promising the weekly one", () => {
    const h = depthHint(input({ deepestLook: new Map([[1, 100], [2, 20]]) }))!;
    expect(h).toMatchObject({ keywords: 2, lookedAlready: 1, sweepCovers: 1 });
    // Reading that deep isn't a promise to find one a check already missed.
    expect(h.message).toContain("Checking the top 100 would read as deep as all their averages.");
    expect(h.message).not.toContain("cover them all");
    expect(h.message).toContain("so 1 of them may show a position after its next run.");
    expect(h.message).toContain("1 of them didn't turn up in a check that read deep enough in the last 28 days either. Search Console averages every country and device, so a deeper daily check may not find it here.");
    const all = depthHint(input({ deepestLook: new Map([[1, 100], [2, 100]]) }))!;
    expect(all.sweepCovers).toBe(0);
    expect(all.message).not.toContain("weekly");
    expect(all.message).toContain("They didn't turn up");
  });

  it("starts its window 28 days back, counting the check's own day", () => {
    expect(depthHintSince("2026-11-15")).toBe("2026-10-19");
  });
});
