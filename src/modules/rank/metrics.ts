// Rank tracking math. Pure functions; see metrics.test.ts.

/**
 * Share of searchers who click each organic position (1-indexed), averaged
 * from public CTR studies and rounded. Only the shape matters: position 1
 * takes the lion's share and page 2 is worth little.
 */
const CTR_TOP20 = [
  0.28, 0.157, 0.11, 0.08, 0.072, 0.051, 0.04, 0.032, 0.028, 0.025, 0.012, 0.011, 0.01, 0.009, 0.008, 0.007, 0.006,
  0.006, 0.005, 0.005,
];

/** Expected click-through rate for an organic position. Null (not ranking) is 0. */
export function ctr(position: number | null | undefined): number {
  if (position == null || !Number.isFinite(position) || position < 1) return 0;
  const p = Math.floor(position);
  if (p <= 20) return CTR_TOP20[p - 1];
  if (p <= 30) return 0.003;
  if (p <= 50) return 0.0015;
  if (p <= 100) return 0.0005;
  return 0;
}

/** Clicks the whole top 20 earns per search; the denominator for share of voice. */
export const CTR_TOP20_TOTAL = CTR_TOP20.reduce((a, b) => a + b, 0);

export interface RankRow {
  position: number | null;
  /** Monthly search volume; null when unknown. */
  volume: number | null;
  /** No look could confirm it, so the position is the last one seen (docs/dataforseo.md, Rechecks). */
  notChecked?: boolean;
}

/**
 * Visibility: the CTR-weighted share of the best possible result. Every
 * keyword at #1 is 1 (100%), nothing ranking is 0. Volume is ignored, so
 * every tracked keyword counts the same. Null for an empty set.
 */
export function visibility(positions: (number | null)[]): number | null {
  if (!positions.length) return null;
  const sum = positions.reduce<number>((s, p) => s + ctr(p), 0);
  return sum / (positions.length * ctr(1));
}

/** Estimated monthly organic clicks: CTR at the position × search volume. Unknown volume counts as 0. */
export function estimatedTraffic(rows: RankRow[]): number {
  return rows.reduce((s, r) => s + ctr(r.position) * (r.volume ?? 0), 0);
}

/**
 * Share of voice: the share of all top-20 clicks on the tracked SERPs that go
 * to one domain, weighting each keyword by its volume. Summed over every
 * domain on the SERPs it approaches 1. When no keyword has a volume, each
 * keyword weighs the same so the number still moves.
 */
export function shareOfVoice(rows: RankRow[], counted: (r: RankRow) => boolean = () => true): number | null {
  if (!rows.length) return null;
  const useVolume = rows.some((r) => (r.volume ?? 0) > 0);
  let earned = 0;
  let possible = 0;
  for (const r of rows) {
    const w = useVolume ? (r.volume ?? 0) : 1;
    // `counted` picks the clicks to add up; every row still weighs on the whole, so the parts add up to the share.
    if (counted(r)) earned += w * ctr(r.position);
    possible += w * CTR_TOP20_TOTAL;
  }
  return possible ? earned / possible : 0;
}

/** Mean position over the keywords that rank; null when none do. */
export function averagePosition(positions: (number | null)[]): number | null {
  const ranked = positions.filter((p): p is number => p != null);
  return ranked.length ? ranked.reduce((a, b) => a + b, 0) / ranked.length : null;
}

export type Bucket = "1-3" | "4-10" | "11-20" | "21-100" | "none";

export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "1-3", label: "Top 3" },
  { key: "4-10", label: "4–10" },
  { key: "11-20", label: "11–20" },
  { key: "21-100", label: "21–100" },
  { key: "none", label: "Not found" },
];

export function bucketOf(position: number | null): Bucket {
  if (position == null) return "none";
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  if (position <= 20) return "11-20";
  if (position <= 100) return "21-100";
  return "none";
}

export interface TopCounts {
  top3: number;
  top10: number;
  top20: number;
  top100: number;
}

/** Cumulative counts: a #2 counts in top 3, 10, 20 and 100. */
export function topCounts(positions: (number | null)[]): TopCounts {
  const c = { top3: 0, top10: 0, top20: 0, top100: 0 };
  for (const p of positions) {
    if (p == null) continue;
    if (p <= 3) c.top3++;
    if (p <= 10) c.top10++;
    if (p <= 20) c.top20++;
    if (p <= 100) c.top100++;
  }
  return c;
}

export type Change = "improved" | "declined" | "new" | "lost" | "unchanged" | "none";

/** How a keyword moved between two checks. Lower positions are better. */
export function classifyChange(start: number | null | undefined, end: number | null | undefined): Change {
  const s = start ?? null;
  const e = end ?? null;
  if (s == null && e == null) return "none";
  if (s == null) return "new";
  if (e == null) return "lost";
  if (e < s) return "improved";
  if (e > s) return "declined";
  return "unchanged";
}

/** Positions gained (positive is better), null when either side is missing. */
export function positionDelta(start: number | null | undefined, end: number | null | undefined): number | null {
  return start == null || end == null ? null : start - end;
}

export interface Summary extends TopCounts {
  keywords: number;
  /** How many positions no look could confirm. Each still counts in every figure here. */
  notConfirmed: number;
  /** How many of `top3` hold a position no look could confirm. */
  top3NotConfirmed: number;
  /** How many of `top10` hold a position no look could confirm. They stay counted, and this says so. */
  top10NotConfirmed: number;
  /** How many of `top100`, the keywords that read as ranking, hold a position no look could confirm. */
  rankingNotConfirmed: number;
  visibility: number | null;
  /** How much of `visibility` comes from those positions, on the same 0-1 scale. */
  visibilityNotConfirmed: number;
  shareOfVoice: number | null;
  /** How much of `shareOfVoice` comes from those positions, on the same 0-1 scale and weights. */
  shareOfVoiceNotConfirmed: number;
  traffic: number;
  /** How much of `traffic` comes from those positions. */
  trafficNotConfirmed: number;
  avgPosition: number | null;
  /** `avgPosition` without those positions; null when they're all that rank. */
  avgPositionConfirmed: number | null;
}

export function summarize(rows: RankRow[]): Summary {
  const positions = rows.map((r) => r.position);
  const notConfirmed = rows.filter((r) => r.notChecked);
  const unconfirmedTops = topCounts(notConfirmed.map((r) => r.position));
  return {
    keywords: rows.length,
    notConfirmed: notConfirmed.filter((r) => r.position != null).length,
    top3NotConfirmed: unconfirmedTops.top3,
    top10NotConfirmed: unconfirmedTops.top10,
    rankingNotConfirmed: unconfirmedTops.top100,
    visibility: visibility(positions),
    visibilityNotConfirmed: rows.length ? notConfirmed.reduce((s, r) => s + ctr(r.position), 0) / (rows.length * ctr(1)) : 0,
    shareOfVoice: shareOfVoice(rows),
    shareOfVoiceNotConfirmed: shareOfVoice(rows, (r) => !!r.notChecked) ?? 0,
    traffic: estimatedTraffic(rows),
    trafficNotConfirmed: estimatedTraffic(notConfirmed),
    avgPosition: averagePosition(positions),
    avgPositionConfirmed: averagePosition(rows.filter((r) => !r.notChecked).map((r) => r.position)),
    ...topCounts(positions),
  };
}

/**
 * Keywords on page one at `to` on a position no look could confirm, that weren't on page one at `from`:
 * the part of a gain between two checks that rests on what no look confirmed.
 */
export function pageOneGainsNotConfirmed(rows: (Pick<RankRow, "position" | "notChecked"> & { keywordId: number; date: string })[], from: string, to: string): number {
  const onPageOne = (p: number | null) => p != null && p <= 10;
  const already = new Set(rows.filter((r) => r.date === from && onPageOne(r.position)).map((r) => r.keywordId));
  return rows.filter((r) => r.date === to && r.notChecked && onPageOne(r.position) && !already.has(r.keywordId)).length;
}

/**
 * Whether a rise in On page one rests wholly on positions no look confirmed: without the keywords that
 * reached it that way, the count wouldn't have risen. Then the rise is said, but not as good news.
 */
export function pageOneGainUnconfirmed(d: { latest: { top10: number }; previous: { top10: number } | null; pageOneGainsNotConfirmed: number }): boolean {
  if (!d.previous) return false;
  const gain = d.latest.top10 - d.previous.top10;
  return gain > 0 && d.pageOneGainsNotConfirmed >= gain;
}

/** Groups dated rows into one summary per date, oldest first. */
export function summarizeByDate<T extends RankRow & { date: string }>(rows: T[]): (Summary & { date: string })[] {
  const byDate = new Map<string, T[]>();
  for (const r of rows) {
    const list = byDate.get(r.date);
    if (list) list.push(r);
    else byDate.set(r.date, [r]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({ date, ...summarize(list) }));
}

/** SERP pages billed per check: one base price per 10 results, rounded up. */
export function pagesForDepth(depth: number): number {
  return Math.max(1, Math.ceil(depth / 10));
}

/** Standard queue, normal priority: price per 10 results (docs/dataforseo.md, checked against user_data 2026-10-29). */
export const SERP_STD_PRICE = 0.0006;

/** DataForSEO bills a task whose keyword uses search operators (`site:`, `intitle:`) at this multiple (docs/dataforseo.md). */
export const OPERATOR_PRICE_MULTIPLE = 5;

/**
 * Estimated cost of one look at `keywords` keywords. Async AI Overview adds one base price per task,
 * and so does `resolve_poisoned_results`, which every rank task sends (src/lib/dataforseo/poisoned.ts).
 * `withOperators` of them use search operators: they're refused when added, but one stored before
 * that still bills at 5×.
 */
export function estimateCheckCost(keywords: number, depth: number, aiOverview = false, withOperators = 0): number {
  const tasks = keywords + withOperators * (OPERATOR_PRICE_MULTIPLE - 1);
  return tasks * (pagesForDepth(depth) + 1 + (aiOverview ? 1 : 0)) * SERP_STD_PRICE;
}

/**
 * What loading volumes costs, for the Add keywords card: Labs keyword_overview takes up to 700
 * keywords a call at $0.012 plus $0.00012 per keyword with data, and a project tracking a city
 * adds one $0.09 Google Ads Live task per batch (docs/dataforseo.md, tracker.ts `fetchVolumes`).
 */
export function volumeCostNote(city: boolean): string {
  return `≈ $0.012 per batch of up to 700 keywords plus $0.00012 per keyword${city ? ", and $0.09 per batch for the city's Google Ads volumes" : ""}, cached 30 days`;
}

/** The first look at a keyword plus at most two rechecks (recheck.ts). */
export const MAX_LOOKS = 3;

/**
 * The most a check can cost: every keyword rechecked twice. What a keyword really costs depends on
 * how many looks it took; the ledger and `rank_runs.cost_usd` record that.
 */
export function maxCheckCost(keywords: number, depth: number, aiOverview = false): number {
  return estimateCheckCost(keywords, depth, aiOverview) * MAX_LOOKS;
}
