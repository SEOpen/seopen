import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FREE_PLAN_REFUSAL } from "@/lib/billing/spend";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../actions", () => ({ runNow: async () => ({ ok: true, message: "" }) }));

const { RunButton } = await import("./run-controls");

const button = (refused?: string | null) => renderToStaticMarkup(<RunButton projectId={1} estimateUsd={null} credits={76} answers={12} refused={refused} first />).replace(/&#x27;/g, "'");

describe("Run now", () => {
  it("is off with the plan's reason on Free, which asks no AI questions", () => {
    const html = button(FREE_PLAN_REFUSAL.message);
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain(`title="${FREE_PLAN_REFUSAL.message}"`);
  });

  it("is on otherwise", () => {
    expect(button(null)).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("shows its price in research credits, not dollars, to a customer, and in dollars without plans", () => {
    const html = button(null);
    if (rules.hasPlans) {
      expect(html).toContain("Run now (≈ 76 credits)");
      expect(html).not.toMatch(/\$\d/);
    } else {
      expect(html).toContain("Run now (≈ $0.76)");
      expect(html).not.toContain("credit");
    }
  });

  it("adds the dollars for the owner's workspace, and says them once without plans", () => {
    const html = renderToStaticMarkup(<RunButton projectId={1} estimateUsd={0.76} credits={76} answers={12} first />);
    expect(html).toContain(rules.hasPlans ? "Run now (≈ 76 credits · $0.76)" : "Run now (≈ $0.76)");
  });
});
