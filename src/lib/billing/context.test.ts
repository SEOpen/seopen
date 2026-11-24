import { describe, expect, it } from "vitest";
import { countsAsResearch, onPlanMeter, onResearchMeter } from "./context";

const RESEARCH = new Set(["keywords", "local"]);

describe("which meter a call is charged to", () => {
  it("goes by module outside any meter", () => {
    expect(countsAsResearch("keywords", RESEARCH)).toBe(true);
    expect(countsAsResearch("ai", RESEARCH)).toBe(false);
  });

  it("puts a research module on the plan under onPlanMeter", () => {
    expect(onPlanMeter(() => countsAsResearch("keywords", RESEARCH))).toBe(false);
  });

  it("puts any module on research credits under onResearchMeter, as a hand-started AI run is", () => {
    expect(onResearchMeter(() => countsAsResearch("ai", RESEARCH))).toBe(true);
  });
});
