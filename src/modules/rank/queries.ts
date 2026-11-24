// Read-side queries for the rank pages. No API calls here; everything comes from stored results.
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema/core";
import { keywordsListItems, keywordsLists } from "@/db/schema/keywords";
import { rankKeywords, rankResults, rankRuns, rankSettings, type RankDomainHit } from "@/db/schema/rank";
import { isStalePosting } from "@/lib/check-failure";
import { locationName, trackedLocation, trackedPlaceName } from "@/lib/dataforseo/locations";
import { placeNames } from "@/lib/dataforseo/places";
import type { ProjectScope } from "@/lib/workspace";
import { depthHint, depthHintSince, type DepthHint, type DepthHintInput } from "./depth-hint";
import { matchesDomain } from "./parse";
import { RECENT_DAYS } from "./recheck";
import { searchConsoleAverages } from "./search-console";
import { getSettings, type RankSettings } from "./tracker";

export type RankKeyword = typeof rankKeywords.$inferSelect;
export type RankRun = typeof rankRuns.$inferSelect;

export const RANGES = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12m" },
] as const;

export function parseRange(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return RANGES.some((r) => r.days === n) ? n : 7;
}

export interface TrackerState {
  settings: RankSettings;
  keywords: RankKeyword[];
  activeRun: RankRun | null;
  lastRun: RankRun | null;
  /** The newest run of any status, which says whether the latest check failed. Null when none has run. */
  newestRun: RankRun | null;
  /** Dates with results from `place`, newest first. */
  dates: string[];
  /** The place being looked at: where the project searches from now, or an earlier one by `?place=`. */
  place: RankPlace;
  /** Every place this project has results from, plus where it searches from now. Current first, then newest. */
  places: RankPlace[];
}

/** Rows for one place. A null location is a row from before a place was stored: read it as the project's country. */
export interface PlaceFilter {
  code: number;
  includesUnstamped: boolean;
}

export interface RankPlace extends PlaceFilter {
  name: string;
  current: boolean;
  first: string | null;
  last: string | null;
  checks: number;
}

/** Filter for where a project searches from now. */
export function currentPlaceFilter(project: { locationCode: number; cityCode: number | null }): PlaceFilter {
  const code = trackedLocation(project);
  return { code, includesUnstamped: code === project.locationCode };
}

const atPlace = (place: PlaceFilter) => (place.includesUnstamped ? or(eq(rankResults.locationCode, place.code), isNull(rankResults.locationCode)) : eq(rankResults.locationCode, place.code));

/** Filters for the scope's rows of each rank table. */
const kwIn = (s: ProjectScope) => and(eq(rankKeywords.workspaceId, s.workspaceId), eq(rankKeywords.projectId, s.projectId));
const runsIn = (s: ProjectScope) => and(eq(rankRuns.workspaceId, s.workspaceId), eq(rankRuns.projectId, s.projectId));
const resultsIn = (s: ProjectScope) => and(eq(rankResults.workspaceId, s.workspaceId), eq(rankResults.projectId, s.projectId));
/** Joins a result to its keyword within the same workspace. */
const keywordOfResult = and(eq(rankKeywords.id, rankResults.keywordId), eq(rankKeywords.workspaceId, rankResults.workspaceId));
const runOfResult = and(eq(rankRuns.id, rankResults.runId), eq(rankRuns.workspaceId, rankResults.workspaceId));
/** Whether the result's check asked Google for AI Overview sources. Without them, "not cited" means nothing. */
const aiOverviewLoaded = sql<boolean>`coalesce(${rankRuns.aiOverview}, false)`;

/**
 * The places a project's results come from, and which one to show: `requested` when it has results
 * from there, else where it searches from now. Positions from two places are never compared, so
 * every rank page reads one place at a time and older ones stay reachable.
 */
export async function loadPlaces(scope: ProjectScope, requested?: string | string[]): Promise<{ place: RankPlace; places: RankPlace[] }> {
  const [project] = await db
    .select({ locationCode: projects.locationCode, cityCode: projects.cityCode, cityName: projects.cityName })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  const here = project ?? { locationCode: 0, cityCode: null, cityName: null };
  const code = sql<number>`coalesce(${rankResults.locationCode}, ${here.locationCode})`;
  const rows = await db
    .select({ code, first: sql<string>`min(${rankResults.date})`, last: sql<string>`max(${rankResults.date})`, checks: sql<number>`count(distinct ${rankResults.date})::int` })
    .from(rankResults)
    .where(resultsIn(scope))
    // By position: the code's parameter would count as a different expression here.
    .groupBy(sql`1`);
  const currentCode = trackedLocation(here);
  const names = await placeNames(rows.map((r) => r.code).filter((c) => c !== currentCode && c >= 3000));
  const toPlace = (r: { code: number; first: string | null; last: string | null; checks: number }): RankPlace => ({
    ...r,
    name: r.code === currentCode ? trackedPlaceName(here) : (names.get(r.code) ?? locationName(r.code)),
    current: r.code === currentCode,
    includesUnstamped: r.code === here.locationCode,
  });
  const places = [...(rows.some((r) => r.code === currentCode) ? [] : [{ code: currentCode, first: null, last: null, checks: 0 }]), ...rows]
    .map(toPlace)
    .sort((a, b) => Number(b.current) - Number(a.current) || (b.last ?? "").localeCompare(a.last ?? ""));
  const wanted = Number(Array.isArray(requested) ? requested[0] : requested);
  return { place: places.find((p) => p.code === wanted) ?? places[0], places };
}

/** A run stuck posting isn't in flight: the next check closes it, so it mustn't hold the button back. */
const isInFlight = (r: Pick<RankRun, "status" | "createdAt">) => (r.status === "posting" || r.status === "pending") && !isStalePosting(r);

/** Whether a check is under way for this project, read the way `loadTracker` reads it. */
export async function hasActiveRun(scope: ProjectScope): Promise<boolean> {
  const runs = await db
    .select({ status: rankRuns.status, createdAt: rankRuns.createdAt })
    .from(rankRuns)
    .where(and(runsIn(scope), inArray(rankRuns.status, ["posting", "pending"])));
  return runs.some(isInFlight);
}

export async function loadTracker(scope: ProjectScope, requestedPlace?: string | string[]): Promise<TrackerState> {
  const { place, places } = await loadPlaces(scope, requestedPlace);
  const [settings, keywords, runs, [lastRun], dates] = await Promise.all([
    getSettings(scope),
    db.select().from(rankKeywords).where(kwIn(scope)).orderBy(asc(rankKeywords.keyword)),
    db.select().from(rankRuns).where(runsIn(scope)).orderBy(desc(rankRuns.id)).limit(5),
    // Asked apart, because a run of failed checks can push the last good one out of those five.
    db.select().from(rankRuns).where(and(runsIn(scope), eq(rankRuns.status, "done"))).orderBy(desc(rankRuns.id)).limit(1),
    db
      .selectDistinct({ date: rankResults.date })
      .from(rankResults)
      .where(and(resultsIn(scope), atPlace(place)))
      .orderBy(desc(rankResults.date))
      .limit(400),
  ]);
  return {
    settings,
    keywords,
    activeRun: runs.find(isInFlight) ?? null,
    lastRun: lastRun ?? null,
    newestRun: runs[0] ?? null,
    dates: dates.map((d) => d.date),
    place,
    places,
  };
}

/** Each project's newest run, for All projects, with one query however many projects there are. Only projects tracking a keyword with the tracker on: nothing else will check again unless asked. */
export async function newestRuns(workspaceId: number, projectIds: number[]) {
  if (!projectIds.length) return [];
  const inProjects = <T extends typeof rankRuns | typeof rankKeywords | typeof rankSettings>(t: T) => and(eq(t.workspaceId, workspaceId), inArray(t.projectId, projectIds));
  const [runs, tracking, turnedOff] = await Promise.all([
    db
      .selectDistinctOn([rankRuns.projectId], { projectId: rankRuns.projectId, status: rankRuns.status, error: rankRuns.error, createdAt: rankRuns.createdAt, finishedAt: rankRuns.finishedAt })
      .from(rankRuns)
      .where(inProjects(rankRuns))
      .orderBy(rankRuns.projectId, desc(rankRuns.id)),
    db.selectDistinct({ projectId: rankKeywords.projectId }).from(rankKeywords).where(and(inProjects(rankKeywords), eq(rankKeywords.active, true))),
    // No settings row means the default, which is on.
    db.select({ projectId: rankSettings.projectId }).from(rankSettings).where(and(inProjects(rankSettings), eq(rankSettings.enabled, false))),
  ]);
  const live = new Set(tracking.map((k) => k.projectId));
  const off = new Set(turnedOff.map((s) => s.projectId));
  return runs.filter((r) => live.has(r.projectId) && !off.has(r.projectId));
}

/** Days before `date` ("2026-10-29") as a date string. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The window ending at the newest check and reaching back `days`. Null when nothing was checked yet. */
export function resolveWindow(dates: string[], days: number): { start: string; end: string } | null {
  if (!dates.length) return null;
  const end = dates[0];
  const floor = shiftDate(end, -days);
  const inWindow = dates.filter((d) => d >= floor);
  return { start: inWindow[inWindow.length - 1], end };
}

export interface ResultRow {
  keywordId: number;
  date: string;
  position: number | null;
  url: string | null;
  serpFeatures: string[];
  ownedFeatures: string[];
  aiOverview: boolean;
  aiOverviewCited: boolean;
  ownUrls: RankDomainHit[];
  /** No look could confirm the keyword this day: the row repeats its last known result. */
  notChecked: boolean;
  /** How deep this check looked; a null position only means "not in the top `depth`". */
  depth: number;
  /** The check loaded AI Overview sources, so its cited or not cited can be believed. */
  aiOverviewLoaded: boolean;
}

export async function loadResults(scope: ProjectScope, start: string, end: string, place: PlaceFilter): Promise<ResultRow[]> {
  return db
    .select({
      keywordId: rankResults.keywordId,
      date: rankResults.date,
      position: rankResults.position,
      url: rankResults.url,
      serpFeatures: rankResults.serpFeatures,
      ownedFeatures: rankResults.ownedFeatures,
      aiOverview: rankResults.aiOverview,
      aiOverviewCited: rankResults.aiOverviewCited,
      ownUrls: rankResults.ownUrls,
      notChecked: rankResults.notChecked,
      depth: rankResults.depth,
      aiOverviewLoaded,
    })
    .from(rankResults)
    .innerJoin(rankKeywords, keywordOfResult)
    .leftJoin(rankRuns, runOfResult)
    .where(
      and(
        resultsIn(scope),
        atPlace(place),
        eq(rankKeywords.active, true),
        gte(rankResults.date, start),
        lte(rankResults.date, end),
      ),
    )
    .orderBy(asc(rankResults.date));
}

/** `loadResults` from far enough back to carry a deep position into the window. Pass `start` on to `carryDeepPositions`, which leaves the earlier rows out. */
export function loadResultsToCarry(scope: ProjectScope, start: string, end: string, place: PlaceFilter): Promise<ResultRow[]> {
  return loadResults(scope, shiftDate(start, -RECENT_DAYS), end, place);
}

/** The deepest any check read for each active keyword from `place` between `start` and `end`, keyed by keyword id. Rows that only repeat an earlier result don't count. */
export async function deepestLooks(scope: ProjectScope, start: string, end: string, place: PlaceFilter): Promise<Map<number, number>> {
  const rows = await db
    .select({ keywordId: rankResults.keywordId, depth: sql<number>`max(${rankResults.depth})::int` })
    .from(rankResults)
    .innerJoin(rankKeywords, keywordOfResult)
    .where(and(resultsIn(scope), atPlace(place), eq(rankKeywords.active, true), eq(rankResults.notChecked, false), gte(rankResults.date, start), lte(rankResults.date, end)))
    .groupBy(rankResults.keywordId);
  return new Map(rows.map((r) => [r.keywordId, Number(r.depth)]));
}

/**
 * The depth hint for the latest check (`depthHint`), from Search Console's last `DEPTH_HINT_DAYS`
 * days. `rows` are the unfiltered overview's, `end` the latest check's date. Only for where the
 * project searches from now, since that's what the depth setting changes.
 */
export async function loadDepthHint(scope: ProjectScope, state: Pick<TrackerState, "settings" | "place">, rows: DepthHintInput["rows"], end: string): Promise<DepthHint | null> {
  const missing = rows.filter((r) => r.checked && r.position == null);
  if (!state.place.current || !missing.length) return null;
  const since = depthHintSince(end);
  const [searchConsole, deepestLook] = await Promise.all([
    searchConsoleAverages(scope, missing.map((r) => r.keyword), end, since),
    deepestLooks(scope, since, end, state.place),
  ]);
  return depthHint({ rows, deepestLook, searchConsole, settings: state.settings });
}

export interface DomainRow {
  keywordId: number;
  date: string;
  position: number | null;
  /** No look could confirm the keyword this day: the row repeats its last results page, rivals included. */
  notChecked: boolean;
  /** How deep the check looked, so a deeper sighting can be carried through shallower checks. */
  depth: number;
  domains: Record<string, RankDomainHit>;
}

export async function loadDomainResults(scope: ProjectScope, start: string, end: string, place: PlaceFilter): Promise<DomainRow[]> {
  return db
    .select({
      keywordId: rankResults.keywordId,
      date: rankResults.date,
      position: rankResults.position,
      notChecked: rankResults.notChecked,
      depth: rankResults.depth,
      domains: rankResults.domains,
    })
    .from(rankResults)
    .innerJoin(rankKeywords, keywordOfResult)
    .where(
      and(
        resultsIn(scope),
        atPlace(place),
        eq(rankKeywords.active, true),
        gte(rankResults.date, start),
        lte(rankResults.date, end),
      ),
    )
    .orderBy(asc(rankResults.date));
}

/** `loadDomainResults` from far enough back to carry a deep position into the window. Pass `start` on to `buildCompetitorView`, which leaves the earlier rows out. */
export function loadDomainResultsToCarry(scope: ProjectScope, start: string, end: string, place: PlaceFilter): Promise<DomainRow[]> {
  return loadDomainResults(scope, shiftDate(start, -RECENT_DAYS), end, place);
}

/** A domain's best position in a stored SERP, counting its subdomains. */
export function domainPosition(domains: Record<string, RankDomainHit>, domain: string): RankDomainHit | null {
  let best: RankDomainHit | null = null;
  for (const [host, hit] of Object.entries(domains)) {
    if (matchesDomain(host, domain) && (!best || hit.p < best.p)) best = hit;
  }
  return best;
}

/** First and last row per keyword inside the window. */
export function firstAndLast<T extends { keywordId: number; date: string }>(rows: T[]) {
  const map = new Map<number, { first: T; last: T }>();
  for (const r of rows) {
    const e = map.get(r.keywordId);
    if (!e) map.set(r.keywordId, { first: r, last: r });
    else {
      if (r.date < e.first.date) e.first = r;
      if (r.date >= e.last.date) e.last = r;
    }
  }
  return map;
}

export async function getKeyword(scope: ProjectScope, id: number): Promise<RankKeyword | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select()
    .from(rankKeywords)
    .where(and(kwIn(scope), eq(rankKeywords.id, id)));
  return row ?? null;
}

/** History of a keyword from `getKeyword`, which checked it belongs to the scope. */
export async function keywordHistory(keyword: Pick<RankKeyword, "id" | "workspaceId">, since: string, place?: PlaceFilter) {
  return db
    .select({ ...getTableColumns(rankResults), aiOverviewLoaded })
    .from(rankResults)
    .leftJoin(rankRuns, runOfResult)
    .where(and(eq(rankResults.workspaceId, keyword.workspaceId), eq(rankResults.keywordId, keyword.id), gte(rankResults.date, since), place ? atPlace(place) : undefined))
    .orderBy(asc(rankResults.date));
}

export async function listRuns(scope: ProjectScope, limit = 30) {
  return db.select().from(rankRuns).where(runsIn(scope)).orderBy(desc(rankRuns.id)).limit(limit);
}

/** Visibility inputs per date for the dashboard card, over the last `days`. */
export async function recentDailyPositions(scope: ProjectScope, days: number, place: PlaceFilter) {
  const since = shiftDate(new Date().toISOString().slice(0, 10), -days);
  return db
    .select({
      keywordId: rankResults.keywordId,
      date: rankResults.date,
      position: rankResults.position,
      depth: rankResults.depth,
      notChecked: rankResults.notChecked,
      volume: rankKeywords.searchVolume,
    })
    .from(rankResults)
    .innerJoin(rankKeywords, keywordOfResult)
    .where(and(resultsIn(scope), atPlace(place), eq(rankKeywords.active, true), gte(rankResults.date, since)))
    .orderBy(asc(rankResults.date));
}

export interface SavedList {
  id: number;
  name: string;
  items: number;
}

/** The project's saved keyword lists (owned by the keywords module; read only here). */
export async function listSavedLists(scope: ProjectScope): Promise<SavedList[]> {
  return db
    .select({ id: keywordsLists.id, name: keywordsLists.name, items: sql<number>`count(${keywordsListItems.id})::int` })
    .from(keywordsLists)
    .leftJoin(keywordsListItems, and(eq(keywordsListItems.listId, keywordsLists.id), eq(keywordsListItems.workspaceId, keywordsLists.workspaceId)))
    .where(and(eq(keywordsLists.workspaceId, scope.workspaceId), eq(keywordsLists.projectId, scope.projectId)))
    .groupBy(keywordsLists.id)
    .orderBy(asc(keywordsLists.name));
}
