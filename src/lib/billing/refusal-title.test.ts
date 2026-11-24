import { describe, expect, it } from "vitest";
import { rules } from "@/plan-policy/rules";
import { REFUSAL_TITLES } from "./errors";
import { refusalTitle } from "./refusal-title";

describe("refusalTitle", () => {
  it.skipIf(!rules.hasPlans)("is the plan's title on getseopen.com", () => {
    expect(refusalTitle("no_plan")).toBe("No active plan");
    expect(refusalTitle("credits")).toBe("Research credits used up");
  });

  it.skipIf(rules.hasPlans)("names no plan or credits on a copy without plans", () => {
    expect(refusalTitle("no_plan")).toBe("Paid checks are off");
    expect(refusalTitle("credits")).toBe("Research budget used");
  });

  it("keeps the shared titles, and falls back for a code it doesn't know", () => {
    expect(refusalTitle("ceiling")).toBe(REFUSAL_TITLES.ceiling);
    expect(refusalTitle("suspended")).toBe(REFUSAL_TITLES.suspended);
    expect(refusalTitle("something_new")).toBe("Paused");
  });
});
