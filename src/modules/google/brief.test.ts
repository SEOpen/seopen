import { describe, expect, it } from "vitest";
import {
  breakdownFigures,
  breakdownSentence,
  dimFigures,
  dimSentence,
  gscSource,
  inspectFigures,
  inspectSentence,
  noisyNote,
  opportunitiesSentence,
  opportunityFigures,
  plainState,
  searchConsoleSpan,
  sitemapFigures,
  sitemapsSentence,
  totalsFigures,
  totalsSentence,
  urlPath,
  pageLabels,
  type GscWindow,
} from "./brief";
import type { Totals } from "./data";

const totals = (clicks: number, impressions: number, position = 12): Totals => ({ clicks, impressions, position, ctr: impressions ? clicks / impressions : 0 });

const current = { start: "2026-10-03", end: "2026-10-30" };
const WINDOW: GscWindow = { periods: { current, previous: { start: "2026-09-05", end: "2026-10-02" } }, compare: "prev", first: "2025-01-01" };
const YEAR: GscWindow = { periods: { current, previous: { start: "2025-10-04", end: "2025-10-31" } }, compare: "yoy", first: "2025-01-01" };
const NO_COMPARE: GscWindow = { periods: { current, previous: null }, compare: "none", first: "2025-01-01" };
const FIRST_READING: GscWindow = { periods: { current, previous: null }, compare: "prev", first: "2026-10-30" };
const PARTIAL: GscWindow = { ...WINDOW, first: "2026-09-20" };

describe("totalsSentence", () => {
  it("says a move up with its window", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(1200, 40_000), prev: totals(1000, 40_000) })).toBe("Clicks are up 20%, compared with the 28 days before.");
  });

  it("says a move down and never hides it behind a good one", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(800, 50_000), prev: totals(1000, 40_000) })).toBe("Clicks are down 20%, but impressions are up 25%, compared with the 28 days before.");
  });

  it("names last year when that's the comparison", () => {
    expect(totalsSentence({ ...YEAR, cur: totals(1200, 40_000), prev: totals(1000, 40_000) })).toBe("Clicks are up 20%, compared with the same days last year.");
  });

  it("says position in plain words, better going down", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(1000, 40_000, 10), prev: totals(1000, 40_000, 14) })).toBe("Average position improved from 14.0 to 10.0, compared with the 28 days before.");
    expect(totalsSentence({ ...WINDOW, cur: totals(1000, 40_000, 14), prev: totals(1000, 40_000, 10) })).toBe("Average position slipped from 10.0 to 14.0, compared with the 28 days before.");
  });

  it("ignores position with too few impressions behind it", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(1, 5, 4), prev: totals(1, 5, 30) })).toBe("Nothing moved much, compared with the 28 days before.");
  });

  it("gives a calm answer when nothing moved", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(1000, 40_000), prev: totals(1000, 40_000) })).toBe("Nothing moved much, compared with the 28 days before.");
  });

  it("gives small counts as from and to, not a percentage", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(3, 500), prev: totals(5, 500) })).toBe("Clicks went from 5 to 3, compared with the 28 days before.");
    expect(totalsSentence({ ...WINDOW, cur: totals(50, 500), prev: totals(0, 500) })).toBe("Clicks went from 0 to 50, compared with the 28 days before.");
  });

  it("explains a first reading rather than comparing", () => {
    expect(totalsSentence({ ...FIRST_READING, cur: totals(4, 100), prev: null })).toBe("Search Console data starts Oct 30. Changes show once there's an earlier period to compare.");
  });

  it("doesn't call a half-covered period a rise", () => {
    expect(totalsSentence({ ...PARTIAL, cur: totals(1000, 40_000), prev: totals(100, 4_000) })).toBe("Search Console data starts Sep 20, so the 28 days before aren't complete. Changes show once they are.");
  });

  it("states the numbers with no compare picked", () => {
    expect(totalsSentence({ ...NO_COMPARE, cur: totals(2, 1_204), prev: null })).toBe("Two clicks from 1,204 impressions in the 28 days to Oct 30.");
  });

  it("says when nothing showed at all, about the right subject", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(0, 0), prev: totals(0, 0), subject: "this query" })).toBe("This query had no impressions in the 28 days to Oct 30.");
    expect(totalsSentence({ ...NO_COMPARE, cur: totals(0, 0), prev: null })).toBe("Your site had no impressions in the 28 days to Oct 30.");
  });

  it("still reports everything falling to nothing", () => {
    expect(totalsSentence({ ...WINDOW, cur: totals(0, 0), prev: totals(100, 2_000) })).toBe("Clicks are down 100, and impressions are down 2,000, compared with the 28 days before.");
  });
});

describe("totalsFigures", () => {
  it("reads position as better or worse and names its source", () => {
    const [clicks, impressions, ctr, position] = totalsFigures({ ...WINDOW, cur: totals(1200, 40_000, 10), prev: totals(1000, 40_000, 13.4) });
    expect(clicks).toMatchObject({ label: "Clicks", value: "1,200", delta: { text: "+20%", tone: "good" }, caption: "28 days to Oct 30, vs the 28 before" });
    expect(impressions).toMatchObject({ value: "40,000", delta: { text: "No change", tone: "muted" } });
    expect(ctr).toMatchObject({ value: "3.0%", delta: { text: "+0.5 pts", tone: "good" } });
    expect(position).toMatchObject({ label: "Search Console position", value: "10.0", delta: { text: "3.4 better", tone: "good", up: true }, position: { value: 10, previous: 13.4 } });
  });

  it("calls a worse position worse", () => {
    const position = totalsFigures({ ...WINDOW, cur: totals(1000, 40_000, 14), prev: totals(1000, 40_000, 12) })[3];
    expect(position).toMatchObject({ delta: { text: "2 worse", tone: "bad", up: false } });
  });

  it("shows small counts as absolute change", () => {
    const [clicks] = totalsFigures({ ...WINDOW, cur: totals(3, 500), prev: totals(5, 500) });
    expect(clicks).toMatchObject({ delta: { text: "−2", tone: "bad" } });
  });

  it("has no change on a first reading, and says why", () => {
    for (const f of totalsFigures({ ...FIRST_READING, cur: totals(4, 100), prev: null })) expect(f).toMatchObject({ state: "value", delta: null });
    expect(totalsFigures({ ...FIRST_READING, cur: totals(4, 100), prev: null })[0]).toMatchObject({ caption: "1 day to Oct 30, nothing earlier to compare" });
  });

  it("counts only the days history reaches", () => {
    expect(totalsFigures({ ...FIRST_READING, first: "2026-10-21", cur: totals(4, 100), prev: null })[0]).toMatchObject({ caption: "10 days to Oct 30, nothing earlier to compare" });
  });

  it("leaves the delta off a half-covered period", () => {
    const figures = totalsFigures({ ...PARTIAL, cur: totals(1000, 40_000), prev: totals(100, 4_000) });
    for (const f of figures) expect(f).toMatchObject({ delta: null });
    expect(figures[0]).toMatchObject({ caption: "28 days to Oct 30, earlier history is incomplete" });
  });

  it("gives a rate no number when there are no impressions", () => {
    const [, , ctr, position] = totalsFigures({ ...WINDOW, cur: totals(0, 0), prev: totals(0, 0) });
    expect(ctr).toMatchObject({ state: "empty", text: "No impressions in this period." });
    expect(position).toMatchObject({ state: "empty", label: "Search Console position" });
  });
});

describe("dimSentence", () => {
  const moved = (clicksDelta: number | null) => ({ clicksDelta });

  it("counts both ways, then one way", () => {
    expect(dimSentence([moved(3), moved(1), moved(-1), moved(0)], "query", WINDOW)).toBe("Two queries brought more clicks and one brought fewer, compared with the 28 days before.");
    expect(dimSentence([moved(3)], "page", WINDOW)).toBe("One page brought more clicks, compared with the 28 days before.");
    expect(dimSentence([moved(-2), moved(-1)], "page", WINDOW)).toBe("Two pages brought fewer clicks, compared with the 28 days before.");
  });

  it("is calm when nothing moved", () => {
    expect(dimSentence([moved(0)], "query", WINDOW)).toBe("Clicks held steady on every query, compared with the 28 days before.");
  });

  it("says how many there are with nothing to compare", () => {
    expect(dimSentence([moved(null)], "query", FIRST_READING)).toBe("One query showed your site in the 1 day to Oct 30.");
    expect(dimSentence([moved(null), moved(null)], "page", NO_COMPARE)).toBe("Two pages showed in search in the 28 days to Oct 30.");
    expect(dimSentence([], "query", WINDOW)).toBe("No queries in the 28 days to Oct 30.");
  });

  it("counts the ones that had clicks then and no row now as fewer", () => {
    expect(dimSentence([moved(0), moved(0)], "page", WINDOW, 1)).toBe("One page brought fewer clicks, compared with the 28 days before.");
    expect(dimSentence([moved(2), moved(0)], "page", WINDOW, 1)).toBe("One page brought more clicks and one brought fewer, compared with the 28 days before.");
    expect(dimSentence([moved(-1)], "query", WINDOW, 2)).toBe("Three queries brought fewer clicks, compared with the 28 days before.");
    expect(dimSentence([], "page", WINDOW, 2)).toBe("Two pages brought fewer clicks, compared with the 28 days before.");
  });

  it("ignores them when the period before can't be compared", () => {
    expect(dimSentence([moved(null)], "page", PARTIAL, 2)).toBe("One page showed in search in the 28 days to Oct 30.");
    expect(dimSentence([], "page", PARTIAL, 2)).toBe("No pages in the 28 days to Oct 30.");
  });

  it("speaks only for the rows read when the list stops at its limit", () => {
    const full = (...deltas: number[]) => [...deltas.map(moved), ...Array.from({ length: 5000 - deltas.length }, () => moved(0))];
    expect(dimSentence(full(3, -1), "query", WINDOW, 7)).toBe("Of the 5,000 queries with the most clicks, one query brought more clicks and one brought fewer, compared with the 28 days before.");
    expect(dimSentence(full(), "page", WINDOW, 7)).toBe("Clicks held steady on the 5,000 pages with the most clicks, compared with the 28 days before.");
    expect(dimSentence(full(), "query", NO_COMPARE)).toBe("At least 5,000 queries showed your site in the 28 days to Oct 30.");
  });
});

describe("dimFigures", () => {
  it("counts the list by where it sits", () => {
    const rows = [
      { clicks: 4, position: 3 },
      { clicks: 0, position: 10 },
      { clicks: 1, position: 15 },
      { clicks: 0, position: 40 },
    ];
    const [count, clicks, pageOne, close] = dimFigures(rows, "query", WINDOW);
    expect(count).toMatchObject({ label: "Queries", value: "4" });
    expect(clicks).toMatchObject({ value: "2" });
    expect(pageOne).toMatchObject({ value: "2" });
    expect(close).toMatchObject({ value: "1" });
  });

  it("says when the list stopped at its limit", () => {
    expect(dimFigures(Array.from({ length: 5_000 }, () => ({ clicks: 0, position: 50 })), "page", WINDOW)[0]).toMatchObject({ label: "Pages", value: "5,000+" });
  });
});

describe("opportunities", () => {
  it("lists what it found", () => {
    expect(opportunitiesSentence({ striking: 2, low: 1, declining: 1, missedClicks: 9 })).toBe("Two queries are close to the top, one query gets fewer clicks than its position should, and one page is losing clicks.");
    expect(opportunitiesSentence({ striking: 0, low: 3, declining: 0, missedClicks: 9 })).toBe("Three queries get fewer clicks than their positions should.");
    expect(opportunitiesSentence({ striking: 1, low: 0, declining: 2, missedClicks: 0 })).toBe("One query is close to the top and two pages are losing clicks.");
  });

  it("is calm with nothing to do", () => {
    expect(opportunitiesSentence({ striking: 0, low: 0, declining: 0, missedClicks: 0 })).toBe("Nothing stands out in this period.");
  });

  it("scopes itself to the queries read when that list stopped at its limit", () => {
    const counts = { striking: 800, low: 3, declining: 2, missedClicks: 90, queriesRead: 5000 };
    expect(opportunitiesSentence(counts)).toBe("Among the 5,000 queries with the most clicks, 800 queries are close to the top and three queries get fewer clicks than their positions should. Two pages are losing clicks.");
    expect(opportunitiesSentence({ ...counts, striking: 0, low: 0 })).toBe("Two pages are losing clicks.");
    expect(opportunitiesSentence({ striking: 0, low: 0, declining: 0, missedClicks: 0, queriesRead: 5000 })).toBe("Nothing stands out among the 5,000 queries with the most clicks.");
    const [striking, low, missed] = opportunityFigures(counts, WINDOW, 28);
    expect(striking).toMatchObject({ value: "800", caption: "Queries at position 4 to 20, 28 days to Oct 30, among the 5,000 queries with the most clicks" });
    expect(low).toMatchObject({ caption: "Queries in the top 10, among the 5,000 queries with the most clicks" });
    expect(missed).toMatchObject({ value: "90", caption: "Against a typical result at those positions, among the 5,000 queries with the most clicks" });
    expect(opportunityFigures({ ...counts, queriesRead: 4999 }, WINDOW, 28)[1]).toMatchObject({ caption: "Queries in the top 10" });
    expect(opportunityFigures({ ...counts, queriesRead: 0, range: { min: 11, max: 20 } }, WINDOW, 28)[0]).toMatchObject({ caption: "Queries at position 11 to 20, 28 days to Oct 30" });
  });

  it("offers a compare period when none is picked, without inventing a count", () => {
    const counts = { striking: 1, low: 1, declining: 0, missedClicks: 4 };
    expect(opportunityFigures(counts, NO_COMPARE, 90)[3]).toMatchObject({ state: "empty", action: { href: "/gsc/opportunities?days=90&compare=prev" } });
    expect(opportunityFigures(counts, FIRST_READING, 28)[3]).toMatchObject({ state: "empty", text: "Nothing earlier to compare yet." });
    expect(opportunityFigures(counts, WINDOW, 28)[3]).toMatchObject({ state: "value", value: "0", caption: "Down 30% or more, vs the 28 before" });
    expect(opportunityFigures(counts, WINDOW, 28)[2]).toMatchObject({ value: "4" });
  });
});

describe("breakdown", () => {
  const row = (name: string, clicks: number, share: number, clicksDelta: number | null) => ({ name, clicks, share, clicksDelta, ctr: 0.05, impressions: clicks * 20, position: 8.2 });

  it("leads on the device that moved", () => {
    expect(breakdownSentence([row("Mobile", 120, 0.8, 20), row("Desktop", 30, 0.2, 0)], [row("United States", 140, 0.9, 10)], WINDOW)).toBe("Mobile clicks are up 20%, compared with the 28 days before.");
    expect(breakdownSentence([row("Mobile", 80, 0.8, -20)], [], WINDOW)).toBe("Mobile clicks are down 20%, compared with the 28 days before.");
  });

  it("says where clicks come from when nothing moved or nothing compares", () => {
    const calm = "Mobile brings 80% of clicks and United States brings 90%.";
    expect(breakdownSentence([row("Mobile", 100, 0.8, 0)], [row("United States", 90, 0.9, 0)], WINDOW)).toBe(calm);
    expect(breakdownSentence([row("Mobile", 100, 0.8, null)], [row("United States", 90, 0.9, null)], FIRST_READING)).toBe(calm);
  });

  it("gives small counts as from and to", () => {
    expect(breakdownSentence([row("Tablet", 3, 1, -2)], [], WINDOW)).toBe("Tablet clicks went from 5 to 3, compared with the 28 days before.");
  });

  it("says when there's nothing", () => {
    expect(breakdownSentence([], [], WINDOW)).toBe("No country or device data in the 28 days to Oct 30.");
    expect(breakdownFigures([], [], WINDOW)).toEqual([]);
  });

  it("gives a figure per device and one for countries", () => {
    const figures = breakdownFigures([row("Mobile", 3, 0.6, -2), row("Desktop", 2, 0.4, null)], [row("United States", 5, 1, 0), row("Canada", 0, 0, 0)], WINDOW);
    expect(figures.map((f) => f.label)).toEqual(["Mobile", "Desktop", "Countries"]);
    expect(figures[0]).toMatchObject({ value: "3", delta: { text: "−2" }, caption: "60.0% of clicks · CTR 5.0% · position 8.2" });
    expect(figures[1]).toMatchObject({ delta: null });
    expect(figures[2]).toMatchObject({ value: "2", caption: "United States brings the most, 100.0% of clicks" });
  });
});

describe("inspection", () => {
  const url = (u: string, verdict: string | null) => ({ url: u, verdict });

  it("invites the first inspection, with no figures", () => {
    expect(inspectSentence([])).toBe("Nothing inspected yet. Enter a URL to see what Google knows about it.");
    expect(inspectFigures([])).toEqual([]);
  });

  it("is calm when everything passed", () => {
    expect(inspectSentence([url("/a", "PASS")])).toBe("The one URL you inspected passed.");
    expect(inspectSentence([url("/a", "PASS"), url("/b", "PASS")])).toBe("Both URLs you inspected passed.");
  });

  it("counts only each URL's newest inspection", () => {
    const history = [url("/a", "FAIL"), url("/a", "PASS"), url("/b", "PASS"), url("/c", "NEUTRAL")];
    expect(inspectSentence(history)).toBe("Of the three URLs you inspected, one passed, one failed, one needs a look.");
    expect(inspectFigures(history).map((f) => f.state === "value" && f.value)).toEqual(["3", "1", "1", "1"]);
  });

  it("reads Google's values as words and leaves its sentences alone", () => {
    expect(plainState("INDEXING_ALLOWED")).toBe("Indexing allowed");
    expect(plainState("MOBILE")).toBe("Mobile");
    expect(plainState("Submitted and indexed")).toBe("Submitted and indexed");
  });
});

describe("sitemaps", () => {
  const map = (over: Partial<{ errors: number; warnings: number; submitted: number; isPending: boolean }> = {}) => ({ errors: 0, warnings: 0, submitted: 10, isPending: false, ...over });

  it("leads on errors, then what's waiting", () => {
    expect(sitemapsSentence([map({ errors: 2 }), map({ isPending: true })])).toBe("One sitemap has errors.");
    expect(sitemapsSentence([map({ errors: 1 }), map({ errors: 3 })])).toBe("Two sitemaps have errors.");
    expect(sitemapsSentence([map({ isPending: true })])).toBe("One sitemap is waiting for Google to read it.");
  });

  it("is calm when all is well, or says there are none", () => {
    expect(sitemapsSentence([map()])).toBe("Your one sitemap has no errors.");
    expect(sitemapsSentence([map(), map()])).toBe("Both sitemaps have no errors.");
    expect(sitemapsSentence([])).toBe("No sitemaps submitted in Search Console yet.");
  });

  it("adds them up", () => {
    expect(sitemapFigures([])).toEqual([]);
    expect(sitemapFigures([map({ errors: 1, warnings: 2 }), map({ submitted: 5 })]).map((f) => f.state === "value" && f.value)).toEqual(["2", "15", "1", "2"]);
  });
});

describe("words for the page", () => {
  it("names the source and how fresh it is, without raw IDs", () => {
    expect(gscSource("sc-domain:example.com", "2026-10-30")).toBe("Google Search Console for example.com · data through Oct 30, 2026");
    expect(gscSource("https://www.example.com/")).toBe("Google Search Console for www.example.com");
  });

  it("shortens a URL to its path", () => {
    expect(urlPath("https://example.com/a/b")).toBe("/a/b");
    expect(urlPath("https://example.com")).toBe("/");
  });

  it("keeps the host where two pages share a path, so www and non-www can be told apart", () => {
    const urls = ["https://betaweb.example/", "https://www.betaweb.example/", "https://betaweb.example/services/seo/", "http://betaweb.example/services/seo/", "https://betaweb.example/about/"];
    const label = pageLabels(urls);
    expect(urls.map(label)).toEqual(["betaweb.example/", "www.betaweb.example/", "betaweb.example/services/seo/", "http://betaweb.example/services/seo/", "/about/"]);
  });
});

describe("striking distance labels", () => {
  it("names the source and the days", () => {
    expect(searchConsoleSpan({ start: "2026-10-03", end: "2026-10-30" })).toBe("Search Console, Oct 3 to Oct 30, 2026");
    expect(searchConsoleSpan({ start: "2025-12-04", end: "2026-01-01" })).toBe("Search Console, Dec 4, 2025 to Jan 1, 2026");
  });

  it("warns under 90 days of stored data, and not from 90", () => {
    expect(noisyNote({ first: "2026-10-18", last: "2026-10-30" })).toBe("Search Console has 13 days of data for this site so far. Under 90 days, positions rest on few searches, so these results may be noisy.");
    expect(noisyNote({ first: "2026-08-02", last: "2026-10-30" })).toBeNull();
    expect(noisyNote({ first: "2026-08-03", last: "2026-10-30" })).toContain("89 days");
  });
});
