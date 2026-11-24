import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIGHTHOUSE_PRICE_USD, priceText } from "../transform";
import { LighthouseButton } from "./lighthouse-button";

const REASON = "This workspace is suspended.";
const button = (props: { queued?: boolean; refused?: string }) => renderToStaticMarkup(<LighthouseButton queued={false} showCost={false} {...props} />);

describe("Run Lighthouse", () => {
  it("is off while the workspace can't spend, and says why on the button", () => {
    const html = button({ refused: REASON });
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."[^>]*>Run Lighthouse/);
    // Nothing beside it repeats the banner.
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });

  it("is off while a run is queued, with no reason to give", () => {
    const html = button({ queued: true });
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*>Run Lighthouse/);
    expect(html).not.toContain("title=");
  });

  it("is on otherwise", () => {
    expect(button({})).not.toMatch(/type="button"[^>]*\bdisabled=""/);
  });

  it("shows Lighthouse's price where the workspace sees dollars", () => {
    const html = renderToStaticMarkup(<LighthouseButton queued={false} showCost />);
    expect(html).toContain(`Run Lighthouse (≈ ${priceText(LIGHTHOUSE_PRICE_USD)})`);
    expect(html).toContain("Run Lighthouse (≈ $0.005)");
    expect(button({})).not.toContain("$");
  });
});
