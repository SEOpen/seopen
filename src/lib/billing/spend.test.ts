import { describe, expect, it } from "vitest";
import { BudgetExceededError, SpendRefusedError } from "./errors";
import { ceilingExceeded, ceilingRefusal, manualRunCreditsRefusal, pauseMessage } from "./spend";
import { rules } from "@/plan-policy/rules";

describe("ceilingExceeded", () => {
  it("shows the internal workspace dollars and DataForSEO", () => {
    const err = ceilingExceeded({ id: 1, plan: "internal" }, 70, 75, 8);
    expect(err).not.toBeInstanceOf(SpendRefusedError);
    expect(err.message).toContain("DataForSEO");
    expect(err.message).toContain("$8.00");
    expect(err.message).toContain("$70.00 of $75.00");
  });

  it.skipIf(!rules.hasPlans)("tells a trial workspace to upgrade, with no spend figures", () => {
    const err = ceilingExceeded({ id: 7, plan: "trial" }, 2.5, 3, 1);
    expect(err).toBeInstanceOf(SpendRefusedError);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const refused = err as SpendRefusedError;
    expect(refused.workspaceId).toBe(7);
    expect(refused.refusal).toMatchObject({ code: "ceiling", upgradable: true });
    expect(err.message).toContain("Upgrade now");
    expect(err.message).not.toMatch(/DataForSEO|\$2\.50|\$1\.00/);
  });

  it.skipIf(!rules.hasPlans)("tells a paid workspace it reached its monthly usage limit", () => {
    for (const plan of ["starter", "pro"]) {
      const err = ceilingExceeded({ id: 9, plan }, 13, 13.53, 2);
      expect(err).toBeInstanceOf(SpendRefusedError);
      expect((err as SpendRefusedError).refusal).toMatchObject({ code: "ceiling", upgradable: false });
      expect(err.message).toContain("reached its monthly usage limit");
      expect(err.message).not.toMatch(/DataForSEO|\$/);
    }
  });
});

describe("the owner's workspace at its cap", () => {
  it.skipIf(!rules.hasPlans)("counts the cap in credits, as the rest of the app does, and points to Admin → Spend for dollars", () => {
    const { message } = ceilingRefusal({ plan: "internal" }, 25);
    expect(message).toBe("This month's cap of 2,500 credits is reached. Raise it in Admin → Spend to continue.");
    expect(message).not.toContain("$");
  });

  it.skipIf(!rules.hasPlans)("rewrites a pause stored with the cap in dollars, and leaves other pauses as stored", () => {
    const state = { workspace: { id: 1, plan: "internal", status: "active", trialBlockedReason: null }, ceilingUsd: 25 };
    const stored = "This month's spend cap ($25) is reached. Raise it in Admin → Spend to continue.";
    expect(pauseMessage({ reason: "ceiling", message: stored }, state)).toBe("This month's cap of 2,500 credits is reached. Raise it in Admin → Spend to continue.");
    expect(pauseMessage({ reason: "suspended", message: "Stored words." }, state)).toBe("Stored words.");
  });

  it("gives a customer's ceiling pause the plan's words, with no figures", () => {
    const state = { workspace: { id: 2, plan: "starter", status: "active", trialBlockedReason: null }, ceilingUsd: 13.53 };
    expect(pauseMessage({ reason: "ceiling", message: "old" }, state)).toBe(ceilingRefusal({ plan: "starter" }, 13.53).message);
  });
});

describe("an AI run started by hand without enough research credits", () => {
  const ws = (plan: string) => ({ plan }) as Parameters<typeof manualRunCreditsRefusal>[0];

  it.skipIf(!rules.hasPlans)("says what the run needs and what's left, and that Monday's run still happens", () => {
    const r = manualRunCreditsRefusal(ws("starter"), 0.76, 0.403);
    expect(r).toMatchObject({ code: "credits", upgradable: false });
    expect(r.message).toBe("This run needs about 76 research credits and 40 are left. Credits reset on the 1st; the Monday run still asks every prompt.");
  });

  it.skipIf(!rules.hasPlans)("offers the upgrade on the trial and never says a negative balance", () => {
    const r = manualRunCreditsRefusal(ws("trial"), 0.76, -0.2);
    expect(r.upgradable).toBe(true);
    expect(r.message).toContain("and 0 are left. Upgrade now");
  });
});
