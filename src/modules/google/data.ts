import { and, asc, between, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { ga4LandingDaily, googleSyncState, gscBreakdown, gscDaily, gscPages, gscQueries, gscQueryPages, gscUrlInspections } from "@/db/schema";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { isLikelyBotQuery, LIKELY_BOT_PATTERN } from "./bot-queries";
import { STRIKING_RANGE, strikingPages, type PositionRange, type StrikingPage } from "./insights";
import { pageKey } from "./matching";
import { pctChange, type DateRange } from "./windowing";

/** Metric aggregates over a period. Position is impression-weighted, as GSC reports it. */
function aggCols(t: { clicks: PgColumn; impressions: PgColumn; position: PgColumn }) {
  return {
    clicks: sql<number>`coalesce(sum(${t.clicks}), 0)::int`,
    impressions: sql<number>`coalesce(sum(${t.impressions}), 0)::int`,
    position: sql<number>`coalesce(sum(${t.position} * ${t.impressions}) / nullif(sum(${t.impressions}), 0), 0)::float`,
  };
}

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const withCtr = <T extends { clicks: number; impressions: number }>(r: T) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 });

export async function gscDataRange(scope: ProjectScope): Promise<{ first: string; last: string } | null> {
  const [r] = await db
    .select({ first: sql<string | null>`min(${gscDaily.date})::text`, last: sql<string | null>`max(${gscDaily.date})::text` })
    .from(gscDaily)
    .where(inScope(gscDaily, scope));
  return r?.first && r.last ? { first: r.first, last: r.last } : null;
}

/** The site's totals over the period, less searches that look like rank checks (`gscSeries`). */
export async function gscTotals(scope: ProjectScope, range: DateRange): Promise<Totals> {
  const rows = await gscSeries(scope, range);
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  const weighted = rows.reduce((n, r) => n + r.position * r.impressions, 0);
  return withCtr({ clicks, impressions, position: impressions ? weighted / impressions : 0 });
}

/** Each day's clicks, impressions and position × impressions from searches that look like another tool's rank check (`isLikelyBotQuery`). */
async function likelyBotDays(scope: ProjectScope, range: DateRange) {
  return db
    .select({
      date: sql<string>`${gscQueries.date}::text`,
      clicks: sql<number>`coalesce(sum(${gscQueries.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${gscQueries.impressions}), 0)::int`,
      weighted: sql<number>`coalesce(sum(${gscQueries.position} * ${gscQueries.impressions}), 0)::float`,
    })
    .from(gscQueries)
    .where(and(inScope(gscQueries, scope), between(gscQueries.date, range.start, range.end), sql`${gscQueries.query} ~ ${LIKELY_BOT_PATTERN}`))
    .groupBy(gscQueries.date);
}

/** What searches that look like rank checks added to the stored totals over the period, which `gscTotals` leaves out. */
export async function gscLikelyBotTotals(scope: ProjectScope, range: DateRange): Promise<{ clicks: number; impressions: number }> {
  const days = await likelyBotDays(scope, range);
  return { clicks: days.reduce((n, d) => n + d.clicks, 0), impressions: days.reduce((n, d) => n + d.impressions, 0) };
}

/**
 * The site's daily totals, less searches that look like another tool's rank check. Those are taken
 * off at read time from the day's query rows, so the stored totals keep them and nothing is synced
 * again. A day's position is the stored one with the rank checks' impressions taken out of its average.
 */
export async function gscSeries(scope: ProjectScope, range: DateRange) {
  const [rows, bots] = await Promise.all([
    db
      .select({ date: sql<string>`${gscDaily.date}::text`, clicks: gscDaily.clicks, impressions: gscDaily.impressions, ctr: gscDaily.ctr, position: gscDaily.position })
      .from(gscDaily)
      .where(and(inScope(gscDaily, scope), between(gscDaily.date, range.start, range.end)))
      .orderBy(asc(gscDaily.date)),
    likelyBotDays(scope, range),
  ]);
  if (!bots.length) return rows;
  const byDay = new Map(bots.map((b) => [b.date, b]));
  return rows.map((r) => {
    const b = byDay.get(r.date);
    if (!b) return r;
    const clicks = Math.max(0, r.clicks - b.clicks);
    const impressions = Math.max(0, r.impressions - b.impressions);
    const position = impressions ? (r.position * r.impressions - b.weighted) / impressions : 0;
    // Anonymized searches and rounding can leave the stored average out of step with its rows; keep the stored one then.
    return { ...r, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: position >= 1 ? position : r.position };
  });
}

export interface DimRow extends Totals {
  key: string;
  /** A query that looks like another tool's rank check (`isLikelyBotQuery`). Query rows only. */
  likelyBot?: true;
  prevClicks: number | null;
  prevImpressions: number | null;
  prevPosition: number | null;
  clicksDelta: number | null;
  impressionsDelta: number | null;
  /** Positive = moved up (better). */
  positionDelta: number | null;
}

type DimTable = typeof gscQueries | typeof gscPages;

/** Per-query or per-page aggregates for a period, with the compare period joined in. */
async function byDimension(
  table: DimTable,
  keyCol: PgColumn,
  scope: ProjectScope,
  current: DateRange,
  previous: DateRange | null,
  filter?: SQL,
  limit = 5_000,
): Promise<DimRow[]> {
  const where = (r: DateRange) => and(inScope(table, scope), between(table.date, r.start, r.end), filter);
  const cur = await db
    .select({ key: sql<string>`${keyCol}`, ...aggCols(table) })
    .from(table)
    .where(where(current))
    .groupBy(keyCol)
    .orderBy(desc(sql`sum(${table.clicks})`), desc(sql`sum(${table.impressions})`))
    .limit(limit);
  const prev = new Map<string, { clicks: number; impressions: number; position: number }>();
  if (previous && cur.length) {
    // Only the keys on this period's list: no other key's numbers are read.
    const rows = await db
      .select({ key: sql<string>`${keyCol}`, ...aggCols(table) })
      .from(table)
      .where(and(where(previous), inArray(keyCol, cur.map((r) => r.key))))
      .groupBy(keyCol);
    for (const r of rows) prev.set(r.key, r);
  }
  return cur.map((r) => {
    const p = prev.get(r.key);
    const has = previous != null;
    return {
      ...withCtr(r),
      position: round1(r.position),
      prevClicks: has ? (p?.clicks ?? 0) : null,
      prevImpressions: has ? (p?.impressions ?? 0) : null,
      prevPosition: p ? round1(p.position) : null,
      clicksDelta: has ? r.clicks - (p?.clicks ?? 0) : null,
      impressionsDelta: has ? r.impressions - (p?.impressions ?? 0) : null,
      positionDelta: p && p.position ? round1(p.position - r.position) : null,
    };
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Pages with clicks in the compare period, driven from that period so pages that fell to zero
 * still appear. Missing current rows count as 0. Input for `declining()`.
 */
export async function gscPagesSincePrevious(scope: ProjectScope, current: DateRange, previous: DateRange, minPrevClicks: number): Promise<DimRow[]> {
  const agg = (r: DateRange) => sql`
    select ${gscPages.page} as key, sum(${gscPages.clicks})::int as clicks, sum(${gscPages.impressions})::int as impressions,
      coalesce(sum(${gscPages.position} * ${gscPages.impressions}) / nullif(sum(${gscPages.impressions}), 0), 0)::float as position
    from ${gscPages}
    where ${gscPages.workspaceId} = ${scope.workspaceId} and ${gscPages.projectId} = ${scope.projectId} and ${gscPages.date} between ${r.start} and ${r.end}
    group by ${gscPages.page}`;
  const res = await db.execute<{ key: string; p_clicks: number; p_impr: number; p_pos: number; clicks: number | null; impressions: number | null; position: number | null }>(sql`
    select p.key, p.clicks as p_clicks, p.impressions as p_impr, p.position as p_pos, c.clicks, c.impressions, c.position
    from (${agg(previous)}) p left join (${agg(current)}) c on c.key = p.key
    where p.clicks >= ${minPrevClicks}`);
  return res.map((r) => {
    const clicks = r.clicks ?? 0;
    const impressions = r.impressions ?? 0;
    const position = r.position ?? 0;
    return {
      key: r.key,
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: round1(position),
      prevClicks: r.p_clicks,
      prevImpressions: r.p_impr,
      prevPosition: round1(r.p_pos),
      clicksDelta: clicks - r.p_clicks,
      impressionsDelta: impressions - r.p_impr,
      positionDelta: position && r.p_pos ? round1(r.p_pos - position) : null,
    };
  });
}

/**
 * How many queries or pages had clicks in the compare period and no row in this one. The lists read from
 * this period, so these are absent from them, and a sentence over those lists would never see them.
 */
export async function gscGoneCount(scope: ProjectScope, kind: "query" | "page", current: DateRange, previous: DateRange): Promise<number> {
  const t = kind === "query" ? gscQueries : gscPages;
  const col = kind === "query" ? gscQueries.query : gscPages.page;
  const inRange = (r: DateRange) => and(inScope(t, scope), between(t.date, r.start, r.end));
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select ${col} from ${t} where ${inRange(previous)} group by ${col} having sum(${t.clicks}) > 0
      except
      select ${col} from ${t} where ${inRange(current)}
    ) gone`);
  return r?.n ?? 0;
}

export async function gscByQuery(scope: ProjectScope, current: DateRange, previous: DateRange | null, opts: { contains?: string; limit?: number } = {}): Promise<DimRow[]> {
  const f = opts.contains ? sql`${gscQueries.query} ilike ${`%${opts.contains}%`}` : undefined;
  const rows = await byDimension(gscQueries, gscQueries.query, scope, current, previous, f, opts.limit);
  return rows.map((r) => (isLikelyBotQuery(r.key) ? { ...r, likelyBot: true } : r));
}

/**
 * A page's address without its scheme and host, so text that `contains` looks for matches the path,
 * not the site's own domain, which every page has. `pagePathSql` is the same in Postgres.
 */
export const pagePath = (url: string) => url.replace(/^https?:\/\/[^/]*/i, "");
const pagePathSql = (col: PgColumn) => sql`regexp_replace(${col}, '^https?://[^/]*', '', 'i')`;

export function gscByPage(scope: ProjectScope, current: DateRange, previous: DateRange | null, opts: { contains?: string; limit?: number } = {}) {
  const f = opts.contains ? sql`${pagePathSql(gscPages.page)} ilike ${`%${opts.contains}%`}` : undefined;
  return byDimension(gscPages, gscPages.page, scope, current, previous, f, opts.limit);
}

export interface QueryPageRow extends DimRow {
  query: string;
  page: string;
}

/**
 * Per query-and-page aggregates for a period, with the compare period joined in: which page ranks
 * for which search. `contains` matches the query or the page's path. The sync keeps each day's top pairs
 * by clicks up to the plan's row cap, so a pair with few clicks on a big site may be missing.
 */
export async function gscByQueryPage(scope: ProjectScope, current: DateRange, previous: DateRange | null, opts: { contains?: string; limit?: number } = {}): Promise<QueryPageRow[]> {
  const t = gscQueryPages;
  const like = opts.contains ? `%${opts.contains}%` : null;
  const filter = like ? sql`(${t.query} ilike ${like} or ${pagePathSql(t.page)} ilike ${like})` : undefined;
  const where = (r: DateRange) => and(inScope(t, scope), between(t.date, r.start, r.end), filter);
  const cur = await db
    .select({ query: t.query, page: t.page, ...aggCols(t) })
    .from(t)
    .where(where(current))
    .groupBy(t.query, t.page)
    .orderBy(desc(sql`sum(${t.clicks})`), desc(sql`sum(${t.impressions})`))
    .limit(opts.limit ?? 5_000);
  const pairKey = (q: string, p: string) => `${q}\u0000${p}`;
  const prev = new Map<string, { clicks: number; impressions: number; position: number }>();
  if (previous && cur.length) {
    // Only this period's queries and pages, then only its exact pairs are kept.
    const wanted = new Set(cur.map((r) => pairKey(r.query, r.page)));
    const rows = await db
      .select({ query: t.query, page: t.page, ...aggCols(t) })
      .from(t)
      .where(and(where(previous), inArray(t.query, [...new Set(cur.map((r) => r.query))]), inArray(t.page, [...new Set(cur.map((r) => r.page))])))
      .groupBy(t.query, t.page);
    for (const r of rows) if (wanted.has(pairKey(r.query, r.page))) prev.set(pairKey(r.query, r.page), r);
  }
  const has = previous != null;
  return cur.map((r) => {
    const p = prev.get(pairKey(r.query, r.page));
    return {
      ...withCtr(r),
      key: pairKey(r.query, r.page),
      position: round1(r.position),
      prevClicks: has ? (p?.clicks ?? 0) : null,
      prevImpressions: has ? (p?.impressions ?? 0) : null,
      prevPosition: p ? round1(p.position) : null,
      clicksDelta: has ? r.clicks - (p?.clicks ?? 0) : null,
      impressionsDelta: has ? r.impressions - (p?.impressions ?? 0) : null,
      positionDelta: p && p.position ? round1(p.position - r.position) : null,
    };
  });
}

/** The most query-and-page pairs striking distance reads. A page ranking for more searches than this is scored from these. */
export const STRIKING_PAIRS = 20_000;

/**
 * Pages close to the top, grouped and scored from the query-and-page data (`strikingPages`), so the
 * Opportunities page, the recap, Fixes and the MCP read the same rows. Only pairs whose average position
 * over the period is in the range are read. `truncated` when the pair limit cut the list.
 */
export async function gscStrikingPages(scope: ProjectScope, range: DateRange, opts: { positions?: PositionRange; minImpressions?: number } = {}): Promise<{ pages: StrikingPage[]; pairsRead: number; truncated: boolean }> {
  const t = gscQueryPages;
  const positions = opts.positions ?? STRIKING_RANGE;
  const position = sql`sum(${t.position} * ${t.impressions}) / nullif(sum(${t.impressions}), 0)`;
  const rows = await db
    .select({ query: t.query, page: t.page, ...aggCols(t) })
    .from(t)
    .where(and(inScope(t, scope), between(t.date, range.start, range.end)))
    .groupBy(t.query, t.page)
    .having(sql`${position} between ${positions.min} and ${positions.max}`)
    .orderBy(desc(sql`sum(${t.impressions})`), asc(t.query), asc(t.page))
    .limit(STRIKING_PAIRS + 1);
  const truncated = rows.length > STRIKING_PAIRS;
  const pairs = rows.slice(0, STRIKING_PAIRS).map((r) => ({ ...r, position: round1(r.position) }));
  return { pages: strikingPages(pairs, positions, opts.minImpressions), pairsRead: pairs.length, truncated };
}

/**
 * Query-and-page pairs over a period, most impressions first, for findings that look across pages:
 * one search on several pages, and the searches behind a page. Impressions lead because a page far
 * down the results has few clicks. `truncated` when the pair limit cut the list.
 */
export async function gscQueryPagePairs(scope: ProjectScope, range: DateRange, limit = STRIKING_PAIRS): Promise<{ pairs: { query: string; page: string; clicks: number; impressions: number; position: number }[]; truncated: boolean }> {
  const t = gscQueryPages;
  const rows = await db
    .select({ query: t.query, page: t.page, ...aggCols(t) })
    .from(t)
    .where(and(inScope(t, scope), between(t.date, range.start, range.end)))
    .groupBy(t.query, t.page)
    .having(sql`sum(${t.impressions}) > 0`)
    .orderBy(desc(sql`sum(${t.impressions})`), asc(t.query), asc(t.page))
    .limit(limit + 1);
  return { pairs: rows.slice(0, limit).map((r) => ({ ...r, position: round1(r.position) })), truncated: rows.length > limit };
}

/**
 * Pages whose average position over the period is past `pastPosition`, with at least `minImpressions`,
 * most impressions first. Read on their own because such a page has few clicks, so a list sorted by
 * clicks would drop it on a big site.
 */
export async function gscPagesPastPosition(scope: ProjectScope, range: DateRange, pastPosition: number, minImpressions: number, limit = 5_000) {
  const t = gscPages;
  const position = sql`sum(${t.position} * ${t.impressions}) / nullif(sum(${t.impressions}), 0)`;
  const rows = await db
    .select({ key: sql<string>`${t.page}`, ...aggCols(t) })
    .from(t)
    .where(and(inScope(t, scope), between(t.date, range.start, range.end)))
    .groupBy(t.page)
    .having(sql`${position} > ${pastPosition} and sum(${t.impressions}) >= ${minImpressions}`)
    .orderBy(desc(sql`sum(${t.impressions})`), asc(t.page))
    .limit(limit);
  return rows.map((r) => ({ ...withCtr(r), position: round1(r.position) }));
}

/** Pages a query ranks with (a cannibalization signal when there are several). */
export async function pagesForQuery(scope: ProjectScope, query: string, range: DateRange) {
  const rows = await db
    .select({ page: gscQueryPages.page, ...aggCols(gscQueryPages) })
    .from(gscQueryPages)
    .where(and(inScope(gscQueryPages, scope), eq(gscQueryPages.query, query), between(gscQueryPages.date, range.start, range.end)))
    .groupBy(gscQueryPages.page)
    .orderBy(desc(sql`sum(${gscQueryPages.clicks})`), desc(sql`sum(${gscQueryPages.impressions})`));
  return rows.map((r) => ({ ...withCtr(r), position: round1(r.position) }));
}

export async function queriesForPage(scope: ProjectScope, page: string, range: DateRange) {
  const rows = await db
    .select({ query: gscQueryPages.query, ...aggCols(gscQueryPages) })
    .from(gscQueryPages)
    .where(and(inScope(gscQueryPages, scope), eq(gscQueryPages.page, page), between(gscQueryPages.date, range.start, range.end)))
    .groupBy(gscQueryPages.query)
    .orderBy(desc(sql`sum(${gscQueryPages.clicks})`), desc(sql`sum(${gscQueryPages.impressions})`))
    .limit(2_000);
  return rows.map((r) => ({ ...withCtr(r), position: round1(r.position), ...(isLikelyBotQuery(r.query) ? { likelyBot: true as const } : {}) }));
}

/** Daily series for one query or page. */
export async function dimSeries(scope: ProjectScope, kind: "query" | "page", value: string, range: DateRange) {
  const t = kind === "query" ? gscQueries : gscPages;
  const col = kind === "query" ? gscQueries.query : gscPages.page;
  return db
    .select({ date: sql<string>`${t.date}::text`, clicks: t.clicks, impressions: t.impressions, position: t.position })
    .from(t)
    .where(and(inScope(t, scope), eq(col, value), between(t.date, range.start, range.end)))
    .orderBy(asc(t.date));
}

/** Countries or devices with the compare period, by clicks, then impressions. */
export async function gscBreakdownRows(scope: ProjectScope, kind: "country" | "device", current: DateRange, previous: DateRange | null) {
  const q = (r: DateRange) =>
    db
      .select({ key: gscBreakdown.key, ...aggCols(gscBreakdown) })
      .from(gscBreakdown)
      .where(and(inScope(gscBreakdown, scope), eq(gscBreakdown.kind, kind), between(gscBreakdown.date, r.start, r.end)))
      .groupBy(gscBreakdown.key)
      .orderBy(desc(sql`sum(${gscBreakdown.clicks})`), desc(sql`sum(${gscBreakdown.impressions})`), asc(gscBreakdown.key));
  const [cur, prev] = await Promise.all([q(current), previous ? q(previous) : Promise.resolve([])]);
  const pm = new Map(prev.map((p) => [p.key, p]));
  const total = cur.reduce((n, r) => n + r.clicks, 0);
  return cur.map((r) => {
    const p = pm.get(r.key);
    return {
      ...withCtr(r),
      position: round1(r.position),
      share: total ? r.clicks / total : 0,
      clicksDelta: previous ? r.clicks - (p?.clicks ?? 0) : null,
      clicksChange: previous ? pctChange(r.clicks, p?.clicks) : null,
    };
  });
}

/** Best page per query from the query×page data, for the striking-distance view. */
export async function topPageByQuery(scope: ProjectScope, range: DateRange, queries: string[]): Promise<Map<string, string>> {
  if (!queries.length) return new Map();
  const rows = await db.execute<{ query: string; page: string }>(sql`
    select distinct on (query) query, page from (
      select ${gscQueryPages.query} as query, ${gscQueryPages.page} as page, sum(${gscQueryPages.impressions}) as impr
      from ${gscQueryPages}
      where ${gscQueryPages.workspaceId} = ${scope.workspaceId} and ${gscQueryPages.projectId} = ${scope.projectId}
        and ${gscQueryPages.date} between ${range.start} and ${range.end}
        and ${gscQueryPages.query} in (${sql.join(queries.map((q) => sql`${q}`), sql`, `)})
      group by 1, 2
    ) t
    order by query, impr desc`);
  return new Map([...rows].map((r) => [r.query, r.page]));
}

export async function recentInspections(scope: ProjectScope, limit = 50) {
  return db
    .select()
    .from(gscUrlInspections)
    .where(inScope(gscUrlInspections, scope))
    .orderBy(desc(gscUrlInspections.inspectedAt))
    .limit(limit);
}

// ---------- GA4 ----------

/** The last day an Analytics source's sync asked for ("checked through"), or null before its first sync. */
export async function analyticsCheckedThrough(scope: ProjectScope, source: "ga4" | "posthog" | "plausible" | "umami"): Promise<string | null> {
  const [r] = await db
    .select({ latestDate: googleSyncState.latestDate })
    .from(googleSyncState)
    .where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, source)));
  return r?.latestDate ?? null;
}

export async function ga4DataRange(scope: ProjectScope): Promise<{ first: string; last: string } | null> {
  const [r] = await db
    .select({ first: sql<string | null>`min(${ga4LandingDaily.date})::text`, last: sql<string | null>`max(${ga4LandingDaily.date})::text` })
    .from(ga4LandingDaily)
    .where(inScope(ga4LandingDaily, scope));
  return r?.first && r.last ? { first: r.first, last: r.last } : null;
}

const ga4Agg = {
  sessions: sql<number>`coalesce(sum(${ga4LandingDaily.sessions}), 0)::int`,
  engagedSessions: sql<number>`coalesce(sum(${ga4LandingDaily.engagedSessions}), 0)::int`,
  keyEvents: sql<number>`coalesce(sum(${ga4LandingDaily.keyEvents}), 0)::float`,
  totalRevenue: sql<number>`coalesce(sum(${ga4LandingDaily.totalRevenue}), 0)::float`,
};

export async function ga4Series(scope: ProjectScope, range: DateRange) {
  return db
    .select({ date: sql<string>`${ga4LandingDaily.date}::text`, ...ga4Agg })
    .from(ga4LandingDaily)
    .where(and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, range.start, range.end)))
    .groupBy(ga4LandingDaily.date)
    .orderBy(asc(ga4LandingDaily.date));
}

export async function ga4Totals(scope: ProjectScope, range: DateRange) {
  const [r] = await db
    .select(ga4Agg)
    .from(ga4LandingDaily)
    .where(and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, range.start, range.end)));
  return r ?? { sessions: 0, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 };
}

/**
 * Organic landing pages joined with GSC page metrics for the same period. The join key drops
 * scheme, "www.", query and trailing slash on both sides (see pageKey).
 */
export async function landingPagesJoined(scope: ProjectScope, current: DateRange, previous: DateRange | null) {
  const ga = (r: DateRange) =>
    db
      .select({ hostName: ga4LandingDaily.hostName, landingPage: ga4LandingDaily.landingPage, ...ga4Agg })
      .from(ga4LandingDaily)
      .where(and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, r.start, r.end)))
      .groupBy(ga4LandingDaily.hostName, ga4LandingDaily.landingPage);
  const [cur, prev, gscRows] = await Promise.all([
    ga(current),
    previous ? ga(previous) : Promise.resolve([]),
    db
      .select({ page: gscPages.page, ...aggCols(gscPages) })
      .from(gscPages)
      .where(and(inScope(gscPages, scope), between(gscPages.date, current.start, current.end)))
      .groupBy(gscPages.page),
  ]);

  const gsc = new Map<string, { page: string; clicks: number; impressions: number; posImpr: number }>();
  for (const g of gscRows) {
    const k = pageKey(g.page);
    const a = gsc.get(k) ?? { page: g.page, clicks: 0, impressions: 0, posImpr: 0 };
    a.clicks += g.clicks;
    a.impressions += g.impressions;
    a.posImpr += g.position * g.impressions;
    gsc.set(k, a);
  }
  const prevSessions = new Map<string, number>();
  for (const p of prev) {
    const k = pageKey(p.hostName, p.landingPage);
    prevSessions.set(k, (prevSessions.get(k) ?? 0) + p.sessions);
  }

  const rows = new Map<string, { key: string; host: string; landingPage: string; sessions: number; engagedSessions: number; keyEvents: number; totalRevenue: number }>();
  for (const r of cur) {
    const k = pageKey(r.hostName, r.landingPage);
    const a = rows.get(k) ?? { key: k, host: r.hostName, landingPage: r.landingPage, sessions: 0, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 };
    a.sessions += r.sessions;
    a.engagedSessions += r.engagedSessions;
    a.keyEvents += r.keyEvents;
    a.totalRevenue += r.totalRevenue;
    rows.set(k, a);
  }

  return [...rows.values()]
    .map((r) => {
      const g = gsc.get(r.key);
      const ps = prevSessions.get(r.key);
      return {
        landingPage: r.landingPage,
        url: `https://${r.host}${r.landingPage === "(not set)" ? "" : r.landingPage}`,
        gscPage: g?.page ?? null,
        sessions: r.sessions,
        sessionsDelta: previous ? r.sessions - (ps ?? 0) : null,
        engagedSessions: r.engagedSessions,
        engagementRate: r.sessions ? r.engagedSessions / r.sessions : 0,
        keyEvents: Math.round(r.keyEvents * 10) / 10,
        totalRevenue: r.totalRevenue,
        gscClicks: g?.clicks ?? null,
        gscImpressions: g?.impressions ?? null,
        gscCtr: g && g.impressions ? g.clicks / g.impressions : null,
        gscPosition: g && g.impressions ? round1(g.posImpr / g.impressions) : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}
