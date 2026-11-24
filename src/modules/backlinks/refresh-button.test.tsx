import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefreshButton } from "./refresh-button";

const button = (refused?: string) => renderToStaticMarkup(<RefreshButton cost="≈ 5 credits" target="example.com" refused={refused} />);

describe("Backlinks Refresh", () => {
  it("is off while the workspace can't spend, and says why on the button", () => {
    const html = button("This workspace is suspended.");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."/);
    expect(html).not.toContain("Bypass the saved data");
  });

  it("is on otherwise, and says what it does", () => {
    const html = button();
    expect(html).not.toMatch(/type="button"[^>]*\bdisabled=""/);
    expect(html).toContain('title="Bypass the saved data and fetch fresh numbers"');
  });
});
