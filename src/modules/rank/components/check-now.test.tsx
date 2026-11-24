import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckNowForm } from "./check-now";

vi.mock("../actions", () => ({ checkNow: vi.fn() }));

const form = (refused?: string, hasResults = true) =>
  renderToStaticMarkup(<CheckNowForm projectId={1} keywords={3} dailyDepth={10} sweepDepth={100} quickUsd={null} deepUsd={null} busy={false} hasResults={hasResults} refused={refused} />);
const offButtons = (html: string) => (html.match(/<button[^>]*\bdisabled=""[^>]*title=/g) ?? []).length;

describe("CheckNowForm", () => {
  it("turns both buttons off while the workspace can't spend, and says why on them", () => {
    for (const hasResults of [true, false]) {
      const html = form("This workspace is suspended.", hasResults);
      expect(offButtons(html)).toBe(2);
      expect(html).toContain('title="This workspace is suspended."');
      // Nothing beside them repeats the banner.
      expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
    }
  });

  it("leaves them on otherwise", () => {
    expect(offButtons(form())).toBe(0);
  });
});
