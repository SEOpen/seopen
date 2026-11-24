import { describe, expect, it, vi } from "vitest";
import { coverSearches, termSet } from "./coverage";

vi.mock("server-only", () => ({}));

const { basicsOf, checklistOf, refreshesPage, refreshHref, refreshSentence } = await import("./refresh");

const span = "Search Console, Oct 18 to Nov 14, 2026";
const live = { from: "live" as const, at: "2026-11-15T12:00:00.000Z", status: 200, title: "Drain Cleaning | Fernhill", h1: "Drain cleaning in Salem", headings: [], words: 400, note: null };
const words = termSet(live.title, live.h1, "We clear blocked drains and sewer lines.");
const searches = coverSearches(
  [
    { query: "salem plumber", impressions: 900, clicks: 5, position: 7 },
    { query: "drain cleaning", impressions: 600, clicks: 9, position: 4 },
    { query: "sewer camera inspection", impressions: 300, clicks: 0, position: 14 },
  ],
  words,
);
const crawl = { crawlId: 1, at: "2026-11-10T08:00:00.000Z", title: live.title, h1: live.h1, words: 400, linksIn: 1, medianLinksIn: 6 };

describe("basicsOf", () => {
  const basics = basicsOf({ main: searches.find((s) => s.query === "salem plumber")!, searches, page: live, crawl, span, domain: "fernhill.example", timeZone: "UTC" });
  const by = Object.fromEntries(basics.map((b) => [b.id, b]));

  it("checks the main search against the title and the H1, with the data behind it", () => {
    expect(by.main_in_title).toMatchObject({ ok: false, finding: "The title is missing “salem”, “plumber” from “salem plumber”." });
    expect(by.main_in_h1).toMatchObject({ ok: false, finding: "The H1 is missing “plumber” from “salem plumber”." });
    expect(by.main_in_title.evidence).toBe(`Main search “salem plumber”: 900 impressions at average position 7.0, ${span}. Page from the live page, read Nov 15, 2026.`);
  });

  it("says a page gets few links in against the crawl's median", () => {
    expect(by.links_in).toMatchObject({ ok: false, finding: "1 internal link points to this page, where the site's typical page gets 6. Under 3 reads as few.", evidence: "Site audit crawl finished Nov 10, 2026." });
  });

  it("says why a page below the typical count isn't flagged (QA B9)", () => {
    const [links] = basicsOf({ main: null, searches: [], page: live, crawl: { ...crawl, linksIn: 8, medianLinksIn: 12 }, span: null, domain: "fernhill.example", timeZone: "UTC" });
    expect(links).toMatchObject({ id: "links_in", ok: true, finding: "8 internal links point to this page, where the site's typical page gets 12. That's fewer than the typical page, but only under 3 reads as few, so it isn't flagged." });
  });

  it("leaves the main-search checks out with no Search Console data, and the links check with no crawl", () => {
    expect(basicsOf({ main: null, searches: [], page: live, crawl: null, span: null, domain: "fernhill.example", timeZone: "UTC" })).toEqual([]);
  });
});

describe("checklistOf", () => {
  it("turns missing and partly covered searches, open questions and failed basics into tasks", () => {
    const basics = basicsOf({ main: searches[0], searches, page: live, crawl, span, domain: "fernhill.example", timeZone: "UTC" });
    const questions = { state: "ready" as const, keyword: "salem plumber", at: "2026-11-15T12:00:00.000Z", cached: true, questions: [{ question: "How much does a drain cleaning cost?", label: "partly" as const, absent: ["cost"], fits: true }, { question: "Is drain cleaning worth it?", label: "covered" as const, absent: [], fits: true }, { question: "Is a plumbing license hard to get?", label: "missing" as const, absent: ["license", "hard", "get"], fits: false }] };
    const list = checklistOf({ searches, questions, basics, span, timeZone: "UTC" });
    expect(list.map((c) => c.task)).toEqual([
      "Cover “sewer camera inspection”: a section or heading that answers it, if it fits the page.",
      "Use “plumber” where it reads naturally, for “salem plumber”.",
      "Answer “How much does a drain cleaning cost?” on the page.",
      ...basics.filter((b) => !b.ok).map((b) => ({ main_in_title: "Put the main search in the title.", main_in_h1: "Put the main search in the H1.", title_intents: "Aim the title at one search.", links_in: "Link to this page from related pages on the site." })[b.id]),
    ]);
    expect(list[0].evidence).toBe(`300 impressions at average position 14.0, ${span}. Not on the page.`);
    expect(list[1].evidence).toBe(`900 impressions at average position 7.0, ${span}. The page has “salem”.`);
    expect(list[2].evidence).toBe("People also ask for “salem plumber”, Google results from Nov 15, 2026.");
  });
});

describe("checklistOf, with a search another page owns", () => {
  it("leaves a search another page leads for off the list", () => {
    const owned = searches.map((x) => (x.query === "sewer camera inspection" ? { ...x, ownedBy: { page: "https://fernhill.example/sewer-inspection/", impressions: 1200, position: 3 } } : x));
    const list = checklistOf({ searches: owned, questions: { state: "no_search" }, basics: [], span, timeZone: "UTC" });
    expect(list.map((c) => c.task)).toEqual(["Use “plumber” where it reads naturally, for “salem plumber”."]);
  });
});

describe("refreshSentence", () => {
  const counts = { covered: 1, partly: 1, missing: 1 };
  const range = { start: "2026-10-18", end: "2026-11-14" };
  it("says how many searches the page misses", () => {
    expect(refreshSentence({ range, page: live, searches, counts })).toBe("This page showed for three searches in the last 28 days: one isn't on the page and one is partly covered.");
    expect(refreshSentence({ range, page: live, searches, counts: { covered: 3, partly: 0, missing: 0 } })).toBe("This page showed for three searches in the last 28 days, and its text covers every one.");
    expect(refreshSentence({ range: null, page: live, searches: [], counts })).toMatch(/no data/);
    expect(refreshSentence({ range, page: { ...live, from: null }, searches: [], counts })).toMatch(/couldn't read/);
  });

  it("counts the days stored when Search Console data starts inside the 28", () => {
    expect(refreshSentence({ range: { start: "2026-10-28", end: "2026-11-14" }, page: live, searches, counts })).toMatch(/^This page showed for three searches in the last 18 days:/);
    expect(refreshSentence({ range: { start: "2026-11-14", end: "2026-11-14" }, page: live, searches: [], counts })).toBe("This page had no Search Console impressions in the last day.");
  });
});

describe("links", () => {
  it("opens the panel for page-content fixes", () => {
    expect(refreshHref("https://a.example/x?y=1")).toBe("/fixes/refresh?url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1");
    expect(refreshesPage("gsc-striking-distance")).toBe(true);
    expect(refreshesPage("title-too-long")).toBe(false);
  });
});
