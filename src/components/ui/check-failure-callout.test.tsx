import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckFailureCallout } from "./check-failure-callout";

describe("CheckFailureCallout", () => {
  it("says why, what the numbers are from, and what to do, in that order", () => {
    const html = renderToStaticMarkup(<CheckFailureCallout title="Last check failed (Nov 7)" reason="None of this check's searches came back" from="Results below are from Nov 5." again="Check now runs it again." />);
    expect(html.replace(/&#x27;/g, "'")).toContain("None of this check's searches came back. Results below are from Nov 5. Check now runs it again.");
  });

  it("links to the way forward, with a plain anchor for a place on the page", () => {
    expect(renderToStaticMarkup(<CheckFailureCallout title="t" reason="r." link={{ label: "Open Project settings", href: "/projects/1/settings" }} />)).toContain('href="/projects/1/settings"');
    expect(renderToStaticMarkup(<CheckFailureCallout title="t" reason="r." link={{ label: "Start a new crawl", href: "#new-crawl" }} />)).toContain('href="#new-crawl"');
  });
});
