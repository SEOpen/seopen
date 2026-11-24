/** The top of each Site audit page, from what the crawls stored. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { briefSentence, changeDelta, countDeltaFromZero, countOf, countWord, type Move } from "@/lib/brief";
import type { SeriesPoint } from "@/lib/chart-rule";
import { formatDateTime, formatNumber, formatShortDate, formatTimestamp } from "@/lib/format";
import type { CrawlRow } from "./queries";
import { scoreBand, scorePoints } from "./score";
import { statusClass } from "./status";
import { ISSUES } from "./taxonomy";

export type CrawlReading = Pick<CrawlRow, "finishedAt" | "healthScore" | "errors" | "warnings" | "notices" | "pagesCrawled">;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The pages docs/dataforseo.md gives a crawl time for: "a 500-page crawl takes about 10–20 minutes". */
const TIMED_PAGES = 500;

/**
 * How long a crawl takes, for the plan's pages per crawl (null: no plan limit). docs/dataforseo.md
 * times only a 500-page crawl, so a smaller limit, such as Free's 100, gets the crawler's documented
 * pace (its default 2-second delay between pages) rather than a time nobody has measured.
 */
export function crawlTimeLine(planPages: number | null): string {
  if (planPages === null || planPages >= TIMED_PAGES) return `A ${TIMED_PAGES}-page crawl usually takes 10 to 20 minutes.`;
  return "The crawler waits about 2 seconds between pages, so a small site finishes sooner than a big one.";
}

/** How to name two crawls. Two on one day go by their times, because "Nov 3 vs Nov 3" tells them apart from nothing. */
function crawlNames(earlier: CrawlReading, later: CrawlReading, timeZone: string) {
  const [from, to] = [formatShortDate(earlier.finishedAt, timeZone), formatShortDate(later.finishedAt, timeZone)];
  if (from !== to || !earlier.finishedAt || !later.finishedAt) return { from, to, prep: "on", onDay: "" };
  const time = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return { from: time(earlier.finishedAt), to: time(later.finishedAt), prep: "at", onDay: ` on ${to}` };
}

/** The crawl before, as a sentence names it: "Oct 28", or "the 9:05 AM crawl on Nov 3" when both finished that day. */
export function earlierCrawl(earlier: CrawlReading, later: CrawlReading, timeZone: string): string {
  const { from, prep, onDay } = crawlNames(earlier, later, timeZone);
  return prep === "at" ? `the ${from} crawl${onDay}` : from;
}

/** The days, in the zone, that more than one of these instants fall on. */
export function repeatedDays(instants: readonly (Date | string | null)[], timeZone: string): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const at of instants) {
    if (!at) continue;
    const day = formatTimestamp(at, timeZone).slice(0, 10);
    if (seen.has(day)) repeated.add(day);
    seen.add(day);
  }
  return repeated;
}

/** A count against the one before, where fewer is better. */
const change = (now: number, before: number | null | undefined) => countDeltaFromZero(now, before, "down");

/** "errors rose from 3 to 5". Errors outrank warnings, however the sizes compare. */
function countChange(noun: string, now: number | null, before: number | null, rank: number): Move | null {
  if (now == null || before == null || now === before) return null;
  const up = now > before;
  return {
    clause: `${noun} ${up ? "rose" : "fell"} from ${formatNumber(before)} to ${formatNumber(now)}`,
    tone: up ? "bad" : "good",
    weight: rank + Math.abs(now - before) / Math.max(now, before),
  };
}

function scoreChange(now: number | null, before: number | null): Move | null {
  if (now == null || before == null) return null;
  const points = scorePoints(now, before);
  if (!points) return null;
  return {
    clause: `health score ${points > 0 ? "rose" : "fell"} ${countOf(Math.abs(points), "point")} to ${Math.round(now)}`,
    tone: points > 0 ? "good" : "bad",
    weight: 2 + Math.abs(points) / 100,
  };
}

/** Overview's sentence. Errors lead, because they're what to fix first; notices only speak when nothing else moved. */
export function auditSentence({ crawl, previous, newUrls = 0, fixedUrls = 0, running = false, failed = false }: { crawl: CrawlReading | null; previous?: CrawlReading | null; newUrls?: number; fixedUrls?: number; running?: boolean; /** The newest crawl failed. */ failed?: boolean }, timeZone: string): string {
  if (!crawl && running) return "A crawl is running. Results show here when it finishes.";
  if (!crawl) return failed ? "No results yet, because the last crawl failed." : "No crawl yet. Start one below, and the results are saved here when it finishes.";
  const day = formatShortDate(crawl.finishedAt, timeZone);
  if (!previous) {
    const errors = crawl.errors ?? 0;
    return `First crawl on ${day} found ${errors ? countOf(errors, "error") : "no errors"}. Changes show after the next one.`;
  }
  const since = earlierCrawl(previous, crawl, timeZone);
  const moves = [scoreChange(crawl.healthScore, previous.healthScore), countChange("errors", crawl.errors, previous.errors, 3), countChange("warnings", crawl.warnings, previous.warnings, 1)].filter((m): m is Move => !!m);
  if (!moves.length) {
    const notices = countChange("notices", crawl.notices, previous.notices, 0.1);
    if (notices) moves.push(notices);
  }
  if (moves.length) return `${briefSentence(moves, "").slice(0, -1)}, compared with ${since}.`;
  // The same totals can still hide issues that came and went.
  if (newUrls && fixedUrls) return `${capitalize(countOf(newUrls, "new issue"))} and ${countWord(fixedUrls)} fixed, compared with ${since}.`;
  if (newUrls) return `${capitalize(countOf(newUrls, "new issue"))}, compared with ${since}.`;
  if (fixedUrls) return `${capitalize(countOf(fixedUrls, "issue"))} fixed, compared with ${since}.`;
  return `Nothing moved since ${since}.`;
}

const scoreDelta = (now: number | null, before: number | null | undefined) => (now != null && before != null ? changeDelta(scorePoints(now, before), "number", "up") : null);

/** The four numbers Overview leads on. Each count opens the Issues tab on that severity. */
export function auditFigures(crawl: CrawlReading, previous: CrawlReading | null, timeZone: string): FigureData[] {
  const since = previous ? `vs ${crawlNames(previous, crawl, timeZone).from}` : "first crawl";
  // Each is one check failing on one URL, the unit the category table and the Issues tab count.
  const pages = `issues across ${formatNumber(crawl.pagesCrawled)} pages, ${since}`;
  const count = (id: string, label: string, severity: string, now: number | null, before: number | null | undefined, caption: string): FigureData => ({
    state: "value",
    id,
    label,
    href: `/audit/issues?severity=${severity}`,
    value: formatNumber(now),
    delta: now == null ? null : change(now, before),
    caption,
  });
  return [
    crawl.healthScore == null
      ? { state: "empty", id: "health", label: "Health score", text: "This crawl has no score." }
      : { state: "value", id: "health", label: "Health score", value: String(Math.round(crawl.healthScore)), delta: scoreDelta(crawl.healthScore, previous?.healthScore), caption: `${scoreBand(crawl.healthScore).label}, out of 100, ${since}` },
    count("errors", "Errors", "error", crawl.errors, previous?.errors, pages),
    count("warnings", "Warnings", "warning", crawl.warnings, previous?.warnings, pages),
    count("notices", "Notices", "notice", crawl.notices, previous?.notices, `issues worth a look, ${since}`),
  ];
}

/** The Issues tab's sentence: what came and went since the crawl before. */
export function issuesSentence(crawl: CrawlReading, previous: CrawlReading | null, newUrls: number, fixedUrls: number, timeZone: string): string {
  if (!previous) return `First crawl on ${formatShortDate(crawl.finishedAt, timeZone)}. New and fixed issues show after the next one.`;
  const since = earlierCrawl(previous, crawl, timeZone);
  if (newUrls && fixedUrls) return `${capitalize(countOf(newUrls, "new issue"))} and ${countWord(fixedUrls)} fixed since ${since}.`;
  if (newUrls) return `${capitalize(countOf(newUrls, "new issue"))} since ${since}.`;
  if (fixedUrls) return `${capitalize(countOf(fixedUrls, "issue"))} fixed since ${since}.`;
  return `Nothing new or fixed since ${since}.`;
}

export function issuesFigures({ failing, newUrls, fixedUrls, crawl, previous, timeZone, links }: { failing: number; newUrls: number; fixedUrls: number; crawl: CrawlReading; previous: CrawlReading | null; timeZone: string; links: { failing: string; new: string; passed: string } }): FigureData[] {
  const total = Object.keys(ISSUES).length;
  const names = previous && crawlNames(previous, crawl, timeZone);
  const moved = (id: string, label: string, n: number, caption: string | null, href?: string): FigureData =>
    caption ? { state: "value", id, label, href, value: formatNumber(n), delta: null, caption } : { state: "empty", id, label, text: "Shows after the next crawl." };
  return [
    { state: "value", id: "failing", label: "Checks with issues", href: links.failing, value: `${formatNumber(failing)} of ${formatNumber(total)}`, delta: null, caption: "in this crawl" },
    moved("new", "New issues", newUrls, names && `not there ${names.prep} ${names.from}`, links.new),
    moved("fixed", "Fixed issues", fixedUrls, names && `gone since ${names.from}`),
    { state: "value", id: "passed", label: "Checks passed", href: links.passed, value: formatNumber(total - failing), delta: null, caption: "nothing found in this crawl" },
  ];
}

/** Compare's sentence, for the two crawls picked. */
export function compareSentence(earlier: CrawlReading, later: CrawlReading, totals: { added: number; fixed: number }, timeZone: string): string {
  const { from, to, onDay } = crawlNames(earlier, later, timeZone);
  const { added, fixed } = totals;
  if (added && fixed) return `Between ${from} and ${to}${onDay}, ${countOf(added, "new issue")} appeared and ${countWord(fixed)} ${fixed === 1 ? "was" : "were"} fixed.`;
  if (added) return `Between ${from} and ${to}${onDay}, ${countOf(added, "new issue")} appeared.`;
  if (fixed) return `Between ${from} and ${to}${onDay}, ${countOf(fixed, "issue")} ${fixed === 1 ? "was" : "were"} fixed.`;
  return `No issues came or went between ${from} and ${to}${onDay}.`;
}

export function compareFigures(earlier: CrawlReading, later: CrawlReading, totals: { added: number; fixed: number }, timeZone: string): FigureData[] {
  const { from, to, prep } = crawlNames(earlier, later, timeZone);
  const caption = `${to}, vs ${from}`;
  return [
    later.healthScore == null
      ? { state: "empty", id: "health", label: "Health score", text: "The later crawl has no score." }
      : { state: "value", id: "health", label: "Health score", value: String(Math.round(later.healthScore)), delta: scoreDelta(later.healthScore, earlier.healthScore), caption },
    { state: "value", id: "errors", label: "Errors", value: formatNumber(later.errors), delta: later.errors == null ? null : change(later.errors, earlier.errors), caption },
    { state: "value", id: "new", label: "New issues", value: formatNumber(totals.added), delta: null, caption: `${prep} ${to}, not ${prep} ${from}` },
    { state: "value", id: "fixed", label: "Fixed issues", value: formatNumber(totals.fixed), delta: null, caption: `${prep} ${from}, gone by ${to}` },
  ];
}

/**
 * How far a finished crawl got, for the header. Short of its limit, the crawler ran out of pages to
 * follow, so it saw everything it could reach; at the limit there may be more it never reached.
 */
export function crawlExtent({ pagesCrawled, maxPages }: { pagesCrawled: number; maxPages: number }): string {
  if (pagesCrawled >= maxPages) return `stopped at its limit of ${formatNumber(maxPages)} pages`;
  return pagesCrawled === 1 ? "crawled the only page it found" : `crawled all ${formatNumber(pagesCrawled)} pages it found`;
}

export interface OverallRow {
  label: string;
  a: number | null;
  b: number | null;
  /** B minus A, as the two are printed; null when either is missing. */
  change: number | null;
  goodWhen: "up" | "down";
}

/** Compare's Overall table. The score is in whole points, as it's shown and as Overview's sentence moves it. */
export function compareOverall(a: CrawlReading, b: CrawlReading, totals: { added: number; fixed: number }): OverallRow[] {
  const row = (label: string, before: number | null, after: number | null, goodWhen: "up" | "down"): OverallRow => ({ label, a: before, b: after, change: before != null && after != null ? after - before : null, goodWhen });
  return [
    row("Pages crawled", a.pagesCrawled, b.pagesCrawled, "up"),
    row("Health score", wholeScore(a), wholeScore(b), "up"),
    row("Errors", a.errors, b.errors, "down"),
    row("Warnings", a.warnings, b.warnings, "down"),
    row("Notices", a.notices, b.notices, "down"),
    row("New issues", null, totals.added, "down"),
    row("Fixed issues", null, totals.fixed, "up"),
  ];
}

export interface PageStats {
  total: number;
  withIssues: number;
  redirects: number;
  broken: number;
  noResponse: number;
}

/** URLs with at least one error or warning. Notices are prompts to check, so a page with only notices counts as healthy. */
export function faultyUrls(issues: readonly { code: string; url: string }[]): Set<string> {
  return new Set(issues.filter((i) => ISSUES[i.code] && ISSUES[i.code].severity !== "notice").map((i) => i.url));
}

/**
 * Overview's Crawled URLs bar: each page in one slice, by how it answered. "With issues" means at least
 * one error or warning; notices are prompts to check, so a page with only notices still counts as healthy.
 */
export function statusCounts(pages: readonly { url: string; statusCode: number | null }[], issues: readonly { code: string; url: string }[]) {
  const faulty = faultyUrls(issues);
  const counts = { ok: 0, withIssues: 0, redirect: 0, clientError: 0, serverError: 0, noResponse: 0 };
  for (const p of pages) {
    const c = statusClass(p.statusCode);
    if (c === "no-response") counts.noResponse++;
    else if (c === "5xx") counts.serverError++;
    else if (c === "4xx") counts.clientError++;
    else if (c === "3xx") counts.redirect++;
    else if (faulty.has(p.url)) counts.withIssues++;
    else counts.ok++;
  }
  return counts;
}

/**
 * The Pages tab's counts, the same as Overview's Crawled URLs bar. "With issues" is a page that
 * answered with a 2xx and has an error or a warning. Redirects, broken pages and pages with no
 * response are counted as those.
 */
export function pageStats(pages: readonly { url: string; statusCode: number | null }[], issues: readonly { code: string; url: string }[]): PageStats {
  const c = statusCounts(pages, issues);
  return { total: pages.length, withIssues: c.withIssues, redirects: c.redirect, broken: c.clientError + c.serverError, noResponse: c.noResponse };
}

/** The Pages tab's sentence: how the pages answered in this crawl. */
export function pagesSentence(stats: PageStats, crawl: CrawlReading, timeZone: string): string {
  const day = formatShortDate(crawl.finishedAt, timeZone);
  const { total, broken, noResponse, redirects } = stats;
  if (!total) return `The crawl of ${day} found no pages.`;
  const parts = [
    { n: broken, verb: "returned an error" },
    { n: noResponse, verb: "gave no response" },
    { n: redirects, verb: "redirected" },
  ].filter((p) => p.n > 0);
  if (!parts.length) return `No page returned an error or redirected, in the crawl of ${day}.`;
  // The first count names the pages and the rest are bare numbers: "two pages returned an error and three redirected".
  const said = parts.map((p, i) => `${i === 0 ? countOf(p.n, "page") : countWord(p.n)} ${p.verb}`);
  const list = said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0];
  return `${capitalize(list)}, in the crawl of ${day}.`;
}

export function pagesFigures(stats: PageStats, crawl: CrawlReading, timeZone: string, links: { redirects: string }): FigureData[] {
  const of = `of ${formatNumber(stats.total)} crawled`;
  return [
    { state: "value", id: "pages", label: "Pages crawled", value: formatNumber(stats.total), delta: null, caption: `crawl of ${formatShortDate(crawl.finishedAt, timeZone)}` },
    { state: "value", id: "issues", label: "Pages with errors or warnings", value: formatNumber(stats.withIssues), delta: null, caption: of },
    { state: "value", id: "broken", label: "Pages returning errors", value: formatNumber(stats.broken), delta: null, caption: of },
    { state: "value", id: "redirects", label: "Redirects", href: links.redirects, value: formatNumber(stats.redirects), delta: null, caption: of },
    // Most crawls have none, so the figure shows only when some pages gave no response.
    ...(stats.noResponse ? [{ state: "value" as const, id: "no-response", label: "Pages with no response", value: formatNumber(stats.noResponse), delta: null, caption: of }] : []),
  ];
}

/** One issue's sentence: how many URLs have it, and how many are new. */
export function issueSentence(count: number, newCount: number, previous: CrawlReading | null, crawl: CrawlReading, timeZone: string): string {
  if (!count) return "No URLs have this issue in this crawl.";
  const urls = capitalize(countOf(count, "URL"));
  const have = count === 1 ? "has" : "have";
  if (!previous) return `${urls} ${have} this issue. New ones show after the next crawl.`;
  const since = earlierCrawl(previous, crawl, timeZone);
  if (!newCount) return `${urls} ${have} this issue, none of them new since ${since}.`;
  if (newCount === count) return `${urls} ${have} this issue, ${count === 1 ? "and it's" : "all"} new since ${since}.`;
  return `${urls} ${have} this issue, ${countWord(newCount)} of them new since ${since}.`;
}

export function issueFigures(count: number, newCount: number, previous: CrawlReading | null, crawl: CrawlReading, timeZone: string): FigureData[] {
  const day = formatShortDate(crawl.finishedAt, timeZone);
  const names = previous && crawlNames(previous, crawl, timeZone);
  return [
    { state: "value", id: "urls", label: "URLs affected", value: formatNumber(count), delta: null, caption: `crawl of ${day}` },
    names ? { state: "value", id: "new", label: "New", value: formatNumber(newCount), delta: null, caption: `not there ${names.prep} ${names.from}` } : { state: "empty", id: "new", label: "New", text: "Shows after the next crawl." },
    names ? { state: "value", id: "still", label: "Still there", value: formatNumber(count - newCount), delta: null, caption: `also there ${names.prep} ${names.from}` } : { state: "empty", id: "still", label: "Still there", text: "Shows after the next crawl." },
  ];
}

/**
 * One reading per finished crawl, oldest first, on the day it finished in the workspace's zone. Crawls that
 * share a day each get their own moment and say their time, so they don't stack at one spot on the chart.
 * That moment is the zone's clock written as UTC: the charts read every date in UTC, so its day stays the
 * zone's day and it still sorts among the plain days.
 */
export function crawlPoints<C extends Pick<CrawlRow, "finishedAt">>(newestFirst: readonly C[], read: (crawl: C) => number | null, timeZone: string): (SeriesPoint & { label?: string })[] {
  const finished = newestFirst.filter((c) => c.finishedAt);
  const repeated = repeatedDays(finished.map((c) => c.finishedAt), timeZone);
  return finished
    .map((c) => {
      const at = c.finishedAt!;
      const stamp = formatTimestamp(at, timeZone);
      const day = stamp.slice(0, 10);
      if (!repeated.has(day)) return { date: day, value: read(c) };
      return { date: `${day}T${stamp.slice(11)}${new Date(at).toISOString().slice(16)}`, value: read(c), label: formatDateTime(at, timeZone) };
    })
    .reverse();
}

/** The score as the page prints it, so readings that look the same count as the same. */
export const wholeScore = (crawl: Pick<CrawlRow, "healthScore">) => (crawl.healthScore == null ? null : Math.round(crawl.healthScore));

/** Table columns with something in at least one row. With no rows at all there's nothing to judge by, so they all stay. */
export function filledColumns<C extends { key: string }>(columns: readonly C[], rows: readonly Record<string, unknown>[]): C[] {
  if (!rows.length) return [...columns];
  return columns.filter((c) => rows.some((r) => r[c.key] != null && r[c.key] !== ""));
}
