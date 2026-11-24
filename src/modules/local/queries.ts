// Reads for the local pages and the dashboard card. Database only, no API calls.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { localBusinesses, localChecks, localKeywords, localPoints, type LocalListing } from "@/db/schema/local";
import type { ProjectScope } from "@/lib/workspace";
import { EMPTY_STATS, type KeywordStats, type PointStatus } from "./metrics";
import type { LocalBusiness, LocalCheck } from "./tracker";

export type LocalKeyword = typeof localKeywords.$inferSelect;

export async function listBusinesses(scope: ProjectScope): Promise<LocalBusiness[]> {
  return db
    .select()
    .from(localBusinesses)
    .where(and(eq(localBusinesses.workspaceId, scope.workspaceId), eq(localBusinesses.projectId, scope.projectId)))
    .orderBy(asc(localBusinesses.createdAt), asc(localBusinesses.id));
}

export async function listKeywords(scope: ProjectScope, businessIds: number[]): Promise<LocalKeyword[]> {
  if (!businessIds.length) return [];
  return db
    .select()
    .from(localKeywords)
    .where(and(eq(localKeywords.workspaceId, scope.workspaceId), inArray(localKeywords.businessId, businessIds)))
    .orderBy(asc(localKeywords.keyword));
}

/** Checks of these businesses, newest first. */
export async function listChecks(scope: ProjectScope, businessIds: number[], limit = 50): Promise<LocalCheck[]> {
  if (!businessIds.length) return [];
  return db
    .select()
    .from(localChecks)
    .where(and(eq(localChecks.workspaceId, scope.workspaceId), eq(localChecks.projectId, scope.projectId), inArray(localChecks.businessId, businessIds)))
    .orderBy(desc(localChecks.createdAt), desc(localChecks.id))
    .limit(limit);
}

/** One check of this business, or null for an id that isn't one (another business's, project's or workspace's). */
export async function getBusinessCheck(scope: ProjectScope, businessId: number, checkId: number): Promise<LocalCheck | null> {
  if (!Number.isSafeInteger(checkId) || checkId < 1 || checkId > 2_147_483_647) return null;
  const [c] = await db
    .select()
    .from(localChecks)
    .where(and(eq(localChecks.id, checkId), eq(localChecks.workspaceId, scope.workspaceId), eq(localChecks.projectId, scope.projectId), eq(localChecks.businessId, businessId)));
  return c ?? null;
}

/** Each business's newest check, for All projects, with one query however many projects there are. Only businesses with a keyword to search. */
export async function newestChecks(workspaceId: number, projectIds: number[]) {
  if (!projectIds.length) return [];
  const checks = await db
    .selectDistinctOn([localChecks.businessId], { projectId: localChecks.projectId, businessId: localChecks.businessId, status: localChecks.status, error: localChecks.error, createdAt: localChecks.createdAt, finishedAt: localChecks.finishedAt })
    .from(localChecks)
    .where(and(eq(localChecks.workspaceId, workspaceId), inArray(localChecks.projectId, projectIds)))
    .orderBy(localChecks.businessId, desc(localChecks.createdAt), desc(localChecks.id));
  if (!checks.length) return [];
  const searching = await db
    .selectDistinct({ businessId: localKeywords.businessId })
    .from(localKeywords)
    // A business whose checks were turned off won't check again unless asked, so it has nothing to clear a failure with.
    .innerJoin(localBusinesses, and(eq(localBusinesses.id, localKeywords.businessId), eq(localBusinesses.workspaceId, localKeywords.workspaceId), eq(localBusinesses.scheduled, true)))
    .where(and(eq(localKeywords.workspaceId, workspaceId), inArray(localKeywords.businessId, checks.map((c) => c.businessId))));
  const live = new Set(searching.map((k) => k.businessId));
  return checks.filter((c) => live.has(c.businessId));
}

/** Per check and keyword counts, summed in SQL so the listings aren't loaded. Key: `${checkId}:${keywordId}`. */
export async function checkStats(scope: ProjectScope, checkIds: number[]): Promise<Map<string, KeywordStats>> {
  const out = new Map<string, KeywordStats>();
  if (!checkIds.length) return out;
  const rows = await db
    .select({
      checkId: localPoints.checkId,
      keywordId: localPoints.keywordId,
      total: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${localPoints.status} = 'done')::int`,
      failed: sql<number>`count(*) filter (where ${localPoints.status} = 'failed')::int`,
      found: sql<number>`count(${localPoints.rank}) filter (where ${localPoints.status} = 'done')::int`,
      top3: sql<number>`count(*) filter (where ${localPoints.status} = 'done' and ${localPoints.rank} <= 3)::int`,
      rankSum: sql<number>`coalesce(sum(${localPoints.rank}) filter (where ${localPoints.status} = 'done'), 0)::int`,
    })
    .from(localPoints)
    .where(and(eq(localPoints.workspaceId, scope.workspaceId), inArray(localPoints.checkId, checkIds)))
    .groupBy(localPoints.checkId, localPoints.keywordId);
  for (const r of rows) out.set(`${r.checkId}:${r.keywordId}`, { ...EMPTY_STATS, ...r });
  return out;
}

export interface PointRow {
  row: number;
  col: number;
  lat: number;
  lng: number;
  status: PointStatus;
  rank: number | null;
  items: LocalListing[];
  error: string | null;
}

/** Every point of one keyword in one check, with the listings Maps returned there. */
export async function loadPoints(scope: ProjectScope, checkId: number, keywordId: number): Promise<PointRow[]> {
  return db
    .select({
      row: localPoints.row,
      col: localPoints.col,
      lat: localPoints.lat,
      lng: localPoints.lng,
      status: localPoints.status,
      rank: localPoints.rank,
      items: localPoints.items,
      error: localPoints.error,
    })
    .from(localPoints)
    .where(and(eq(localPoints.workspaceId, scope.workspaceId), eq(localPoints.checkId, checkId), eq(localPoints.keywordId, keywordId)))
    .orderBy(asc(localPoints.row), asc(localPoints.col));
}

/** Checks with at least one answered point, newest first: the ones worth showing or comparing. */
export function withResults(checks: LocalCheck[]): LocalCheck[] {
  return checks.filter((c) => c.status === "done" || (c.status === "pending" && c.tasksDone > 0));
}

/** The latest check with results and the one before it, per business. */
export function latestPair(checks: LocalCheck[], businessId: number): { latest: LocalCheck | null; previous: LocalCheck | null } {
  const mine = withResults(checks.filter((c) => c.businessId === businessId));
  return { latest: mine[0] ?? null, previous: mine[1] ?? null };
}

/** The previous check with results before `check` that searched this keyword. */
export function previousFor(checks: LocalCheck[], check: LocalCheck, keywordId: number, stats: Map<string, KeywordStats>): LocalCheck | null {
  const older = withResults(checks.filter((c) => c.businessId === check.businessId && c.createdAt < check.createdAt));
  return older.find((c) => (stats.get(`${c.id}:${keywordId}`)?.answered ?? 0) > 0) ?? null;
}
