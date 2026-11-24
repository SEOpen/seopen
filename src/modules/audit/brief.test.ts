import { describe, expect, it } from "vitest";
import {
  auditFigures,
  auditSentence,
  crawlTimeLine,
  compareFigures,
  compareSentence,
  crawlPoints,
  earlierCrawl,
  filledColumns,
  issueFigures,
  issueSentence,
  issuesFigures,
  issuesSentence,
  compareOverall,
  crawlExtent,
  faultyUrls,
  pageStats,
  pagesFigures,
  pagesSentence,
  repeatedDays,
  statusCounts,
  wholeScore,
  type CrawlReading,
} from "./brief";
import { STATUS_CLASSES, statusClass } from "./status";

const ZONE = "America/New_York";

const crawl = (day: string, over: Partial<CrawlReading> = {}): CrawlReading => ({ finishedAt: new Date(`${day}T15:00:00Z`), healthScore: 80, errors: 5, warnings: 30, notices: 100, pagesCrawled: 120, ...over });

const OCT = crawl("2026-10-28");
const NOV = "2026-11-03";

describe("auditSentence", () => {
  it("says what to do with no crawl, and when one is running with no results yet", () => {
    expect(auditSentence({ crawl: null }, ZONE)).toBe("No crawl yet. Start one below, and the results are saved here when it finishes.");
    expect(auditSentence({ crawl: null, running: true }, ZONE)).toBe("A crawl is running. Results show here when it finishes.");
  });

  it("names the first crawl, with small counts in words", () => {
    expect(auditSentence({ crawl: crawl(NOV, { errors: 2 }) }, ZONE)).toBe("First crawl on Nov 3 found two errors. Changes show after the next one.");
    expect(auditSentence({ crawl: crawl(NOV, { errors: 1 }) }, ZONE)).toBe("First crawl on Nov 3 found one error. Changes show after the next one.");
    expect(auditSentence({ crawl: crawl(NOV, { errors: 0 }) }, ZONE)).toBe("First crawl on Nov 3 found no errors. Changes show after the next one.");
  });

  it("leads on errors going up, with the good news beside it", () => {
    expect(auditSentence({ crawl: crawl(NOV, { errors: 7, warnings: 21 }), previous: OCT }, ZONE)).toBe("Errors rose from 5 to 7, but warnings fell from 30 to 21, compared with Oct 28.");
  });

  it("reads a move down, however small", () => {
    expect(auditSentence({ crawl: crawl(NOV, { errors: 4 }), previous: OCT }, ZONE)).toBe("Errors fell from 5 to 4, compared with Oct 28.");
    expect(auditSentence({ crawl: crawl(NOV, { errors: 3, healthScore: 84 }), previous: OCT }, ZONE)).toBe("Errors fell from 5 to 3, and health score rose four points to 84, compared with Oct 28.");
  });

  it("ignores a score change that rounds to nothing", () => {
    expect(auditSentence({ crawl: crawl(NOV, { healthScore: 80.3 }), previous: OCT }, ZONE)).toBe("Nothing moved since Oct 28.");
  });

  it("lets notices speak only when nothing else moved", () => {
    expect(auditSentence({ crawl: crawl(NOV, { notices: 90 }), previous: OCT }, ZONE)).toBe("Notices fell from 100 to 90, compared with Oct 28.");
    expect(auditSentence({ crawl: crawl(NOV, { notices: 90, warnings: 31 }), previous: OCT }, ZONE)).toBe("Warnings rose from 30 to 31, compared with Oct 28.");
  });

  it("catches issues that came and went under the same totals", () => {
    expect(auditSentence({ crawl: crawl(NOV), previous: OCT, newUrls: 3, fixedUrls: 3 }, ZONE)).toBe("Three new issues and three fixed, compared with Oct 28.");
    expect(auditSentence({ crawl: crawl(NOV), previous: OCT, newUrls: 1 }, ZONE)).toBe("One new issue, compared with Oct 28.");
    expect(auditSentence({ crawl: crawl(NOV), previous: OCT, fixedUrls: 2 }, ZONE)).toBe("Two issues fixed, compared with Oct 28.");
  });

  it("is calm when nothing moved", () => {
    expect(auditSentence({ crawl: crawl(NOV), previous: OCT }, ZONE)).toBe("Nothing moved since Oct 28.");
  });

  it("reads the date in the workspace's zone", () => {
    expect(auditSentence({ crawl: { ...crawl(NOV), finishedAt: new Date("2026-11-04T02:00:00Z") } }, ZONE)).toContain("Nov 3");
  });
});

describe("auditFigures", () => {
  it("compares with the crawl before, and small counts read as a difference", () => {
    const [health, errors, warnings, notices] = auditFigures(crawl(NOV, { healthScore: 83.6, errors: 3, warnings: 45, notices: 100 }), OCT, ZONE);
    expect(health).toMatchObject({ value: "84", delta: { tone: "good", text: "+4" }, caption: "Needs work, out of 100, vs Oct 28" });
    expect(errors).toMatchObject({ value: "3", delta: { tone: "good", text: "−2" }, href: "/audit/issues?severity=error", caption: "issues across 120 pages, vs Oct 28" });
    expect(notices).toMatchObject({ caption: "issues worth a look, vs Oct 28" });
    expect(warnings).toMatchObject({ value: "45", delta: { tone: "bad", text: "+15" } });
    expect(notices).toMatchObject({ delta: { tone: "muted", text: "No change" } });
  });

  it("moves the score as it's printed, so the figure agrees with the sentence", () => {
    const previous = crawl("2026-10-28", { healthScore: 79.6 });
    const now = crawl(NOV, { healthScore: 80.4 });
    expect(auditSentence({ crawl: now, previous }, ZONE)).toBe("Nothing moved since Oct 28.");
    expect(auditFigures(now, previous, ZONE)[0]).toMatchObject({ value: "80", delta: { tone: "muted", text: "No change" } });
    expect(compareFigures(previous, now, { added: 0, fixed: 0 }, ZONE)[0]).toMatchObject({ value: "80", delta: { tone: "muted", text: "No change" } });
    expect(auditFigures(crawl(NOV, { healthScore: 80.3 }), OCT, ZONE)[0]).toMatchObject({ value: "80", delta: { tone: "muted", text: "No change" } });
  });

  it("has no change on the first crawl", () => {
    for (const f of auditFigures(crawl(NOV), null, ZONE)) expect(f).toMatchObject({ state: "value", delta: null });
    expect(auditFigures(crawl(NOV), null, ZONE)[1]).toMatchObject({ caption: "issues across 120 pages, first crawl" });
  });

  it("gives errors from zero a plain difference, not a percentage", () => {
    expect(auditFigures(crawl(NOV, { errors: 25 }), crawl("2026-10-28", { errors: 0 }), ZONE)[1]).toMatchObject({ delta: { text: "+25", tone: "bad" } });
  });

  it("explains a crawl with no score", () => {
    expect(auditFigures(crawl(NOV, { healthScore: null }), OCT, ZONE)[0]).toMatchObject({ state: "empty", text: "This crawl has no score." });
  });
});

describe("issuesSentence", () => {
  it("covers both, either and neither", () => {
    expect(issuesSentence(crawl(NOV), OCT, 3, 1, ZONE)).toBe("Three new issues and one fixed since Oct 28.");
    expect(issuesSentence(crawl(NOV), OCT, 1, 0, ZONE)).toBe("One new issue since Oct 28.");
    expect(issuesSentence(crawl(NOV), OCT, 0, 12, ZONE)).toBe("12 issues fixed since Oct 28.");
    expect(issuesSentence(crawl(NOV), OCT, 0, 0, ZONE)).toBe("Nothing new or fixed since Oct 28.");
  });

  it("waits on the first crawl", () => {
    expect(issuesSentence(crawl(NOV), null, 0, 0, ZONE)).toBe("First crawl on Nov 3. New and fixed issues show after the next one.");
  });
});

describe("issuesFigures", () => {
  const links = { failing: "/f", new: "/n", passed: "/p" };

  it("counts checks and links to the views they name", () => {
    const [failing, added, fixed, passed] = issuesFigures({ failing: 4, newUrls: 2, fixedUrls: 1, crawl: crawl(NOV), previous: OCT, timeZone: ZONE, links });
    expect(failing).toMatchObject({ value: expect.stringMatching(/^4 of \d+$/), href: "/f" });
    expect(added).toMatchObject({ value: "2", href: "/n", caption: "not there on Oct 28" });
    expect(fixed).toMatchObject({ value: "1", caption: "gone since Oct 28" });
    expect(passed).toMatchObject({ href: "/p" });
  });

  it("says when new and fixed will show", () => {
    const [, added, fixed] = issuesFigures({ failing: 4, newUrls: 0, fixedUrls: 0, crawl: crawl(NOV), previous: null, timeZone: ZONE, links });
    expect(added).toMatchObject({ state: "empty", text: "Shows after the next crawl." });
    expect(fixed).toMatchObject({ state: "empty" });
  });
});

describe("compareSentence", () => {
  const later = crawl(NOV);

  it("gets one and many right", () => {
    expect(compareSentence(OCT, later, { added: 3, fixed: 1 }, ZONE)).toBe("Between Oct 28 and Nov 3, three new issues appeared and one was fixed.");
    expect(compareSentence(OCT, later, { added: 1, fixed: 0 }, ZONE)).toBe("Between Oct 28 and Nov 3, one new issue appeared.");
    expect(compareSentence(OCT, later, { added: 0, fixed: 2 }, ZONE)).toBe("Between Oct 28 and Nov 3, two issues were fixed.");
  });

  it("is calm when nothing came or went", () => {
    expect(compareSentence(OCT, later, { added: 0, fixed: 0 }, ZONE)).toBe("No issues came or went between Oct 28 and Nov 3.");
  });

  it("names two crawls from one day by their times", () => {
    const [morning, night] = [crawl(NOV, { finishedAt: new Date("2026-11-03T14:05:00Z") }), crawl(NOV, { finishedAt: new Date("2026-11-04T03:43:00Z") })];
    expect(compareSentence(morning, night, { added: 0, fixed: 0 }, ZONE)).toBe("No issues came or went between 9:05 AM and 10:43 PM on Nov 3.");
    expect(compareSentence(morning, night, { added: 1, fixed: 0 }, ZONE)).toBe("Between 9:05 AM and 10:43 PM on Nov 3, one new issue appeared.");
    const [health, , added, fixed] = compareFigures(morning, night, { added: 1, fixed: 0 }, ZONE);
    expect(health).toMatchObject({ caption: "10:43 PM, vs 9:05 AM" });
    expect(added).toMatchObject({ caption: "at 10:43 PM, not at 9:05 AM" });
    expect(fixed).toMatchObject({ caption: "at 9:05 AM, gone by 10:43 PM" });
  });
});

describe("compareFigures", () => {
  it("reads the later crawl against the earlier one", () => {
    const [health, errors, added, fixed] = compareFigures(OCT, crawl(NOV, { healthScore: 76, errors: 9 }), { added: 4, fixed: 0 }, ZONE);
    expect(health).toMatchObject({ value: "76", delta: { tone: "bad", text: "−4" }, caption: "Nov 3, vs Oct 28" });
    expect(errors).toMatchObject({ value: "9", delta: { tone: "bad", text: "+4" } });
    expect(added).toMatchObject({ value: "4" });
    expect(fixed).toMatchObject({ value: "0" });
  });
});

describe("crawlExtent", () => {
  it("reads a crawl that ran out of pages as finished, and one that hit its limit as stopped", () => {
    expect(crawlExtent({ pagesCrawled: 75, maxPages: 500 })).toBe("crawled all 75 pages it found");
    expect(crawlExtent({ pagesCrawled: 500, maxPages: 500 })).toBe("stopped at its limit of 500 pages");
    expect(crawlExtent({ pagesCrawled: 1, maxPages: 500 })).toBe("crawled the only page it found");
  });
});

describe("compareOverall", () => {
  it("moves the score in whole points, as the score is shown and as Overview says it", () => {
    const earlier = crawl("2026-10-28", { healthScore: 88.5 });
    const later = crawl(NOV, { healthScore: 91 });
    const health = compareOverall(earlier, later, { added: 0, fixed: 0 }).find((r) => r.label === "Health score");
    expect(health).toMatchObject({ a: 89, b: 91, change: 2 });
    expect(auditSentence({ crawl: later, previous: earlier }, ZONE)).toContain("rose two points to 91");
  });

  it("gives counts their plain difference, and new and fixed issues no earlier value", () => {
    const rows = compareOverall(crawl("2026-10-28", { errors: 5, warnings: 20 }), crawl(NOV, { errors: 3, warnings: 20 }), { added: 4, fixed: 6 });
    expect(rows.find((r) => r.label === "Errors")).toMatchObject({ a: 5, b: 3, change: -2, goodWhen: "down" });
    expect(rows.find((r) => r.label === "Warnings")).toMatchObject({ change: 0 });
    expect(rows.find((r) => r.label === "New issues")).toMatchObject({ a: null, b: 4, change: null });
  });
});

describe("pages", () => {
  let n = 0;
  const page = (statusCode: number | null) => ({ url: `https://x.example/${n++}`, statusCode });

  it("sorts pages by how they answered", () => {
    const pages = [page(200), page(200), page(301), page(404), page(500), page(null)];
    const issues = [{ code: "missing-title", url: pages[1].url }, { code: "http-4xx", url: pages[3].url }];
    expect(pageStats(pages, issues)).toEqual({ total: 6, withIssues: 1, redirects: 1, broken: 2, noResponse: 1 });
  });

  it("counts a page with no response (status 0) once, as no response, on Overview and the Pages tab alike", () => {
    // DataForSEO gives 0 when it got no answer: a timeout, a DNS failure or a refused connection.
    const pages = [page(200), page(0), page(0), page(503), page(404), page(301)];
    const issues = pages.slice(1, 3).map((p) => ({ code: "unreachable", url: p.url }));
    expect(statusClass(0)).toBe("no-response");
    expect(statusClass(null)).toBe("no-response");
    expect(statusCounts(pages, issues)).toEqual({ ok: 1, withIssues: 0, redirect: 1, clientError: 1, serverError: 1, noResponse: 2 });
    expect(pageStats(pages, issues)).toMatchObject({ total: 6, broken: 2, noResponse: 2 });
    // The Pages tab's Status filter has a class for them, and every page is in exactly one class.
    const inClass = (key: string) => pages.filter((p) => statusClass(p.statusCode) === key).length;
    expect(STATUS_CLASSES.find((c) => c.key === "no-response")).toMatchObject({ label: "No response" });
    expect(STATUS_CLASSES.map((c) => [c.key, inClass(c.key)])).toEqual([["2xx", 1], ["3xx", 1], ["4xx", 1], ["5xx", 1], ["no-response", 2]]);
  });

  it("names pages with no response in the sentence, and gives them a figure only when there are some", () => {
    const c = crawl(NOV);
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 3, broken: 2, noResponse: 1 }, c, ZONE)).toBe("Two pages returned an error, one gave no response and three redirected, in the crawl of Nov 3.");
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 0, broken: 0, noResponse: 2 }, c, ZONE)).toBe("Two pages gave no response, in the crawl of Nov 3.");
    const figures = pagesFigures({ total: 9, withIssues: 4, redirects: 1, broken: 2, noResponse: 3 }, c, ZONE, { redirects: "/r" });
    expect(figures.find((f) => f.id === "no-response")).toMatchObject({ label: "Pages with no response", value: "3", caption: "of 9 crawled" });
  });

  it("counts pages with an error or a warning the way Overview's Crawled URLs does, so a notice alone leaves a page healthy", () => {
    const pages = [page(200), page(200), page(200), page(301)];
    const issues = [
      // A notice on every page, as render-blocking often is.
      ...pages.map((p) => ({ code: "render-blocking", url: p.url })),
      { code: "missing-description", url: pages[0].url },
      { code: "missing-title", url: pages[1].url },
      { code: "missing-title", url: pages[3].url },
    ];
    expect(pageStats(pages, issues).withIssues).toBe(2);
    expect(faultyUrls(issues)).toEqual(new Set([pages[0].url, pages[1].url, pages[3].url]));
    expect(pagesFigures(pageStats(pages, issues), crawl(NOV), ZONE, { redirects: "/r" })[1]).toMatchObject({ label: "Pages with errors or warnings", value: "2", caption: "of 4 crawled" });
  });

  it("says what's wrong, small counts in words", () => {
    const c = crawl(NOV);
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 3, broken: 2, noResponse: 0 }, c, ZONE)).toBe("Two pages returned an error and three redirected, in the crawl of Nov 3.");
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 0, broken: 1, noResponse: 0 }, c, ZONE)).toBe("One page returned an error, in the crawl of Nov 3.");
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 1, broken: 0, noResponse: 0 }, c, ZONE)).toBe("One page redirected, in the crawl of Nov 3.");
    expect(pagesSentence({ total: 9, withIssues: 0, redirects: 0, broken: 0, noResponse: 0 }, c, ZONE)).toBe("No page returned an error or redirected, in the crawl of Nov 3.");
    expect(pagesSentence({ total: 0, withIssues: 0, redirects: 0, broken: 0, noResponse: 0 }, c, ZONE)).toBe("The crawl of Nov 3 found no pages.");
  });

  it("has four figures, with redirects linked to their filter", () => {
    const figures = pagesFigures({ total: 9, withIssues: 4, redirects: 1, broken: 2, noResponse: 0 }, crawl(NOV), ZONE, { redirects: "/r" });
    expect(figures.map((f) => f.state === "value" && f.value)).toEqual(["9", "4", "2", "1"]);
    expect(figures[3]).toMatchObject({ href: "/r", caption: "of 9 crawled" });
  });
});

describe("issueSentence", () => {
  it("covers new, partly new, none new and no URLs", () => {
    const now = crawl(NOV);
    expect(issueSentence(12, 3, OCT, now, ZONE)).toBe("12 URLs have this issue, three of them new since Oct 28.");
    expect(issueSentence(3, 3, OCT, now, ZONE)).toBe("Three URLs have this issue, all new since Oct 28.");
    expect(issueSentence(1, 1, OCT, now, ZONE)).toBe("One URL has this issue, and it's new since Oct 28.");
    expect(issueSentence(2, 0, OCT, now, ZONE)).toBe("Two URLs have this issue, none of them new since Oct 28.");
    expect(issueSentence(0, 0, OCT, now, ZONE)).toBe("No URLs have this issue in this crawl.");
  });

  it("waits on the first crawl", () => {
    expect(issueSentence(2, 0, null, crawl(NOV), ZONE)).toBe("Two URLs have this issue. New ones show after the next crawl.");
  });
});

describe("issueFigures", () => {
  it("splits new from still there", () => {
    const [urls, added, still] = issueFigures(12, 3, OCT, crawl(NOV), ZONE);
    expect(urls).toMatchObject({ value: "12", caption: "crawl of Nov 3" });
    expect(added).toMatchObject({ value: "3", caption: "not there on Oct 28" });
    expect(still).toMatchObject({ value: "9", caption: "also there on Oct 28" });
  });

  it("says when the split will show", () => {
    const [, added, still] = issueFigures(2, 0, null, crawl(NOV), ZONE);
    expect(added).toMatchObject({ state: "empty" });
    expect(still).toMatchObject({ state: "empty" });
  });
});

describe("crawlPoints", () => {
  it("runs oldest first on the zone's day, and skips a crawl that never finished", () => {
    const crawls = [{ finishedAt: new Date("2026-11-04T02:00:00Z"), healthScore: 82.4 }, { finishedAt: null, healthScore: 1 }, { finishedAt: new Date("2026-10-28T15:00:00Z"), healthScore: null }];
    expect(crawlPoints(crawls, wholeScore, ZONE)).toEqual([
      { date: "2026-10-28", value: null },
      { date: "2026-11-03", value: 82 },
    ]);
  });

  it("gives crawls on one day their own moment and time, in the zone", () => {
    const crawls = [
      { finishedAt: new Date("2026-11-04T03:43:10.500Z"), healthScore: 85 },
      { finishedAt: new Date("2026-11-03T14:05:20.000Z"), healthScore: 82 },
      { finishedAt: new Date("2026-10-28T15:00:00Z"), healthScore: 80 },
    ];
    expect(crawlPoints(crawls, wholeScore, ZONE)).toEqual([
      { date: "2026-10-28", value: 80 },
      { date: "2026-11-03T09:05:20.000Z", value: 82, label: "Nov 3, 9:05 AM" },
      { date: "2026-11-03T22:43:10.500Z", value: 85, label: "Nov 3, 10:43 PM" },
    ]);
  });

  it("tells apart two crawls that finished in the same minute", () => {
    const crawls = [{ finishedAt: new Date("2026-11-03T14:05:50Z"), healthScore: 85 }, { finishedAt: new Date("2026-11-03T14:05:10Z"), healthScore: 82 }];
    const [a, b] = crawlPoints(crawls, wholeScore, ZONE);
    expect(a.date).not.toBe(b.date);
    expect(a.date < b.date).toBe(true);
  });
});

describe("same-day crawls", () => {
  const morning = { ...crawl(NOV), finishedAt: new Date("2026-11-03T14:05:00Z") };
  const night = { ...crawl(NOV), finishedAt: new Date("2026-11-04T03:43:00Z") };

  it("names the crawl before by its time in the sentences", () => {
    expect(earlierCrawl(morning, night, ZONE)).toBe("the 9:05 AM crawl on Nov 3");
    expect(earlierCrawl(OCT, night, ZONE)).toBe("Oct 28");
    expect(auditSentence({ crawl: night, previous: morning }, ZONE)).toBe("Nothing moved since the 9:05 AM crawl on Nov 3.");
    expect(auditSentence({ crawl: { ...night, errors: 4 }, previous: morning }, ZONE)).toBe("Errors fell from 5 to 4, compared with the 9:05 AM crawl on Nov 3.");
    expect(issuesSentence(night, morning, 0, 0, ZONE)).toBe("Nothing new or fixed since the 9:05 AM crawl on Nov 3.");
    expect(issueSentence(2, 0, morning, night, ZONE)).toBe("Two URLs have this issue, none of them new since the 9:05 AM crawl on Nov 3.");
    expect(issueSentence(3, 3, morning, night, ZONE)).toBe("Three URLs have this issue, all new since the 9:05 AM crawl on Nov 3.");
  });

  it("names it by its time in the captions", () => {
    expect(auditFigures(night, morning, ZONE)[0]).toMatchObject({ caption: expect.stringContaining("vs 9:05 AM") });
    expect(issueFigures(2, 1, morning, night, ZONE)[1]).toMatchObject({ caption: "not there at 9:05 AM" });
    const [, added, fixed] = issuesFigures({ failing: 4, newUrls: 2, fixedUrls: 1, crawl: night, previous: morning, timeZone: ZONE, links: { failing: "/f", new: "/n", passed: "/p" } });
    expect(added).toMatchObject({ caption: "not there at 9:05 AM" });
    expect(fixed).toMatchObject({ caption: "gone since 9:05 AM" });
  });

  it("finds the days that repeat, in the zone rather than in UTC", () => {
    expect([...repeatedDays([morning.finishedAt, night.finishedAt, null], ZONE)]).toEqual(["2026-11-03"]);
    expect(repeatedDays([morning.finishedAt, night.finishedAt], "UTC").size).toBe(0);
  });
});

describe("filledColumns", () => {
  it("drops a column empty in every row", () => {
    const columns = [{ key: "url" }, { key: "title" }, { key: "depth" }];
    expect(filledColumns(columns, [{ url: "a", title: null, depth: 0 }, { url: "b", title: "", depth: null }]).map((c) => c.key)).toEqual(["url", "depth"]);
  });

  it("keeps every column when there are no rows", () => {
    expect(filledColumns([{ key: "url" }, { key: "title" }], [])).toHaveLength(2);
  });
});

describe("a failed first crawl", () => {
  it("says so instead of No crawl yet", () => {
    expect(auditSentence({ crawl: null, failed: true }, "UTC")).toBe("No results yet, because the last crawl failed.");
    expect(auditSentence({ crawl: null, running: true, failed: true }, "UTC")).toMatch(/running/);
    expect(auditSentence({ crawl: null }, "UTC")).toMatch(/^No crawl yet/);
  });
});

describe("crawlTimeLine", () => {
  it("gives the documented time for a 500-page crawl", () => {
    expect(crawlTimeLine(500)).toBe("A 500-page crawl usually takes 10 to 20 minutes.");
    expect(crawlTimeLine(null)).toBe("A 500-page crawl usually takes 10 to 20 minutes.");
  });

  it("promises no time where the docs give none, such as Free's 100 pages, and never quotes 500 pages there", () => {
    const line = crawlTimeLine(100);
    expect(line).not.toMatch(/minute|500/);
    expect(line).toMatch(/2 seconds/);
  });
});
