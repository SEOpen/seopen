import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { fixes, projects, rankKeywords, rankResults } from "@/db/schema";
import { peekCache, taskResults } from "@/lib/dataforseo/client";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { SERP_TYPE_LABEL, type SerpType } from "@/modules/content-briefs/types";
import { searchPages, type PairMetrics } from "@/modules/google/insights";
import { pageKey } from "@/modules/google/matching";
import type { DateRange } from "@/modules/google/windowing";
import { serpSpec } from "@/modules/keywords/requests";
import { serpRows } from "@/modules/keywords/transform";
import type { SerpResult } from "@/modules/keywords/types";
import { AUDIT_TITLE, crawlTitles } from "./own-page";
import { ownPageType, pageTypes, settledType, type ResultInput } from "./page-type";

/**
 * gsc-wrong-page-type: Search Console ties a page to a search, and a saved results page for that
 * search shows Google has settled on a different kind of page. Saved data only: the daily rank
 * check's top 20, or a `serp` lookup this workspace paid for that's still fresh. It never looks
 * anything up, so the sync spends no research credits.
 */

/** Searches checked against saved results each sync, most impressions first, so a big site stays cheap to read. */
const LOOKED_AT = 100;
/** URLs of the dominant type an evidence record lists. */
const TOP_URLS = 3;
/** Other searches a record lists. */
const OTHERS_LISTED = 4;

export const SERP_FROM = { rank: "the daily rank check", lookup: "a saved results lookup" } as const;

interface Saved {
  rows: ResultInput[];
  from: string;
  at: Date;
}

/** The newest saved top 10 for each search, from either source. Never fetches anything. */
async function savedResults(scope: ProjectScope, queries: string[], since: string): Promise<Map<string, Saved>> {
  const out = new Map<string, Saved>();
  if (!queries.length) return out;
  const [project] = await db.select({ domain: projects.domain, locationCode: projects.locationCode, languageCode: projects.languageCode }).from(projects).where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!project) return out;
  const keyword = sql<string>`lower(${rankKeywords.keyword})`;
  const ranked = await db
    .selectDistinctOn([keyword], { keyword, top: rankResults.top, checkedAt: rankResults.checkedAt })
    .from(rankResults)
    .innerJoin(rankKeywords, eq(rankKeywords.id, rankResults.keywordId))
    .where(and(eq(rankResults.workspaceId, scope.workspaceId), eq(rankResults.projectId, scope.projectId), gte(rankResults.date, since), inArray(keyword, queries)))
    .orderBy(keyword, desc(rankResults.checkedAt), desc(rankResults.date));
  for (const r of ranked) {
    // The rank check keeps a hidden result's origin without saying it was hidden.
    if (r.top.length) out.set(r.keyword, { rows: r.top.map((i) => ({ type: i.type, url: i.url, domain: i.domain, title: i.title, originOnly: "unknown", breadcrumb: null })), from: SERP_FROM.rank, at: r.checkedAt });
  }
  const market = { locationCode: project.locationCode, languageCode: project.languageCode };
  // peekCache directly, not keywords/dfs's `peek`: dfs.ts is server-only and this runs in the worker.
  const looked = await Promise.all(
    queries.map(async (q) => {
      const spec = serpSpec(q, market);
      return [q, await peekCache<SerpResult>(scope.workspaceId, "POST", spec.path, [spec.task])] as const;
    }),
  );
  for (const [q, hit] of looked) {
    if (!hit || (out.get(q)?.at.getTime() ?? 0) > hit.createdAt.getTime()) continue;
    let result: SerpResult | null = null;
    try {
      result = taskResults(hit.response)[0] ?? null;
    } catch {
      continue;
    }
    const rows = serpRows(result, project.domain);
    if (rows.length) out.set(q, { rows, from: SERP_FROM.lookup, at: hit.createdAt });
  }
  return out;
}

export interface WrongTypeSearch {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  dominant: SerpType;
  agree: number;
  of: number;
  topUrls: string[];
  serpFrom: string;
  serpCheckedAt: string;
}

export interface WrongTypeRecord {
  page: string;
  /** The page's impressions from these searches. */
  impressions: number;
  pageType: SerpType;
  pageTypeWhy: string;
  pageTitle: string | null;
  /** Most impressions first. */
  searches: WrongTypeSearch[];
}

/** How long a record keeps the results it was raised on once no newer saved results exist for its search. */
export const EARLIER_RESULTS_DAYS = 90;

/** The main search and its results from each page's existing record, when they're recent enough to stand. */
async function earlierResults(scope: ProjectScope, asOf: string): Promise<Map<string, { query: string; search: Omit<WrongTypeSearch, "query" | "impressions" | "clicks" | "position"> }>> {
  const rows = await db
    .select({ url: fixes.url, evidence: fixes.evidence })
    .from(fixes)
    .where(and(inScope(fixes, scope), eq(fixes.source, "search_console"), eq(fixes.code, "gsc-wrong-page-type"), inArray(fixes.status, ["open", "applied", "live", "measured"])));
  const oldest = new Date(`${asOf}T00:00:00Z`).getTime() - EARLIER_RESULTS_DAYS * 86_400_000;
  const out = new Map<string, { query: string; search: Omit<WrongTypeSearch, "query" | "impressions" | "clicks" | "position"> }>();
  for (const r of rows) {
    const e = (r.evidence ?? {}) as Record<string, unknown>;
    const at = typeof e.serp_checked_at === "string" ? Date.parse(e.serp_checked_at) : NaN;
    if (typeof e.query !== "string" || typeof e.dominant_type !== "string" || !(e.dominant_type in SERP_TYPE_LABEL) || !(at >= oldest)) continue;
    out.set(pageKey(r.url), {
      query: e.query,
      search: {
        dominant: e.dominant_type as SerpType,
        agree: typeof e.agree === "number" ? e.agree : 0,
        of: typeof e.of === "number" ? e.of : 10,
        topUrls: Array.isArray(e.top_urls) ? e.top_urls.filter((u): u is string => typeof u === "string") : [],
        serpFrom: typeof e.serp_from === "string" ? e.serp_from : SERP_FROM.lookup,
        serpCheckedAt: e.serp_checked_at as string,
      },
    });
  }
  return out;
}

/** One record per page, carrying every search it's the wrong kind of page for. Most impressions first. */
export async function wrongPageTypes(scope: ProjectScope, pairs: readonly PairMetrics[], siteImpressions: number, period: DateRange): Promise<WrongTypeRecord[]> {
  const candidates = searchPages(pairs, siteImpressions, pageKey).slice(0, LOOKED_AT);
  const saved = await savedResults(scope, [...new Set(candidates.map((c) => c.query.toLowerCase()))], period.start);
  const earlier = await earlierResults(scope, period.end);
  const settled = candidates.flatMap((c) => {
    const s = saved.get(c.query.toLowerCase());
    if (!s) {
      // A paid lookup is saved for a day: the record keeps the results it was raised on, so it doesn't close just because they expired.
      const kept = earlier.get(pageKey(c.page));
      return kept && kept.query === c.query ? [{ ...c, ...kept.search }] : [];
    }
    const { mix } = pageTypes(s.rows);
    const dominant = settledType(mix);
    if (!dominant) return [];
    const topUrls = (mix.byType.find((g) => g.type === dominant)?.urls ?? []).slice(0, TOP_URLS);
    return [{ ...c, dominant, agree: mix.agree, of: Math.min(mix.total, 10), topUrls, serpFrom: s.from, serpCheckedAt: s.at.toISOString() }];
  });
  if (!settled.length) return [];
  const titles = await crawlTitles(scope, settled.map((c) => c.page));
  const byPage = new Map<string, WrongTypeRecord>();
  for (const { page, ...search } of settled) {
    const k = pageKey(page);
    const title = titles.get(k) ?? null;
    const own = ownPageType(page, title ? { text: title, from: AUDIT_TITLE } : null);
    // A call about the project's own page that doesn't hold up raises nothing.
    if (!own.reliable || !own.type || own.type === search.dominant) continue;
    const r = byPage.get(k) ?? { page, impressions: 0, pageType: own.type, pageTypeWhy: own.why, pageTitle: title, searches: [] };
    r.searches.push(search);
    r.impressions += search.impressions;
    byPage.set(k, r);
  }
  return [...byPage.values()].sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
}

/** The record's evidence: its main search in full, and the others by name. */
export function wrongTypeEvidence(r: WrongTypeRecord, period: DateRange): Record<string, unknown> {
  const [main, ...rest] = r.searches;
  return {
    query: main.query,
    impressions: main.impressions,
    clicks: main.clicks,
    position: main.position,
    period,
    dominant_type: main.dominant,
    agree: main.agree,
    of: main.of,
    top_urls: main.topUrls,
    serp_from: main.serpFrom,
    serp_checked_at: main.serpCheckedAt,
    page_type: r.pageType,
    page_type_why: r.pageTypeWhy,
    page_title: r.pageTitle,
    searches_mismatched: r.searches.length,
    other_searches: rest.slice(0, OTHERS_LISTED).map((s) => ({ query: s.query, impressions: s.impressions, position: s.position, dominant_type: s.dominant })),
  };
}
