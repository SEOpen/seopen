import { and, eq, exists, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, fixes, projects } from "@/db/schema";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, inScope, jobScope, type ProjectJobPayload, type ProjectScope } from "@/lib/workspace";
import { GoogleAccessError } from "@/modules/google/auth";
import { gscDataRange } from "@/modules/google/data";
import { urlInProperty } from "@/modules/google/inspect-url";
import { GoogleNotConnectedError } from "@/modules/google/types";
import { dueResults, pastLastCheckpoint } from "./measure";
import { inspectForFix, recordCheck, runLiveCheck, type GoogleView } from "./ops";
import { catchUpAuditFixes, refreshPageImpressions, syncSearchConsoleFixes } from "./sync";

/** A run's limits: these fetch customers' sites and use Search Console's inspection quota. */
const LIVE_CHECKS_PER_RUN = 50;
const INSPECTIONS_PER_RUN = 20;
/** After this long a fix that never reached the page stops being retried. Its next crawl can still settle it. */
const GIVE_UP_DAYS = 30;
const DAY_MS = 86_400_000;

type Project = typeof projects.$inferSelect;

/**
 * Fetches applied fixes' pages to see whether the change is live. The ones checked longest ago (or
 * never) go first, so past LIVE_CHECKS_PER_RUN a newer fix still gets its turn.
 */
export async function checkApplied(scope: ProjectScope, project: Project, now: Date) {
  const cutoff = new Date(now.getTime() - GIVE_UP_DAYS * DAY_MS);
  const rows = await db
    .select()
    .from(fixes)
    .where(and(inScope(fixes, scope), eq(fixes.status, "applied"), sql`${fixes.appliedAt} >= ${cutoff.toISOString()}::timestamptz`))
    .orderBy(sql`(${fixes.liveCheck}->>'checkedAt')::timestamptz asc nulls first`, fixes.appliedAt, fixes.id)
    .limit(LIVE_CHECKS_PER_RUN);
  let live = 0;
  for (const fix of rows) {
    const after = await recordCheck(scope, fix, await runLiveCheck(fix, project.domain, now), null, now);
    if (after.status === "live") live++;
  }
  return { checked: rows.length, live };
}

/**
 * Looks for Google's next crawl of pages that went live. Stops once it has seen one, or once the fix is measured.
 * Only pages in the property take one of the run's INSPECTIONS_PER_RUN, the longest since asked first, and a
 * page whose inspection fails is marked asked, so neither keeps the others waiting.
 */
export async function inspectLive(scope: ProjectScope, project: Project, now: Date) {
  const property = project.gscProperty;
  if (!property) return { inspected: 0 };
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const due = await db
    .select()
    .from(fixes)
    .where(and(inScope(fixes, scope), eq(fixes.status, "live"), sql`${fixes.recrawledAt} is null`, sql`(${fixes.inspectedAt} is null or ${fixes.inspectedAt} < ${dayAgo.toISOString()}::timestamptz)`))
    .orderBy(sql`${fixes.inspectedAt} asc nulls first`, fixes.id);
  const rows = due.filter((f) => urlInProperty(f.url, property)).slice(0, INSPECTIONS_PER_RUN);
  let inspected = 0;
  for (const fix of rows) {
    let google: GoogleView;
    try {
      google = await inspectForFix(scope, property, fix.url);
    } catch (err) {
      // The account or the property is the problem: every page would fail the same way.
      if (err instanceof GoogleNotConnectedError || err instanceof GoogleAccessError) throw err;
      console.error(`[fixes] couldn't inspect ${fix.url} (fix ${fix.id}):`, err instanceof Error ? err.message : err);
      await db.update(fixes).set({ inspectedAt: now, updatedAt: now }).where(and(inScope(fixes, scope), eq(fixes.id, fix.id)));
      continue;
    }
    await recordCheck(scope, fix, fix.liveCheck ?? { state: "cannot_check", saw: "", checkedAt: now.toISOString(), status: null }, google, now);
    inspected++;
  }
  return { inspected };
}

/** Fills in the checkpoints that are due. An applied fix SEOpen couldn't confirm counts from the day it was applied. */
async function measure(scope: ProjectScope, now: Date) {
  const data = await gscDataRange(scope);
  if (!data) return { measured: 0, finished: 0 };
  const rows = await db.select().from(fixes).where(and(inScope(fixes, scope), inArray(fixes.status, ["applied", "live"])));
  let measured = 0;
  let finished = 0;
  for (const fix of rows) {
    if (fix.status === "applied" && fix.liveCheck?.state !== "cannot_check") continue;
    const due = await dueResults(scope, fix, data, now);
    const done = pastLastCheckpoint(fix, data);
    if (!Object.keys(due).length && !done) continue;
    await db
      .update(fixes)
      .set({ results: { ...(fix.results ?? {}), ...due }, status: done ? "measured" : fix.status, updatedAt: now })
      .where(and(inScope(fixes, scope), eq(fixes.id, fix.id)));
    measured += Object.keys(due).length;
    if (done) finished++;
  }
  return { measured, finished };
}

// Background jobs for the fixes module. Names must start with "fixes.".
export const jobs: AnyJobDef[] = [
  defineJob<ProjectJobPayload>({
    name: "fixes.daily",
    // After the Search Console sync at 07:00.
    cron: "0 9 * * *",
    cronData: {},
    policy: "stately",
    retryLimit: 1,
    retryDelay: 600,
    expireInSeconds: 30 * 60,
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await activeProjects(or(isNotNull(projects.gscProperty), exists(db.select({ one: sql`1` }).from(auditCrawls).where(and(eq(auditCrawls.projectId, projects.id), eq(auditCrawls.status, "done")))), exists(db.select({ one: sql`1` }).from(fixes).where(and(eq(fixes.projectId, projects.id), eq(fixes.status, "applied"))))));
        for (const s of targets) await enqueue("fixes.daily", s, { singletonKey: `project:${s.projectId}` });
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload);
      if (!scoped.ok) return { skipped: scoped.reason };
      const { scope, project } = scoped;
      const now = new Date();
      const audit = await catchUpAuditFixes(scope);
      const checks = { audit, ...(await checkApplied(scope, project, now)) };
      try {
        const synced = project.gscProperty ? { ...(await syncSearchConsoleFixes(scope)), impressions: await refreshPageImpressions(scope) } : null;
        const inspected = await inspectLive(scope, project, now);
        return { ...checks, synced, ...inspected, ...(await measure(scope, now)) };
      } catch (err) {
        // No account, a revoked token or a property it can't reach: retrying can't help until the user acts.
        if (err instanceof GoogleNotConnectedError || err instanceof GoogleAccessError) return { ...checks, skipped: err.message, ...(await measure(scope, now)) };
        throw err;
      }
    },
  }),
];
