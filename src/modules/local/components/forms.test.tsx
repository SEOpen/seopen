import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckNowForm } from "./forms";

vi.mock("../actions", () => ({ addBusiness: vi.fn(), addKeywords: vi.fn(), checkNow: vi.fn(), findListings: vi.fn(), removeBusiness: vi.fn(), updateBusiness: vi.fn() }));
// Upgrade now posts to a billing action that only loads on the server.
vi.mock("@/components/plan-upgrade", () => ({ UpgradeNow: () => null }));

const form = (refused?: string) => renderToStaticMarkup(<CheckNowForm projectId={1} businessId={1} gridSize={5} keywords={1} busy={false} hasResults={false} showUsd={false} refused={refused} />);

describe("Local's Check now while the workspace can't spend", () => {
  it("is off and says why on the button", () => {
    const html = form("This workspace is suspended.");
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."/);
  });

  it("is on otherwise", () => {
    expect(form()).not.toMatch(/<button[^>]*\bdisabled=""/);
  });
});
