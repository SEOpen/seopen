import { and, between, eq } from "drizzle-orm";
import { db } from "@/db";
import { ga4LandingDaily, googleSyncState, gscBreakdown, gscDaily, gscPages, gscQueries, gscQueryPages, projects } from "@/db/schema";
import { gscRowsPerDay } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { plainNextStep } from "@/lib/dataforseo/failure-copy";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { googleApis } from "./apis";
import { GoogleAccessError } from "./auth";
import { GoogleNotConnectedError, GoogleQuotaError, type GoogleApis, type GscDimension, type GscRow } from "./types";
import { addDays, chunkRange, eachDay, GSC_TIME_ZONE, historyStart, maxDate, newestFinalDate, planSync, todayIn, type DateRange } from "./windowing";

export type Source = "gsc" | "ga4";
type SyncState = typeof googleSyncState.$inferSelect;

/** Days of history one run backfills. GSC: ~3 heavy requests per day; GA4: one paged report. */
const GSC_BUDGET_DAYS = 30;
const GA4_BUDGET_DAYS = 120;
const INSERT_BATCH = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The project's mapping moved to another property while this run was in flight. */
class MappingChangedError extends Error {
  constructor(source: Source) {
    super(`The ${source} property mapping changed during the sync`);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Called inside each write transaction. The row lock makes a concurrent remap wait for this
 * transaction, whose rows the remap's reset then deletes; a remap that already happened aborts it.
 */
async function assertMapped(tx: Tx, scope: ProjectScope, source: Source, property: string) {
  const [p] = await tx
    .select({ gsc: projects.gscProperty, ga4: projects.ga4Property })
    .from(projects)
    .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)))
    .for("share");
  if ((source === "gsc" ? p?.gsc : p?.ga4) !== property) throw new MappingChangedError(source);
}

export async function getSyncState(scope: ProjectScope, source: Source): Promise<SyncState | null> {
  const [row] = await db
    .select()
    .from(googleSyncState)
    .where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, source)));
  return row ?? null;
}

/** Updates the state row, only while it still belongs to `property` (a remap replaces the row). */
async function patchState(scope: ProjectScope, source: Source, property: string, set: Partial<SyncState>) {
  await db
    .update(googleSyncState)
    .set(set)
    .where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, source), eq(googleSyncState.property, property)));
}

/** Drops a project's stored data for a source, e.g. after its property mapping changes. */
export async function resetGoogleData(scope: ProjectScope, source: Source) {
  await db.transaction(async (tx) => {
    if (source === "gsc") {
      for (const t of [gscDaily, gscBreakdown, gscPages, gscQueries, gscQueryPages]) await tx.delete(t).where(inScope(t, scope));
    } else {
      await tx.delete(ga4LandingDaily).where(inScope(ga4LandingDaily, scope));
    }
    await tx.delete(googleSyncState).where(and(inScope(googleSyncState, scope), eq(googleSyncState.source, source)));
  });
}

/** State row for the current property; a changed property starts over. */
async function ensureState(scope: ProjectScope, source: Source, property: string, today: string): Promise<SyncState> {
  const existing = await getSyncState(scope, source);
  if (existing && existing.property === property) {
    // The 16-month window slides forward every day.
    const start = historyStart(today);
    if (existing.backfillStart !== start) await patchState(scope, source, property, { backfillStart: start });
    return { ...existing, backfillStart: start };
  }
  if (existing) await resetGoogleData(scope, source);
  const [row] = await db
    .insert(googleSyncState)
    .values({ ...scope, source, property, backfillStart: historyStart(today) })
    .returning();
  return row;
}

async function insertBatched<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) await insert(rows.slice(i, i + INSERT_BATCH));
}

const metric = (r: GscRow) => ({ clicks: Math.round(r.clicks), impressions: Math.round(r.impressions), ctr: r.ctr, position: r.position });

/** Totals, countries and devices: small row counts, so one request covers a whole range. */
async function syncGscCheap(api: GoogleApis, scope: ProjectScope, siteUrl: string, range: DateRange): Promise<number> {
  let written = 0;
  for (const chunk of chunkRange(range, 90)) {
    const q = (dimensions: GscDimension[]) => api.gsc.query(siteUrl, { startDate: chunk.start, endDate: chunk.end, dimensions });
    const [totals, countries, devices] = [await q(["date"]), await q(["date", "country"]), await q(["date", "device"])];
    await db.transaction(async (tx) => {
      await assertMapped(tx, scope, "gsc", siteUrl);
      await tx.delete(gscDaily).where(and(inScope(gscDaily, scope), between(gscDaily.date, chunk.start, chunk.end)));
      await tx.delete(gscBreakdown).where(and(inScope(gscBreakdown, scope), between(gscBreakdown.date, chunk.start, chunk.end)));
      if (totals.rows.length) await tx.insert(gscDaily).values(totals.rows.map((r) => ({ ...scope, date: r.keys[0], ...metric(r) })));
      const breakdown = [
        ...countries.rows.map((r) => ({ ...scope, date: r.keys[0], kind: "country", key: r.keys[1], ...metric(r) })),
        ...devices.rows.map((r) => ({ ...scope, date: r.keys[0], kind: "device", key: r.keys[1], ...metric(r) })),
      ];
      await insertBatched(breakdown, (b) => tx.insert(gscBreakdown).values(b));
    });
    written += totals.rows.length + countries.rows.length + devices.rows.length;
  }
  return written;
}

/** Pages, queries and query×page for one day: one request each (GSC caps these at 50k rows a day). */
async function syncGscDay(api: GoogleApis, scope: ProjectScope, siteUrl: string, day: string, rowCap: number | null): Promise<number> {
  const pace = api.mode === "live" ? 300 : 0;
  const q = async (dimensions: GscDimension[]) => {
    const res = await api.gsc.query(siteUrl, { startDate: day, endDate: day, dimensions });
    if (pace) await sleep(pace);
    return res.rows;
  };
  const pages = await q(["date", "page"]);
  const queries = await q(["date", "query"]);
  // The plan keeps the top query×page rows by clicks per day (unlimited for the owner).
  const allPairs = await q(["date", "query", "page"]);
  const pairs = rowCap === null || allPairs.length <= rowCap ? allPairs : [...allPairs].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, rowCap);
  await db.transaction(async (tx) => {
    await assertMapped(tx, scope, "gsc", siteUrl);
    await tx.delete(gscPages).where(and(inScope(gscPages, scope), eq(gscPages.date, day)));
    await tx.delete(gscQueries).where(and(inScope(gscQueries, scope), eq(gscQueries.date, day)));
    await tx.delete(gscQueryPages).where(and(inScope(gscQueryPages, scope), eq(gscQueryPages.date, day)));
    await insertBatched(pages, (b) => tx.insert(gscPages).values(b.map((r) => ({ ...scope, date: day, page: r.keys[1], ...metric(r) }))));
    await insertBatched(queries, (b) => tx.insert(gscQueries).values(b.map((r) => ({ ...scope, date: day, query: r.keys[1], ...metric(r) }))));
    await insertBatched(pairs, (b) =>
      tx.insert(gscQueryPages).values(b.map((r) => ({ ...scope, date: day, query: r.keys[1], page: r.keys[2], ...metric(r) }))),
    );
  });
  return pages.length + queries.length + pairs.length;
}

export interface SyncResult {
  /** True while the backfill has more history to fetch; the job re-queues itself. */
  more: boolean;
  /** Set on a quota error: try again after this many seconds. */
  retryAfterSeconds?: number;
  skipped?: string;
}

/** On quota errors, pause 15 minutes; after three in a row, wait for tomorrow's quota. */
async function onQuota(scope: ProjectScope, source: Source, state: SyncState, err: Error, progressed: boolean): Promise<SyncResult> {
  // A run that got some work done before the quota hit starts the count over.
  const failures = progressed ? 1 : state.quotaFailures + 1;
  const retryAfterSeconds = failures >= 3 ? 6 * 3600 : 15 * 60;
  await patchState(scope, source, state.property, {
    status: "quota",
    quotaFailures: failures,
    lastError: err.message,
    message: failures >= 3 ? "Daily quota reached; resuming later today" : "Quota hit; retrying in 15 minutes",
  });
  return { more: true, retryAfterSeconds };
}

/** `message` is what a customer reads, in plain words. Google's own text stays in `lastError` and the logs. */
async function onFailure(scope: ProjectScope, source: Source, property: string, err: unknown) {
  const reauth = err instanceof GoogleNotConnectedError || err instanceof GoogleAccessError;
  console.error(`[google.sync] ${source} failed`, err);
  await patchState(scope, source, property, {
    status: reauth ? "reauth" : "error",
    lastError: err instanceof Error ? err.message : String(err),
    message: plainNextStep(err, "This sync didn't finish. It tries again on its own, or use Sync now."),
  });
}

/**
 * One Search Console sync run: re-pull the last 5 final days, then backfill up to 30 more days
 * of history oldest-first. Progress is saved per day, so a failed run resumes where it stopped.
 */
export async function syncGsc(scope: ProjectScope, apiOverride?: GoogleApis): Promise<SyncResult> {
  const [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!project?.gscProperty) return { more: false, skipped: "no Search Console property mapped" };
  const siteUrl = project.gscProperty;
  const today = todayIn(GSC_TIME_ZONE);
  let state = await ensureState(scope, "gsc", siteUrl, today);
  await patchState(scope, "gsc", siteUrl, { status: "running", lastRunAt: new Date(), message: "Checking for new data" });
  let written = 0;

  try {
    const api = apiOverride ?? (await googleApis(scope.workspaceId));
    // Cheap probe: which recent days exist, and which are still preliminary.
    const probe = await api.gsc.query(siteUrl, { startDate: addDays(today, -10), endDate: today, dimensions: ["date"], dataState: "all" });
    const newest = newestFinalDate(
      probe.rows.map((r) => r.keys[0]),
      probe.firstIncompleteDate,
    );

    let earliestWithData: string | null = null;
    if (!state.backfillDone && !state.backfillCursor && newest) {
      const all = await api.gsc.query(siteUrl, { startDate: state.backfillStart!, endDate: newest, dimensions: ["date"] });
      earliestWithData = all.rows.map((r) => r.keys[0]).sort()[0] ?? null;
    }

    const plan = planSync({
      newest,
      recentDays: 5,
      budgetDays: GSC_BUDGET_DAYS,
      earliestWithData,
      state: { backfillStart: state.backfillStart!, backfillCursor: state.backfillCursor, backfillDone: state.backfillDone, latestStored: state.latestDate },
    });

    // Read once for the run: a backfill syncs a month of days.
    const rowCap = gscRowsPerDay(await loadBillingWorkspace(scope.workspaceId));
    if (plan.backfill) {
      await patchState(scope, "gsc", siteUrl, { message: `Backfilling ${plan.backfill.start} → ${plan.backfill.end}` });
      written += await syncGscCheap(api, scope, siteUrl, plan.backfill);
      for (const day of eachDay(plan.backfill)) {
        written += await syncGscDay(api, scope, siteUrl, day, rowCap);
        const next = addDays(day, 1);
        await patchState(scope, "gsc", siteUrl, { backfillCursor: next });
        state = { ...state, backfillCursor: next };
      }
    }
    if (plan.recent) {
      await patchState(scope, "gsc", siteUrl, { message: `Refreshing ${plan.recent.start} → ${plan.recent.end}` });
      written += await syncGscCheap(api, scope, siteUrl, plan.recent);
      for (const day of eachDay(plan.recent)) written += await syncGscDay(api, scope, siteUrl, day, rowCap);
    }

    const latest = plan.recent ? (state.latestDate ? maxDate(state.latestDate, plan.recent.end) : plan.recent.end) : state.latestDate;
    await patchState(scope, "gsc", siteUrl, {
      ...plan.next,
      latestDate: latest,
      status: "ok",
      lastSuccessAt: new Date(),
      lastError: null,
      quotaFailures: 0,
      rowsWritten: state.rowsWritten + written,
      message: !newest ? "No final data in Search Console yet" : plan.next.backfillDone ? "Up to date" : `Backfill continues from ${plan.next.backfillCursor}`,
    });
    return { more: !plan.next.backfillDone && !!newest };
  } catch (err) {
    if (err instanceof MappingChangedError) return { more: false, skipped: err.message };
    if (err instanceof GoogleQuotaError) return onQuota(scope, "gsc", state, err, written > 0);
    await onFailure(scope, "gsc", siteUrl, err);
    throw err;
  }
}

/** Upserts GA4 rows for a range: delete the range, insert what came back. */
async function writeGa4(scope: ProjectScope, property: string, range: DateRange, rows: Awaited<ReturnType<GoogleApis["ga4"]["organicLandingPages"]>>) {
  // GA4 can return the same landing page twice for a day when hostnames differ only by case.
  const merged = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.date}|${r.hostName.toLowerCase()}|${r.landingPage}`;
    const prev = merged.get(k);
    merged.set(
      k,
      prev
        ? { ...prev, sessions: prev.sessions + r.sessions, engagedSessions: prev.engagedSessions + r.engagedSessions, keyEvents: prev.keyEvents + r.keyEvents, totalRevenue: prev.totalRevenue + r.totalRevenue }
        : { ...r, hostName: r.hostName.toLowerCase() },
    );
  }
  await db.transaction(async (tx) => {
    await assertMapped(tx, scope, "ga4", property);
    await tx.delete(ga4LandingDaily).where(and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, range.start, range.end)));
    await insertBatched([...merged.values()], (b) => tx.insert(ga4LandingDaily).values(b.map((r) => ({ ...scope, ...r }))));
  });
  return merged.size;
}

/** One GA4 sync run: re-pull the last 3 days (GA4 revises ~48h back), then backfill 120 days. */
export async function syncGa4(scope: ProjectScope, apiOverride?: GoogleApis): Promise<SyncResult> {
  const [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!project?.ga4Property) return { more: false, skipped: "no GA4 property mapped" };
  const property = project.ga4Property;
  // The server's day only sets the 16-month window; "yesterday" comes from the property's time zone.
  const state = await ensureState(scope, "ga4", property, todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone));
  await patchState(scope, "ga4", property, { status: "running", lastRunAt: new Date(), message: "Fetching organic landing pages" });
  let written = 0;

  try {
    const api = apiOverride ?? (await googleApis(scope.workspaceId));
    const newest = addDays(todayIn(await api.ga4.timeZone(property)), -1);
    const plan = planSync({
      newest,
      recentDays: 3,
      budgetDays: GA4_BUDGET_DAYS,
      state: { backfillStart: state.backfillStart!, backfillCursor: state.backfillCursor, backfillDone: state.backfillDone, latestStored: state.latestDate },
    });
    for (const range of [plan.backfill, plan.recent]) {
      if (!range) continue;
      const rows = await api.ga4.organicLandingPages(property, range.start, range.end);
      written += await writeGa4(scope, property, range, rows);
    }
    await patchState(scope, "ga4", property, {
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
    if (err instanceof GoogleQuotaError) return onQuota(scope, "ga4", state, err, written > 0);
    await onFailure(scope, "ga4", property, err);
    throw err;
  }
}
