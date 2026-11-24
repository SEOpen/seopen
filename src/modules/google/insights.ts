/** Pure rules for the Opportunities views. Inputs are rows already aggregated over a period. */

import { isLikelyBotQuery } from "./bot-queries";

export interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Rough organic CTR by average position for a plain web result. Real curves vary by query
 * type and SERP features; this is a yardstick for "below expected", not a forecast.
 */
const CTR_CURVE = [0.28, 0.15, 0.1, 0.07, 0.053, 0.04, 0.032, 0.026, 0.021, 0.018];

export function expectedCtr(position: number): number {
  if (!(position >= 1)) return CTR_CURVE[0];
  if (position > 20) return 0.004;
  if (position > 10) return 0.01;
  const lo = Math.floor(position);
  const hi = Math.min(lo + 1, 10);
  const t = position - lo;
  return CTR_CURVE[lo - 1] * (1 - t) + CTR_CURVE[hi - 1] * t;
}

/** Average positions counted as close to the top, both ends included. */
export interface PositionRange {
  min: number;
  max: number;
}

/** The default: just off the top three, to the bottom of page two. */
export const STRIKING_RANGE: PositionRange = { min: 4, max: 20 };

/** The ranges the Opportunities page offers. The score's weight reaches about zero past 20, so none goes further. */
export const STRIKING_RANGES: readonly PositionRange[] = [STRIKING_RANGE, { min: 4, max: 10 }, { min: 11, max: 20 }];

/** "4-20", for a URL. */
export const rangeKey = (r: PositionRange) => `${r.min}-${r.max}`;

/** A range from a URL or an agent: whole positions from 1 to 20, low end first. Anything else is the default. */
export function parseRange(min: unknown, max: unknown): PositionRange {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 20 || lo > hi) return STRIKING_RANGE;
  return { min: lo, max: hi };
}

/** Impressions a query (or a page's searches together) needs to count, scaled to the period so a 7-day view still finds something. */
export const strikingMinImpressions = (days: number) => Math.round(50 * Math.max(days / 28, 0.25));

/** Positions in the range with enough impressions to matter: a small ranking gain brings real clicks. */
export function strikingDistance<T extends Metrics>(rows: T[], minImpressions = 50, range: PositionRange = STRIKING_RANGE): T[] {
  return rows
    .filter((r) => r.position >= range.min && r.position <= range.max && r.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions);
}

/** How much one search counts toward its page's score: 1 at position 4, a seventeenth at 20. */
export const strikingWeight = (position: number) => (21 - position) / 17;

/** How much a search at this position counts, in words: "in full" at 4, "a seventeenth" at 20. */
function weightWords(position: number): string {
  if (position === 4) return "in full";
  if (position === 20) return "a seventeenth";
  return `${21 - position}/17${position < 4 ? ", more than in full" : ""}`;
}

/** The score, in words, with what the ends of this range count. */
export function strikingFormula(range: PositionRange = STRIKING_RANGE): string {
  const ends = range.min === range.max ? `A search at position ${range.min} counts ${weightWords(range.min)}.` : `A search at position ${range.min} counts ${weightWords(range.min)}, one at ${range.max} counts ${weightWords(range.max)}.`;
  return `Score: for each search in the range, impressions × (21 − position) ÷ 17, added up for the page. ${ends}`;
}

/** The score, in words, for a tooltip or an agent. */
export const STRIKING_FORMULA = strikingFormula();

export interface StrikingQuery {
  query: string;
  position: number;
  impressions: number;
  clicks: number;
}

export interface StrikingPage {
  page: string;
  score: number;
  /** Searches the page shows for in the range. */
  queries: number;
  impressions: number;
  clicks: number;
  bestPosition: number;
  /** The search adding most to the score. */
  topQuery: StrikingQuery;
  /** Its searches in the range, most score first. */
  list: StrikingQuery[];
}

/**
 * Searches in the range grouped by the page Google showed, scored and sorted by score. Input is
 * query-and-page rows over one period. A page needs `minImpressions` across its searches in range.
 */
export function strikingPages(pairs: readonly (StrikingQuery & { page: string })[], range: PositionRange = STRIKING_RANGE, minImpressions = 50): StrikingPage[] {
  const byPage = new Map<string, StrikingQuery[]>();
  for (const p of searchedPairs(pairs)) {
    if (!(p.impressions > 0) || p.position < range.min || p.position > range.max) continue;
    const list = byPage.get(p.page) ?? [];
    list.push({ query: p.query, position: p.position, impressions: p.impressions, clicks: p.clicks });
    byPage.set(p.page, list);
  }
  const part = (q: StrikingQuery) => q.impressions * strikingWeight(q.position);
  const out: StrikingPage[] = [];
  for (const [page, list] of byPage) {
    const impressions = list.reduce((n, q) => n + q.impressions, 0);
    if (impressions < minImpressions) continue;
    list.sort((a, b) => part(b) - part(a) || b.impressions - a.impressions || a.query.localeCompare(b.query));
    out.push({
      page,
      score: Math.round(list.reduce((n, q) => n + part(q), 0) * 10) / 10,
      queries: list.length,
      impressions,
      clicks: list.reduce((n, q) => n + q.clicks, 0),
      bestPosition: Math.min(...list.map((q) => q.position)),
      topQuery: list[0],
      list,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.impressions - a.impressions || a.page.localeCompare(b.page));
}

/** Under this many days of stored Search Console data, averages rest on little and the lists may be noisy. */
export const NOISY_UNDER_DAYS = 90;

/** Top-10 rows whose CTR is under half the expected CTR for their position. */
export function lowCtr<T extends Metrics>(rows: T[], minImpressions = 100): (T & { expectedCtr: number; missedClicks: number })[] {
  return rows
    .filter((r) => r.position <= 10 && r.impressions >= minImpressions)
    .map((r) => {
      const exp = expectedCtr(r.position);
      return { ...r, expectedCtr: exp, missedClicks: Math.round(exp * r.impressions - r.clicks) };
    })
    .filter((r) => r.ctr < r.expectedCtr * 0.5)
    .sort((a, b) => b.missedClicks - a.missedClicks);
}

/** Rows whose clicks fell by at least `minDrop` (0.3 = 30%) against the compare period. */
export function declining<T extends { clicks: number; prevClicks: number | null }>(
  rows: T[],
  minPrevClicks = 10,
  minDrop = 0.3,
): (T & { lostClicks: number; change: number })[] {
  return rows
    .filter((r) => (r.prevClicks ?? 0) >= minPrevClicks)
    .map((r) => ({ ...r, lostClicks: r.prevClicks! - r.clicks, change: (r.clicks - r.prevClicks!) / r.prevClicks! }))
    .filter((r) => r.change <= -minDrop)
    .sort((a, b) => b.lostClicks - a.lostClicks);
}

// ---------- One search on several pages, and pages shown far down ----------

/**
 * gsc-split-query: a search counts as split when, over the period, it has at least this many
 * impressions across the site's pages. Under 50 in 28 days, which page Google picks shifts from
 * week to week and a split says little.
 */
export const SPLIT_MIN_SEARCH_IMPRESSIONS = 50;
/** Or this share of the whole site's impressions, if that's more, so a big site isn't flooded with its long tail. */
export const SPLIT_SITE_SHARE = 0.001;
/**
 * Each page counted holds at least this many of the search's impressions, and this share of them.
 * A page with a sliver of a search is Google trying it once, not two pages competing.
 */
export const SPLIT_MIN_PAGE_IMPRESSIONS = 10;
export const SPLIT_MIN_PAGE_SHARE = 0.1;
/**
 * When every page counted averages this position or better, the site holds two results at the top
 * (a double listing, or a brand search's sitelinks). That's a win, not a split.
 */
export const SPLIT_DOUBLE_LISTING = 3;

export interface PairMetrics {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Below this many impressions two rows can match by chance, so neither counts as a sitelink. */
export const SITELINK_MIN_IMPRESSIONS = 10;
/** A page whose impressions are mostly sitelink rows is a sitelink page: its numbers are another result's. */
export const SITELINK_PAGE_SHARE = 0.8;

const pairKey = (query: string, page: string) => `${query}\u0000${page}`;
const pathLength = (url: string) => {
  try {
    return new URL(url).pathname.length;
  } catch {
    return url.length;
  }
};

/**
 * Rows that are sitelinks under another page's result. When Google shows links under a result
 * (About, Pricing, Contact under the home page), Search Console counts an impression for each link
 * at the result's position, so the link's row for that search repeats the result's numbers. A row
 * counts as one when another page has the same search with as many impressions (within 5%) at the
 * same position (within half a place). The result is the row with the most impressions, the shorter
 * address on a tie, so the home page keeps its searches and the links under it lose them.
 */
export function sitelinkCopies(pairs: readonly PairMetrics[]): Set<string> {
  const byQuery = new Map<string, PairMetrics[]>();
  for (const p of pairs) if (p.impressions >= SITELINK_MIN_IMPRESSIONS) byQuery.set(p.query, [...(byQuery.get(p.query) ?? []), p]);
  const out = new Set<string>();
  for (const rows of byQuery.values()) {
    if (rows.length < 2) continue;
    const lead = rows.reduce((a, b) => (b.impressions > a.impressions || (b.impressions === a.impressions && pathLength(b.page) < pathLength(a.page)) ? b : a));
    for (const r of rows) {
      if (r === lead) continue;
      if (Math.abs(r.impressions - lead.impressions) <= Math.max(1, lead.impressions * 0.05) && Math.abs(r.position - lead.position) <= 0.5) out.add(pairKey(r.query, r.page));
    }
  }
  return out;
}

/** Pages whose impressions are mostly sitelink rows (`sitelinkCopies`): a finding about one would be about the result above it. */
export function sitelinkPages(pairs: readonly PairMetrics[], copies = sitelinkCopies(pairs)): Set<string> {
  const total = new Map<string, number>();
  const copied = new Map<string, number>();
  for (const p of pairs) {
    total.set(p.page, (total.get(p.page) ?? 0) + p.impressions);
    if (copies.has(pairKey(p.query, p.page))) copied.set(p.page, (copied.get(p.page) ?? 0) + p.impressions);
  }
  return new Set([...copied].filter(([page, n]) => n >= (total.get(page) ?? 0) * SITELINK_PAGE_SHARE).map(([page]) => page));
}

/** The rows a finding about searches should read: without rank checkers' searches (`isLikelyBotQuery`) or sitelink rows (`sitelinkCopies`). */
export function searchedPairs<T extends PairMetrics>(pairs: readonly T[]): T[] {
  const people = pairs.filter((p) => !isLikelyBotQuery(p.query));
  const copies = sitelinkCopies(people);
  return copies.size ? people.filter((p) => !copies.has(pairKey(p.query, p.page))) : people;
}

export interface SplitPage {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface SplitQuery {
  query: string;
  /** The search's impressions across all of the site's pages. */
  impressions: number;
  /** The pages counted, most impressions first. */
  pages: SplitPage[];
}

/**
 * Searches Google showed on two or more of the site's pages, from query-and-page rows over one
 * period. `key` folds the addresses one page can be reported under (http, www, a trailing slash, a
 * #fragment), so those never count as two pages; each page keeps the address with most impressions.
 * Sorted by the impressions the weaker pages hold, the ones at stake.
 */
export function splitQueries(pairs: readonly PairMetrics[], siteImpressions: number, key: (page: string) => string = (p) => p): SplitQuery[] {
  const byQuery = new Map<string, Map<string, { page: string; top: number; clicks: number; impressions: number; weighted: number }>>();
  for (const p of pairs) {
    if (!(p.impressions > 0)) continue;
    const pages = byQuery.get(p.query) ?? new Map();
    const k = key(p.page);
    const a = pages.get(k) ?? { page: p.page, top: 0, clicks: 0, impressions: 0, weighted: 0 };
    if (p.impressions > a.top) Object.assign(a, { page: p.page, top: p.impressions });
    a.clicks += p.clicks;
    a.impressions += p.impressions;
    a.weighted += p.position * p.impressions;
    pages.set(k, a);
    byQuery.set(p.query, pages);
  }
  const floor = Math.max(SPLIT_MIN_SEARCH_IMPRESSIONS, siteImpressions * SPLIT_SITE_SHARE);
  const out: SplitQuery[] = [];
  for (const [query, merged] of byQuery) {
    if (merged.size < 2) continue;
    const all = [...merged.values()];
    const impressions = all.reduce((n, a) => n + a.impressions, 0);
    if (impressions < floor) continue;
    const pages = all
      .filter((a) => a.impressions >= Math.max(SPLIT_MIN_PAGE_IMPRESSIONS, impressions * SPLIT_MIN_PAGE_SHARE))
      .map((a) => ({ page: a.page, clicks: a.clicks, impressions: a.impressions, position: Math.round((a.weighted / a.impressions) * 10) / 10 }))
      .sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
    if (pages.length < 2 || pages.every((p) => p.position <= SPLIT_DOUBLE_LISTING)) continue;
    out.push({ query, impressions, pages });
  }
  const atStake = (s: SplitQuery) => s.impressions - s.pages[0].impressions;
  return out.sort((a, b) => atStake(b) - atStake(a) || b.impressions - a.impressions || a.query.localeCompare(b.query));
}

export interface SplitRecord {
  /** The page counted with the fewest impressions: where the fix is recorded. */
  page: string;
  /** The searches it's the weakest page for, most at stake first. */
  queries: SplitQuery[];
  /** This page's impressions from those searches. */
  impressions: number;
}

/**
 * One record per page, since a fix is one page and one finding: a page that's the weakest of several
 * split searches carries them all, as a close page carries its searches. Most impressions first.
 */
export function splitRecords(splits: readonly SplitQuery[], key: (page: string) => string = (p) => p): SplitRecord[] {
  const byPage = new Map<string, SplitRecord>();
  for (const s of splits) {
    const weakest = s.pages[s.pages.length - 1];
    const k = key(weakest.page);
    const r = byPage.get(k) ?? { page: weakest.page, queries: [], impressions: 0 };
    r.queries.push(s);
    r.impressions += weakest.impressions;
    byPage.set(k, r);
  }
  return [...byPage.values()].sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
}

/**
 * gsc-shown-not-ranking: a page past this average position. Past 30 is past page three, where
 * almost nobody clicks, so a better title changes nothing: the content and links have to move it.
 */
export const SHOWN_PAST_POSITION = 30;
/** And with at least this many impressions over the period: fewer is a page Google barely tries. */
export const SHOWN_MIN_IMPRESSIONS = 200;
/** Or this share of the whole site's impressions, if that's more, so a big site lists only its pages that matter. */
export const SHOWN_SITE_SHARE = 0.01;

/** Pages Google shows often but far down the results, most impressions first. */
export function shownNotRanking<T extends Metrics>(rows: readonly T[], siteImpressions: number): T[] {
  const floor = Math.max(SHOWN_MIN_IMPRESSIONS, siteImpressions * SHOWN_SITE_SHARE);
  return rows.filter((r) => r.position > SHOWN_PAST_POSITION && r.impressions >= floor).sort((a, b) => b.impressions - a.impressions);
}

/**
 * gsc-wrong-page-type: a search ties to the page Google showed most for it when that page holds at
 * least this many of its impressions over the period, the same floor as a split search. Fewer, and
 * which page Google tries shifts from week to week.
 */
export const WRONG_TYPE_MIN_IMPRESSIONS = 50;
/** Or this share of the whole site's impressions, if that's more, so a big site isn't flooded with its long tail. */
export const WRONG_TYPE_SITE_SHARE = 0.001;

export interface SearchPage {
  query: string;
  /** The page with most of the search's impressions, under the address it has most of them on. */
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/**
 * For each search, the page Google showed most for it, when that page holds enough of its
 * impressions to count. `key` folds the addresses one page can be reported under. Most impressions first.
 */
export function searchPages(pairs: readonly PairMetrics[], siteImpressions: number, key: (page: string) => string = (p) => p): SearchPage[] {
  const byQuery = new Map<string, Map<string, { page: string; top: number; clicks: number; impressions: number; weighted: number }>>();
  for (const p of pairs) {
    if (!(p.impressions > 0)) continue;
    const pages = byQuery.get(p.query) ?? new Map();
    const k = key(p.page);
    const a = pages.get(k) ?? { page: p.page, top: 0, clicks: 0, impressions: 0, weighted: 0 };
    if (p.impressions > a.top) Object.assign(a, { page: p.page, top: p.impressions });
    a.clicks += p.clicks;
    a.impressions += p.impressions;
    a.weighted += p.position * p.impressions;
    pages.set(k, a);
    byQuery.set(p.query, pages);
  }
  const floor = Math.max(WRONG_TYPE_MIN_IMPRESSIONS, siteImpressions * WRONG_TYPE_SITE_SHARE);
  const out: SearchPage[] = [];
  for (const [query, pages] of byQuery) {
    const best = [...pages.values()].sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page))[0];
    if (best.impressions < floor) continue;
    out.push({ query, page: best.page, clicks: best.clicks, impressions: best.impressions, position: Math.round((best.weighted / best.impressions) * 10) / 10 });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
}
