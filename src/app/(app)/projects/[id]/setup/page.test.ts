import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("@/lib/projects", () => ({ getProject: async () => ({ id: 4, workspaceId: 7, name: "Mill Town", domain: "milltown.com", archived: false }) }));
vi.mock("@/lib/billing/workspace", () => ({ loadBillingWorkspace: async () => ({ plan: "free" }) }));
// Free is the one way to the plan callout; a copy without plans never says a workspace is on it.
vi.mock("@/lib/billing/gates", () => ({ isFree: () => true }));
vi.mock("@/modules/setup/gather", () => ({ setupState: async () => null }));
vi.mock("@/modules/setup/components/setup-wizard", () => ({ SetupWizard: () => null }));

const { default: ProjectSetupPage } = await import("./page");

const html = async () => renderToStaticMarkup(await ProjectSetupPage({ params: Promise.resolve({ id: "4" }) } as Parameters<typeof ProjectSetupPage>[0]));

describe("guided setup on the Free plan", () => {
  it.skipIf(!rules.hasPlans)("offers a plan on Billing", async () => {
    const page = await html();
    expect(page).toContain("Guided setup comes with a paid plan");
    expect(page).toMatch(/<a [^>]*href="\/billing"[^>]*>Choose a plan<\/a>/);
  });

  it.skipIf(rules.hasPlans)("links to no Billing page on a copy without plans", async () => {
    const page = await html();
    expect(page).not.toContain("/billing");
    expect(page).not.toContain("Choose a plan");
  });
});
