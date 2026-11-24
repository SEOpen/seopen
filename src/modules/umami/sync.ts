import { and, between, eq } from "drizzle-orm";
import { db } from "@/db";
import { ga4LandingDaily, googleSyncState, projects } from "@/db/schema";
import { plainNextStep } from "@/lib/dataforseo/failure-copy";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { addDays, chunkRange, historyStart, planSync, todayIn, type DateRange } from "@/modules/google/windowing";
import { umamiApis } from "./api";
import { UmamiAccessError, UmamiNotConnectedError, UmamiQuotaError, type UmamiApis, type UmamiLandingRow } from "./types";

/**
 * Umami fills the same Analytics table as GA4, PostHog and Plausible (`ga4_landing_daily`) and reports
 * progress in the same state table under source "umami", so the Analytics page, its dashboard
 * card and the MCP tools read any source unchanged. A project maps one source at a time (see actions.ts).
 */
export const SOURCE = "umami";

/**
 * Days of history one run backfills, written a week at a time. Umami answers one day per pair of
 * requests (query.ts), so a run of 28 days and the 3 recent ones is 62 requests, spaced to stay inside
 * Umami Cloud's 50 calls every 15 seconds: about 20 seconds.
 */
const BUDGET_DAYS = 28;
const CHUNK_DAYS = 7;
const INSERT_BATCH = 2_000;

type SyncState = typeof googleSyncState.$inferSelect;

export interface SyncResult {
  more: boolean;
  retryAfterSeconds?: number;
  skipped?: string;
}

class MappingChangedError extends Error {
  constructor() {
    super("The Umami website mapping changed during the sync");
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Inside each write: a remap that already happened aborts it (see assertMapped in the google module). */
async function assertMapped(tx: Tx, scope: ProjectScope, property: string) {
  const [p] = await tx
    .select({ umami: projects.umamiSite })
    .from(projects)
    .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)))
    .for("share");
  if (p?.umami !== property) throw new MappingChangedError();
}

export async function getUmamiSyncState(scope: ProjectScope): Promise<SyncState | null> {
  const [row] = await db.select().from(googleSyncState).where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, SOURCE)));
  return row ?? null;
}

async function patchState(scope: ProjectScope, property: string, set: Partial<SyncState>) {
  await db
    .update(googleSyncState)
    .set(set)
    .where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, SOURCE), eq(googleSyncState.property, property)));
}

/** Drops a project's Analytics rows and Umami sync state, e.g. when it switches source or website. */
export async function resetUmamiData(scope: ProjectScope) {
  await db.transaction(async (tx) => {
    await tx.delete(ga4LandingDaily).where(inScope(ga4LandingDaily, scope));
    await tx.delete(googleSyncState).where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, SOURCE)));
  });
}

async function ensureState(scope: ProjectScope, property: string, today: string): Promise<SyncState> {
  const existing = await getUmamiSyncState(scope);
  const start = historyStart(today);
  if (existing && existing.property === property) {
    if (existing.backfillStart !== start) await patchState(scope, property, { backfillStart: start });
    return { ...existing, backfillStart: start };
  }
  if (existing) await resetUmamiData(scope);
  const [row] = await db.insert(googleSyncState).values({ ...scope, source: SOURCE, property, backfillStart: start }).returning();
  return row;
}

/** Replaces a range's rows with what Umami returned. */
async function write(scope: ProjectScope, property: string, range: DateRange, rows: UmamiLandingRow[]) {
  await db.transaction(async (tx) => {
    await assertMapped(tx, scope, property);
    await tx.delete(ga4LandingDaily).where(and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, range.start, range.end)));
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await tx.insert(ga4LandingDaily).values(rows.slice(i, i + INSERT_BATCH).map((r) => ({ ...scope, ...r })));
    }
  });
  return rows.length;
}

/**
 * One Umami sync run: re-pull the last 3 days (late events still land), then backfill up to 28 days
 * of history oldest-first, re-queued until it reaches 16 months. On a rate limit it pauses 15
 * minutes; progress is kept per week. Days are UTC, because Umami keeps no time zone per website.
 */
export async function syncUmami(scope: ProjectScope, apiOverride?: UmamiApis): Promise<SyncResult> {
  const [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!project?.umamiSite) return { more: false, skipped: "no Umami website mapped" };
  const property = project.umamiSite;
  let state = await ensureState(scope, property, todayIn("UTC"));
  await patchState(scope, property, { status: "running", lastRunAt: new Date(), message: "Fetching organic landing pages" });
  let written = 0;

  try {
    const api = apiOverride ?? umamiApis(scope.workspaceId);
    // Yesterday in UTC, the zone SEOpen asks Umami for days in. Reading the website also proves access to it.
    const site = await api.site(property);
    const newest = addDays(todayIn("UTC"), -1);
    const plan = planSync({
      newest,
      recentDays: 3,
      budgetDays: BUDGET_DAYS,
      state: { backfillStart: state.backfillStart!, backfillCursor: state.backfillCursor, backfillDone: state.backfillDone, latestStored: state.latestDate },
    });
    if (plan.backfill) {
      for (const chunk of chunkRange(plan.backfill, CHUNK_DAYS)) {
        written += await write(scope, property, chunk, await api.organicLandingPages(site, chunk.start, chunk.end));
        const next = addDays(chunk.end, 1);
        await patchState(scope, property, { backfillCursor: next, message: `Backfilling from ${next}` });
        state = { ...state, backfillCursor: next };
      }
    }
    if (plan.recent) written += await write(scope, property, plan.recent, await api.organicLandingPages(site, plan.recent.start, plan.recent.end));

    await patchState(scope, property, {
      ...plan.next,
      latestDate: newest,
      status: "ok",
      lastSuccessAt: new Date(),
      lastError: null,
      quotaFailures: 0,
      rowsWritten: state.rowsWritten + written,
      message: plan.next.backfillDone ? "Up to date" : `Backfill continues from ${plan.next.backfillCursor}`,
    });
    return { more: !plan.next.backfillDone };
  } catch (err) {
    if (err instanceof MappingChangedError) return { more: false, skipped: err.message };
    if (err instanceof UmamiQuotaError) {
      const failures = written > 0 ? 1 : state.quotaFailures + 1;
      await patchState(scope, property, { status: "quota", quotaFailures: failures, lastError: err.message, message: failures >= 3 ? "Rate limited; retrying in an hour" : "Rate limited; retrying in 15 minutes" });
      return { more: true, retryAfterSeconds: failures >= 3 ? 3600 : 15 * 60 };
    }
    const reauth = err instanceof UmamiNotConnectedError || err instanceof UmamiAccessError;
    await patchState(scope, property, {
      status: reauth ? "reauth" : "error",
      lastError: err instanceof Error ? err.message : String(err),
      // What a customer reads. Umami's own text stays in `lastError`.
      message: plainNextStep(err, "This sync didn't finish. It tries again on its own, or use Sync now."),
    });
    throw err;
  }
}
