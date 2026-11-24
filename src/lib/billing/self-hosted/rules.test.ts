import { describe, expect, it } from "vitest";
import { hooks } from "./hooks";
import { rules } from "./rules";

/** A copy without plans: only a workspace the operator made spends, and prices read in dollars. */
const ws = (plan: string) => ({ plan }) as never;

describe("self-hosted rules", () => {
  it("lets a workspace the operator made run paid checks, under its cap", () => {
    expect(hooks.newWorkspacePlan("operator")).toBe("internal");
    expect(rules.stateRefusal(ws("internal"), true)).toBeNull();
    expect(rules.paidWorkRefusal(ws("internal"))).toBeNull();
    expect(rules.isInternal(ws("internal"))).toBe(true);
    expect(rules.ceilingUsd(ws("internal"), 12, 50)).toBe(12);
    expect(rules.ceilingUsd(ws("internal"), null, 50)).toBe(50);
  });

  it("refuses paid work from a workspace that signed itself up", () => {
    expect(hooks.newWorkspacePlan("signup")).toBe("free");
    for (const plan of ["free", "starter", "trial", "none"]) {
      expect(rules.stateRefusal(ws(plan), true)?.code).toBe("no_plan");
      expect(rules.paidWorkRefusal(ws(plan))?.code).toBe("no_plan");
      expect(rules.isInternal(ws(plan))).toBe(false);
    }
  });

  it("has nothing for sale and no plan limits", () => {
    expect(rules.hasPlans).toBe(false);
    expect(rules.plansHref).toBeNull();
    expect(rules.newAccountLine("sign-up")).toBeNull();
    expect(rules.planFeature("rank")).toBeNull();
    expect(rules.upgradeRaises(ws("internal") as never, "projects")).toBe(false);
    expect(rules.limitsFor(ws("internal")).projects).toBe(Infinity);
  });

  it("prices in dollars, a cent at least", () => {
    expect(rules.costLabel(0)).toBe("cached, free");
    expect(rules.costLabel(0.004)).toBe("≈ $0.01");
    expect(rules.costLabel(0.256)).toBe("≈ $0.26");
    expect(rules.ceilingRefusal(ws("internal"), 30).message).toContain("$30.00");
  });

  it("says a count of credits as the dollars it is, and names no credits in copy", () => {
    expect(rules.creditsText(1)).toBe("$0.01");
    expect(rules.creditsText(76)).toBe("$0.76");
    expect(rules.creditsText(1250, { short: true })).toBe("$12.50");
    expect(rules.researchNoun).toBe("DataForSEO spend");
    expect(rules.researchScope).toBe("Can run research lookups");
    expect(rules.creditUnit).toBe("cents");
  });
});
