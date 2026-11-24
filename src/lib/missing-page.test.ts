import { describe, expect, it } from "vitest";
import { missingPage } from "./missing-page";

describe("missingPage", () => {
  it.each([
    ["/rank/123", "This keyword isn't in the current project.", "/rank", "Back to Rankings"],
    ["/local/9", "This business isn't in the current project.", "/local", "Back to Local SEO"],
    ["/ai/prompts/4", "This prompt isn't in the current project.", "/ai/prompts", "Back to Prompts"],
    ["/audit/issues/nope", "This issue isn't in the current project.", "/audit", "Back to Site audit"],
    ["/keywords/lists/2", "This list isn't in the current project.", "/keywords/lists", "Back to Keyword lists"],
    ["/projects/8/settings", "This project isn't in your workspace.", "/", "All projects"],
  ])("sends %s back to what's there", (path, message, href, label) => {
    const page = missingPage(path);
    expect(page.message).toContain(message);
    expect(page.back).toEqual({ href, label });
  });

  it("has a way back from anywhere else in the app", () => {
    expect(missingPage("/rank/settings/x/y").back.href).toBe("/rank");
    expect(missingPage("/billing/whatever").back).toEqual({ href: "/", label: "Back to Overview" });
  });
});
