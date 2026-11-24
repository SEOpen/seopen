import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SerpRow } from "../transform";
import { SerpTable, shownUrl } from "./serp-table";

const row = (over: Partial<SerpRow>): SerpRow => ({ position: 1, type: "organic", domain: "sitepoint.com", url: "https://www.sitepoint.com/", title: "Top 10 Best Free Backlink Checker Tools", isProject: false, originOnly: false, breadcrumb: null, ...over });

describe("a result whose link Google hid", () => {
  it("shows Google's breadcrumb after the site", () => {
    expect(shownUrl(row({ originOnly: true, breadcrumb: "blog › backlink-checkers" }))).toBe("sitepoint.com › blog › backlink-checkers");
    expect(shownUrl(row({ originOnly: true, breadcrumb: null }))).toBe("sitepoint.com/");
    expect(shownUrl(row({ url: "https://www.sitepoint.com/backlink-checkers/" }))).toBe("sitepoint.com/backlink-checkers/");
  });

  it("says the link is the domain only, and only on those rows", () => {
    const hidden = renderToStaticMarkup(<SerpTable rows={[row({ originOnly: true, breadcrumb: "blog › backlink-checkers" })]} filename="x" />);
    expect(hidden).toContain("Domain only: Google hid the full link");
    expect(hidden).toContain("sitepoint.com › blog › backlink-checkers");
    const plain = renderToStaticMarkup(<SerpTable rows={[row({ url: "https://www.sitepoint.com/backlink-checkers/" })]} filename="x" />);
    expect(plain).not.toContain("Domain only");
  });
});
