import { describe, expect, it } from "vitest";
import { DOCS_ORDER, MODULE_DOCS } from "@/lib/docs";
import { docsHelpHref, edgeFade, revealLeft, TAB_FADE_PX, tabHref } from "./tab-href";

describe("edgeFade", () => {
  it("shows nothing when the whole row fits", () => {
    expect(edgeFade(0, 300, 300)).toBe("none");
  });
  it("marks the edges with more off-screen", () => {
    expect(edgeFade(0, 800, 300)).toBe("end");
    expect(edgeFade(200, 800, 300)).toBe("both");
    expect(edgeFade(500, 800, 300)).toBe("start");
  });
  it("allows for a fractional scroll position at either end", () => {
    expect(edgeFade(0.5, 800, 300)).toBe("end");
    expect(edgeFade(499.5, 800, 300)).toBe("start");
  });
});

describe("revealLeft", () => {
  it("leaves the row alone when the tab is already clear", () => {
    expect(revealLeft(100, 80, 0, 300)).toBe(0);
    expect(revealLeft(300, 80, 200, 300)).toBe(200);
  });
  it("scrolls right just enough for a tab off the end, clear of the fade", () => {
    expect(revealLeft(400, 80, 0, 300)).toBe(400 + 80 + TAB_FADE_PX - 300);
  });
  it("scrolls back just enough for a tab off the start, stopping at zero", () => {
    expect(revealLeft(100, 80, 250, 300)).toBe(100 - TAB_FADE_PX);
    expect(revealLeft(0, 80, 250, 300)).toBe(0);
  });
  it("shows the start of a tab too wide to fit", () => {
    expect(revealLeft(400, 500, 0, 300)).toBe(400 - TAB_FADE_PX);
  });
});

describe("tabHref", () => {
  it("carries the page's query", () => {
    expect(tabHref("/rank/pages", "range=30&tag=a")).toBe("/rank/pages?range=30&tag=a");
  });
  it("never carries run, which spends", () => {
    expect(tabHref("/keywords/ideas", "q=coffee&run=1")).toBe("/keywords/ideas?q=coffee");
    expect(tabHref("/keywords/ideas", "run=1")).toBe("/keywords/ideas");
  });
  it("leaves a tab's own query alone", () => {
    expect(tabHref("/gsc?days=28", "run=1")).toBe("/gsc?days=28");
  });
});

describe("docsHelpHref", () => {
  it("points each module's tab row at its docs page", () => {
    expect(docsHelpHref("/audit")).toBe("/docs/features/site-audit");
    expect(docsHelpHref("/backlinks")).toBe("/docs/features/backlinks");
    expect(docsHelpHref("/rank")).toBe("/docs/features/rankings");
    expect(docsHelpHref("/gsc")).toBe("/docs/features/search-console");
    expect(docsHelpHref("/ai")).toBe("/docs/features/ai-visibility");
  });
  it("points the modules with no tab row at theirs, for the page header", () => {
    expect(docsHelpHref("/ga4")).toBe("/docs/features/analytics");
    expect(docsHelpHref("/local")).toBe("/docs/features/local-seo");
    expect(docsHelpHref("/fixes")).toBe("/docs/features/fixes");
  });
  it("matches a whole segment only", () => {
    expect(docsHelpHref("/localize")).toBeNull();
    expect(docsHelpHref("/ga4x")).toBeNull();
    expect(docsHelpHref("/constructor")).toBeNull();
  });
  it("drops the tab's query, so run can't travel", () => {
    expect(docsHelpHref("/domains?q=a.com&loc=2840")).toBe("/docs/features/domain-analysis");
    expect(docsHelpHref("/keywords?q=coffee&run=1")).toBe("/docs/features/keyword-research");
  });
  it("has nothing for a row with no docs page", () => {
    expect(docsHelpHref("/settings")).toBeNull();
    expect(docsHelpHref("/rankings")).toBeNull();
    expect(docsHelpHref("/")).toBeNull();
    expect(docsHelpHref(undefined)).toBeNull();
  });
  it("only names pages the docs have", () => {
    const slugs = DOCS_ORDER.map((p) => p.slug);
    for (const slug of Object.values(MODULE_DOCS)) expect(slugs).toContain(slug);
  });
});
