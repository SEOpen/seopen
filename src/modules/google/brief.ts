/** The top of every Search Console page, from rows the page already reads. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { briefSentence, changeDelta, countDelta, countMove, countOf, countWord, MIN_WEIGHT, rateDelta, type Move } from "@/lib/brief";
import { formatDay, formatNumber, formatPct, formatRate } from "@/lib/format";
import type { DimRow, Totals } from "./data";
import { NOISY_UNDER_DAYS, STRIKING_RANGE, type PositionRange } from "./insights";
import { propertyName } from "./matching";
import { daysBetween, maxDate, type Compare, type DateRange, type Periods } from "./windowing";

/** What a page's numbers cover: the periods it picked, and where stored history starts. */
export interface GscWindow {
  periods: Periods;
  compare: Compare;
  first: string;
}

const SMALL = 20;
/** The most rows the query and page lists load. */
const ROW_LIMIT = 5_000;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const value = (f: Omit<Extract<FigureData, { state: "value" }>, "state" | "delta"> & { delta?: Extract<FigureData, { state: "value" }>["delta"] }): FigureData => ({ state: "value", delta: null, ...f });

/** "Google Search Console for example.com · data through Oct 30, 2026". */
export function gscSource(property: string, last?: string): string {
  const source = `Google Search Console for ${propertyName(property)}`;
  return last ? `${source} · data through ${formatDay(last)}` : source;
}

/** A URL's path, or "/" for the home page. */
export const urlPath = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

/**
 * A label for each of these URLs: its path, or, where another URL has the same path (www and non-www, say),
 * the URL with its host and without "https://". Only the label changes; the row still links to its URL.
 */
export function pageLabels(urls: readonly string[]): (url: string) => string {
  const byPath = new Map<string, Set<string>>();
  for (const url of urls) {
    const path = urlPath(url);
    const seen = byPath.get(path) ?? new Set<string>();
    byPath.set(path, seen.add(url));
  }
  return (url) => ((byPath.get(urlPath(url))?.size ?? 0) > 1 ? url.replace(/^https:\/\//, "") : urlPath(url));
}

type Baseline = "none" | "missing" | "partial" | "full";

/** Whether a comparison is fair. A compare period that history only partly covers would overstate every rise. */
function baseline({ periods: { previous }, compare, first }: GscWindow): Baseline {
  if (!previous) return compare === "none" ? "none" : "missing";
  return previous.start < first ? "partial" : "full";
}

/** "28 days to Oct 30", counting only the days stored history reaches. */
function windowWords({ periods: { current }, first }: GscWindow): string {
  return `${days(daysBetween(maxDate(current.start, first), current.end) + 1)} to ${chartDay(current.end)}`;
}

const isYearBack = ({ current, previous }: Periods) => !!previous && daysBetween(previous.end, current.start) !== 1;

/** "the 28 days before" or "the same days last year". */
function earlierWords({ periods }: GscWindow): string {
  if (isYearBack(periods) || !periods.previous) return "the same days last year";
  return `the ${days(daysBetween(periods.previous.start, periods.previous.end) + 1)} before`;
}

/** The end of a figure's caption: what it's compared against, or why it isn't. Null with no compare picked. */
function versus(w: GscWindow): string | null {
  switch (baseline(w)) {
    case "none":
      return null;
    case "missing":
      return "nothing earlier to compare";
    case "partial":
      return "earlier history is incomplete";
    case "full":
      return isYearBack(w.periods) ? "vs the same days last year" : `vs the ${daysBetween(w.periods.previous!.start, w.periods.previous!.end) + 1} before`;
  }
}

const caption = (lead: string, vs: string | null) => (vs ? `${lead}, ${vs}` : lead);

/** A count's move as words: a percentage, or the plain from → to when a percentage would say more than the data does. */
function moveOf(noun: string, now: number, before: number): Move | null {
  const big = countMove(noun, now, before, "");
  if (big) return { ...big, clause: big.clause.trim() };
  if (now === before || (before !== 0 && Math.max(now, before) >= SMALL)) return null;
  return { clause: `${noun} went from ${formatNumber(before)} to ${formatNumber(now)}`, tone: now > before ? "good" : "bad", weight: before === 0 && now >= SMALL ? 1 : MIN_WEIGHT };
}

/** Moves as a sentence that names its window once, or the calm answer it's given. */
function againstEarlier(moves: (Move | null)[], w: GscWindow, calm: string): string {
  const said = briefSentence(moves.filter((m): m is Move => !!m), "");
  return said ? `${said.slice(0, -1)}, compared with ${earlierWords(w)}.` : calm;
}

/** The sentence when a window can't be compared. Null when it can, so the page says what moved. */
function noComparison(w: GscWindow): string | null {
  const b = baseline(w);
  if (b === "missing") return `Search Console data starts ${chartDay(w.first)}. Changes show once there's an earlier period to compare.`;
  if (b === "partial") return `Search Console data starts ${chartDay(w.first)}, so ${earlierWords(w)} aren't complete. Changes show once they are.`;
  return null;
}

// ─── Performance, and one query or page ─────────────────────────────────────────────────────────

export interface GscTotalsBrief extends GscWindow {
  cur: Totals;
  prev: Totals | null;
  /** Who the sentence is about: "your site", "this query", "this page". */
  subject?: string;
}

/**
 * What moved between this period and the one before. Position is impression-weighted, so it only counts
 * with enough impressions behind it on both sides.
 */
export function totalsSentence({ cur, prev, subject = "your site", ...w }: GscTotalsBrief): string {
  if (!cur.impressions && !prev?.impressions) return `${capitalize(subject)} had no impressions in the ${windowWords(w)}.`;
  const b = baseline(w);
  if (b === "none" || !prev) return noComparison(w) ?? `${capitalize(countOf(cur.clicks, "click"))} from ${countOf(cur.impressions, "impression")} in the ${windowWords(w)}.`;
  if (b !== "full") return noComparison(w)!;
  return againstEarlier([moveOf("clicks", cur.clicks, prev.clicks), moveOf("impressions", cur.impressions, prev.impressions), positionMove(cur, prev)], w, `Nothing moved much, compared with ${earlierWords(w)}.`);
}

function positionMove(cur: Totals, prev: Totals): Move | null {
  if (Math.min(cur.impressions, prev.impressions) < SMALL || !cur.position || !prev.position) return null;
  const change = cur.position - prev.position;
  if (Math.abs(change) < 0.05) return null;
  return { clause: `average position ${change < 0 ? "improved" : "slipped"} from ${prev.position.toFixed(1)} to ${cur.position.toFixed(1)}`, tone: change < 0 ? "good" : "bad", weight: Math.abs(change) / prev.position };
}

/** Clicks, impressions, CTR and position. A rate means nothing with no impressions behind it, so it says so. */
export function totalsFigures({ cur, prev, ...w }: GscTotalsBrief): FigureData[] {
  const earlier = baseline(w) === "full" ? prev : null;
  const vs = versus(w);
  const seen = cur.impressions > 0;
  const noRate = "No impressions in this period.";
  return [
    value({ id: "clicks", label: "Clicks", value: formatNumber(cur.clicks), delta: earlier ? countDelta(cur.clicks, earlier.clicks) : null, caption: caption(windowWords(w), vs) }),
    value({ id: "impressions", label: "Impressions", value: formatNumber(cur.impressions), delta: earlier ? countDelta(cur.impressions, earlier.impressions) : null, caption: caption(windowWords(w), vs) }),
    seen
      ? value({ id: "ctr", label: "CTR", value: formatRate(cur.ctr), delta: earlier?.impressions ? rateDelta(cur.ctr, earlier.ctr) : null, caption: caption("Clicks per impression", vs) })
      : { state: "empty", id: "ctr", label: "CTR", text: noRate },
    seen
      ? value({
          id: "position",
          label: "Search Console position",
          value: cur.position.toFixed(1),
          delta: earlier?.impressions ? changeDelta(cur.position - earlier.position, "decimal", "down", true) : null,
          position: { value: cur.position, previous: earlier?.impressions ? earlier.position : null },
          caption: caption("Average across searches", vs),
        })
      : { state: "empty", id: "position", label: "Search Console position", text: noRate },
  ];
}

// ─── Queries and Pages ──────────────────────────────────────────────────────────────────────────

type DimNoun = "query" | "page";

const dimCount = (n: number, noun: DimNoun) => countOf(n, noun, noun === "query" ? "queries" : "pages");

/**
 * How many brought more clicks and how many fewer than the period before. The rows only hold what showed in
 * this period, so `gone` counts the ones that had clicks then and no row now: they brought fewer too. A full
 * list is the ones with the most clicks and no more, so it speaks only for them.
 */
export function dimSentence(rows: Pick<DimRow, "clicksDelta">[], noun: DimNoun, w: GscWindow, gone = 0): string {
  const plural = noun === "query" ? "queries" : "pages";
  const full = baseline(w) === "full";
  const capped = rows.length >= ROW_LIMIT;
  const limit = formatNumber(ROW_LIMIT);
  if (!rows.length && !(full && gone)) return `No ${plural} in the ${windowWords(w)}.`;
  if (!full) {
    const many = capped ? `At least ${limit} ${plural}` : capitalize(dimCount(rows.length, noun));
    return `${many} ${noun === "query" ? "showed your site" : "showed in search"} in the ${windowWords(w)}.`;
  }
  const top = `the ${limit} ${plural} with the most clicks`;
  const up = rows.filter((r) => (r.clicksDelta ?? 0) > 0).length;
  const down = rows.filter((r) => (r.clicksDelta ?? 0) < 0).length + (capped ? 0 : gone);
  const against = `compared with ${earlierWords(w)}`;
  const moved = up && down ? `${dimCount(up, noun)} brought more clicks and ${countWord(down)} brought fewer` : up ? `${dimCount(up, noun)} brought more clicks` : down ? `${dimCount(down, noun)} brought fewer clicks` : null;
  if (moved) return capped ? `Of ${top}, ${moved}, ${against}.` : `${capitalize(moved)}, ${against}.`;
  return capped ? `Clicks held steady on ${top}, ${against}.` : `Clicks held steady on every ${noun}, ${against}.`;
}

/** The size of the list and how much of it sits where. Rows only cover this period, so there's no fair change to show. */
export function dimFigures(rows: Pick<DimRow, "clicks" | "position">[], noun: DimNoun, w: GscWindow): FigureData[] {
  const label = noun === "query" ? "Queries" : "Pages";
  const count = rows.length >= ROW_LIMIT ? `${formatNumber(ROW_LIMIT)}+` : formatNumber(rows.length);
  return [
    value({ id: "count", label, value: count, caption: windowWords(w) }),
    value({ id: "clicks", label: "With clicks", value: formatNumber(rows.filter((r) => r.clicks > 0).length), caption: "At least one click in this period" }),
    value({ id: "page-one", label: "On page one", value: formatNumber(rows.filter((r) => r.position >= 1 && r.position <= 10).length), caption: "Average position in the top 10" }),
    value({ id: "close", label: "Close to page one", value: formatNumber(rows.filter((r) => r.position > 10 && r.position <= 20).length), caption: "Average position 11 to 20" }),
  ];
}

// ─── Opportunities ──────────────────────────────────────────────────────────────────────────────

export interface OpportunityCounts {
  striking: number;
  low: number;
  declining: number;
  missedClicks: number;
  /** How many queries those counts were read from. The list stops at its limit, so at the limit they speak only for those. */
  queriesRead?: number;
  /** The positions `striking` counts. Defaults to 4 to 20. */
  range?: PositionRange;
}

/** "the 5,000 queries with the most clicks" when the query list stopped at its limit. */
function queriesScope(queriesRead = 0): string | null {
  return queriesRead >= ROW_LIMIT ? `the ${formatNumber(ROW_LIMIT)} queries with the most clicks` : null;
}

export function opportunitiesSentence({ striking, low, declining, queriesRead }: OpportunityCounts): string {
  const scope = queriesScope(queriesRead);
  const queries = [
    striking ? `${dimCount(striking, "query")} ${striking === 1 ? "is" : "are"} close to the top` : null,
    low ? `${dimCount(low, "query")} ${low === 1 ? "gets" : "get"} fewer clicks than ${low === 1 ? "its position" : "their positions"} should` : null,
  ].filter((p): p is string => !!p);
  const pages = declining ? `${dimCount(declining, "page")} ${declining === 1 ? "is" : "are"} losing clicks` : null;
  // Pages aren't in that list, so they get a sentence of their own rather than sitting under its scope.
  if (scope && queries.length) return `Among ${scope}, ${queries.join(" and ")}.${pages ? ` ${capitalize(pages)}.` : ""}`;
  const parts = pages ? [...queries, pages] : queries;
  if (!parts.length) return scope ? `Nothing stands out among ${scope}.` : "Nothing stands out in this period.";
  const said = parts.length === 3 ? `${parts[0]}, ${parts[1]}, and ${parts[2]}` : parts.join(" and ");
  return `${capitalize(said)}.`;
}

export function opportunityFigures({ striking, low, declining, missedClicks, queriesRead, range = STRIKING_RANGE }: OpportunityCounts, w: GscWindow, rangeDays: number): FigureData[] {
  const b = baseline(w);
  const scope = queriesScope(queriesRead);
  const among = scope ? `, among ${scope}` : "";
  return [
    value({ id: "striking", label: "Close to the top", value: formatNumber(striking), caption: `Queries at position ${range.min} to ${range.max}, ${windowWords(w)}${among}` }),
    value({ id: "low", label: "Fewer clicks than expected", value: formatNumber(low), caption: `Queries in the top 10${among}` }),
    value({ id: "missed", label: "Clicks missed", value: formatNumber(missedClicks), caption: `Against a typical result at those positions${among}` }),
    b === "none"
      ? { state: "empty", id: "declining", label: "Pages losing clicks", text: "Needs a compare period.", action: { label: "Compare with the period before", href: `/gsc/opportunities?days=${rangeDays}&compare=prev` } }
      : b === "missing"
        ? { state: "empty", id: "declining", label: "Pages losing clicks", text: "Nothing earlier to compare yet." }
        : value({ id: "declining", label: "Pages losing clicks", value: formatNumber(declining), caption: b === "full" ? `Down 30% or more, ${versus(w)}` : "Down 30% or more, earlier history is incomplete" }),
  ];
}

/** "Search Console, Oct 3 to Oct 30, 2026": where a number comes from and the days it covers. */
export function searchConsoleSpan(range: DateRange): string {
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  return `Search Console, ${sameYear ? chartDay(range.start) : formatDay(range.start)} to ${formatDay(range.end)}`;
}

/** A warning when the property has under 90 days of stored data, or null. The data still shows. */
export function noisyNote(data: { first: string; last: string }): string | null {
  const stored = daysBetween(data.first, data.last) + 1;
  if (stored >= NOISY_UNDER_DAYS) return null;
  return `Search Console has ${days(stored)} of data for this site so far. Under ${NOISY_UNDER_DAYS} days, positions rest on few searches, so these results may be noisy.`;
}

// ─── Countries and devices ──────────────────────────────────────────────────────────────────────

export interface BreakdownRow {
  name: string;
  clicks: number;
  share: number;
  ctr: number;
  impressions: number;
  position: number;
  clicksDelta: number | null;
}

const before = (r: BreakdownRow) => (r.clicksDelta == null ? null : r.clicks - r.clicksDelta);

/** Which device moved, or where the clicks come from when none did. */
export function breakdownSentence(devices: BreakdownRow[], countries: BreakdownRow[], w: GscWindow): string {
  const topDevice = devices[0];
  const topCountry = countries[0];
  if (!topDevice && !topCountry) return `No country or device data in the ${windowWords(w)}.`;
  const lead = [topDevice && `${topDevice.name} brings ${formatPct(topDevice.share, 0)} of clicks`, topCountry && `${topCountry.name} brings ${formatPct(topCountry.share, 0)}`].filter(Boolean).join(" and ");
  const calm = `${lead}.`;
  if (baseline(w) !== "full") return calm;
  return againstEarlier(
    devices.map((d) => {
      const earlier = before(d);
      return earlier == null ? null : moveOf(`${d.name.toLowerCase()} clicks`, d.clicks, earlier);
    }),
    w,
    calm,
  );
}

/** A figure per device, then how far the countries reach. */
export function breakdownFigures(devices: BreakdownRow[], countries: BreakdownRow[], w: GscWindow): FigureData[] {
  const fair = baseline(w) === "full";
  const figures = devices.slice(0, 3).map((d) =>
    value({
      id: d.name,
      label: d.name,
      value: formatNumber(d.clicks),
      delta: fair ? countDelta(d.clicks, before(d)) : null,
      caption: `${formatPct(d.share)} of clicks · CTR ${formatRate(d.ctr)}${d.impressions ? ` · position ${d.position.toFixed(1)}` : ""}`,
    }),
  );
  const top = countries[0];
  if (top) figures.push(value({ id: "countries", label: "Countries", value: formatNumber(countries.length), caption: `${top.name} brings the most, ${formatPct(top.share)} of clicks` }));
  return figures;
}

// ─── URL inspection ─────────────────────────────────────────────────────────────────────────────

const PASSED = new Set(["PASS"]);
const FAILED = new Set(["FAIL", "ERROR"]);

/** Google's verdict in plain words. */
export const VERDICT_WORDS: Record<string, string> = { PASS: "Passed", PARTIAL: "Partly passed", NEUTRAL: "Neutral", FAIL: "Failed", ERROR: "Error" };

/** Google's enum values read as words: "INDEXING_ALLOWED" is "Indexing allowed". Its own sentences pass through. */
export function plainState(state: string): string {
  return /^[A-Z_]+$/.test(state) ? capitalize(state.replaceAll("_", " ").toLowerCase()) : state;
}

/** The newest inspection of each URL, newest first; the history can hold a URL several times. */
function latestPerUrl<T extends { url: string }>(history: T[]): T[] {
  const seen = new Set<string>();
  return history.filter((h) => !seen.has(h.url) && seen.add(h.url));
}

type Inspection = { url: string; verdict: string | null };

function verdictCounts(history: Inspection[]) {
  const urls = latestPerUrl(history);
  const passed = urls.filter((h) => PASSED.has(h.verdict ?? "")).length;
  const failed = urls.filter((h) => FAILED.has(h.verdict ?? "")).length;
  return { urls: urls.length, passed, failed, other: urls.length - passed - failed };
}

export function inspectSentence(history: Inspection[]): string {
  const { urls, passed, failed, other } = verdictCounts(history);
  if (!urls) return "Nothing inspected yet. Enter a URL to see what Google knows about it.";
  if (passed === urls) return urls === 1 ? "The one URL you inspected passed." : urls === 2 ? "Both URLs you inspected passed." : `All ${countOf(urls, "URL")} you inspected passed.`;
  const rest = [passed ? `${countWord(passed)} passed` : null, failed ? `${countWord(failed)} failed` : null, other ? `${countWord(other)} ${other === 1 ? "needs" : "need"} a look` : null].filter(Boolean).join(", ");
  return `Of the ${countOf(urls, "URL")} you inspected, ${rest}.`;
}

/** Nothing to count before the first inspection, so no figures. */
export function inspectFigures(history: Inspection[]): FigureData[] {
  const { urls, passed, failed, other } = verdictCounts(history);
  if (!urls) return [];
  return [
    value({ id: "urls", label: "URLs inspected", value: formatNumber(urls), caption: "From your recent inspections" }),
    value({ id: "passed", label: "Passed", value: formatNumber(passed), caption: "At their newest inspection" }),
    value({ id: "other", label: "Need a look", value: formatNumber(other), caption: "Neutral or partly passed" }),
    value({ id: "failed", label: "Failed", value: formatNumber(failed), caption: "At their newest inspection" }),
  ];
}

// ─── Sitemaps ───────────────────────────────────────────────────────────────────────────────────

type SitemapBrief = { errors: number; warnings: number; submitted: number; isPending: boolean };

export function sitemapsSentence(maps: SitemapBrief[]): string {
  if (!maps.length) return "No sitemaps submitted in Search Console yet.";
  const failing = maps.filter((m) => m.errors > 0).length;
  const pending = maps.filter((m) => m.isPending).length;
  if (failing) return `${capitalize(countOf(failing, "sitemap"))} ${failing === 1 ? "has" : "have"} errors.`;
  if (pending) return `${capitalize(countOf(pending, "sitemap"))} ${pending === 1 ? "is" : "are"} waiting for Google to read ${pending === 1 ? "it" : "them"}.`;
  if (maps.length === 1) return "Your one sitemap has no errors.";
  return maps.length === 2 ? "Both sitemaps have no errors." : `All ${countOf(maps.length, "sitemap")} have no errors.`;
}

export function sitemapFigures(maps: SitemapBrief[]): FigureData[] {
  if (!maps.length) return [];
  const sum = (read: (m: SitemapBrief) => number) => maps.reduce((n, m) => n + read(m), 0);
  return [
    value({ id: "sitemaps", label: "Sitemaps", value: formatNumber(maps.length), caption: "Submitted in Search Console" }),
    value({ id: "urls", label: "URLs", value: formatNumber(sum((m) => m.submitted)), caption: "Listed across them" }),
    value({ id: "errors", label: "Errors", value: formatNumber(sum((m) => m.errors)), caption: "As Google last read them" }),
    value({ id: "warnings", label: "Warnings", value: formatNumber(sum((m) => m.warnings)), caption: "As Google last read them" }),
  ];
}
