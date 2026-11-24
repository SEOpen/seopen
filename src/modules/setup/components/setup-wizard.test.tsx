import { describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../actions", () => ({ applySetup: vi.fn(), proposeSetup: vi.fn(), quoteBusiness: vi.fn(), readBusiness: vi.fn() }));
vi.mock("@/modules/local/components/forms", () => ({ FindListingForm: () => null }));

const { firstChecksLine } = await import("./setup-wizard");

describe("the First checks card", () => {
  it("says when each check runs on its own, and what starting one now counts against", () => {
    const line = firstChecksLine("6:00 AM");
    expect(line).toMatch(/^Start these now instead of waiting for the schedule: rankings are checked every day at 6:00 AM and AI prompts every week\. /);
    if (rules.hasPlans) expect(line).toMatch(/ They're included in your plan, within its limits\.$/);
    else {
      expect(line).toMatch(/ They count against the workspace's monthly DataForSEO cap\.$/);
      expect(line).not.toMatch(/\bplan\b/i);
    }
  });
});
