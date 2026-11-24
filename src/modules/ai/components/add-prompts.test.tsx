import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

/** Suggest prompts spends research credits, so it's off with the reason when they've run out. */

vi.mock("../actions", () => ({ addPrompts: vi.fn(), suggestPrompts: vi.fn() }));

const { AddPrompts } = await import("./add-prompts");

const props = { projectId: 1, rates: { perAnswer: {}, aio: 0 }, currentMonthly: 0, fixedMonthly: 0, ownDomains: ["example.com"], topics: [], showCost: false };
/** The Suggest prompts button's opening tag. */
const suggestButton = (html: string) => html.match(/<button[^>]*>[^<]*Suggest prompts[^<]*/)?.[0] ?? "";

describe("Suggest prompts", () => {
  it.skipIf(!rules.hasPlans)("shows its price and can be clicked with credits left", () => {
    const button = suggestButton(renderToStaticMarkup(<AddPrompts {...props} />));
    expect(button).toContain("Suggest prompts (≈ 5 credits max)");
    expect(button).not.toContain(' disabled=""');
  });

  it("is off, with the reason as its title, when research credits are gone", () => {
    const reason = "This month's research credits are used up.";
    const button = suggestButton(renderToStaticMarkup(<AddPrompts {...props} suggestRefused={reason} />));
    expect(button).toContain(' disabled=""');
    expect(button).toContain(`title="${reason.replaceAll("'", "&#x27;")}"`);
  });
});
