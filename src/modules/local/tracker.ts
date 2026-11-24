// Geo-grid checks on the DataForSEO Standard queue: create a check's points, post one Google Maps
// task per point per keyword, poll tasks_ready, store results. Runs in the worker (jobs.ts) only;
// pages read the tables through queries.ts.
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/db";
import { projects } from "@/db/schema/core";
import { localBusinesses, localChecks, localKeywords, localPoints, ONE_ACTIVE_CHECK_INDEX } from "@/db/schema/local";
import { POSTING_NEVER_FINISHED, STALE_POSTING_MS } from "@/lib/check-failure";
import { dfsGet, dfsPost, type DfsTask } from "@/lib/dataforseo/client";
import { activeProjects, type ProjectScope, type WorkspaceScope } from "@/lib/workspace";
import { isUniqueViolation } from "@/modules/rank/db-errors";
import { DEPTH, estimateCheckUsd, gridPoints, locationCoordinate, zoomForRadius } from "./grid";
import { makeTag, parseTag, pointOutcome } from "./parse";
import type { MapsResult, TasksReadyResult } from "./types";

export type LocalBusiness = typeof localBusinesses.$inferSelect;
export type LocalCheck = typeof localChecks.$inferSelect;

/** Days between scheduled checks. */
export const CHECK_EVERY_DAYS = 7;

export async function getBusiness(scope: ProjectScope, businessId: number): Promise<LocalBusiness | null> {
  if (!Number.isInteger(businessId)) return null;
  const [b] = await db
    .select()
    .from(localBusinesses)
    .where(
      and(eq(localBusinesses.id, businessId), eq(localBusinesses.workspaceId, scope.workspaceId), eq(localBusinesses.projectId, scope.projectId)),
    );
  return b ?? null;
}

async function getCheck(scope: ProjectScope, checkId: number): Promise<LocalCheck | null> {
  if (!Number.isInteger(checkId)) return null;
  const [c] = await db
    .select()
    .from(localChecks)
    .where(and(eq(localChecks.id, checkId), eq(localChecks.workspaceId, scope.workspaceId), eq(localChecks.projectId, scope.projectId)));
  return c ?? null;
}

/**
 * Creates a check (status "posting") with one pending point per keyword per grid point, using the
 * business's grid at this moment. Returns null when the business has a check in flight (a partial
 * unique index allows one), so a double click or the schedule racing "Check now" can't pay twice,
 * and also when it has no keywords.
 */
export async function createCheck(scope: ProjectScope, business: LocalBusiness, kind: LocalCheck["kind"]): Promise<LocalCheck | null> {
  await db
    .update(localChecks)
    .set({ status: "failed", error: POSTING_NEVER_FINISHED, finishedAt: new Date() })
    .where(
      and(
        eq(localChecks.workspaceId, scope.workspaceId),
        eq(localChecks.businessId, business.id),
        eq(localChecks.status, "posting"),
        lt(localChecks.createdAt, new Date(Date.now() - STALE_POSTING_MS)),
      ),
    );
  const keywords = await db
    .select({ id: localKeywords.id })
    .from(localKeywords)
    .where(and(eq(localKeywords.workspaceId, scope.workspaceId), eq(localKeywords.businessId, business.id)));
  if (!keywords.length) return null;
  const grid = gridPoints(business.lat, business.lng, business.gridSize, business.radiusMiles);
  try {
    return await db.transaction(async (tx) => {
      const [check] = await tx
        .insert(localChecks)
        .values({
          ...scope,
          businessId: business.id,
          kind,
          gridSize: business.gridSize,
          radiusMiles: business.radiusMiles,
          zoom: zoomForRadius(business.radiusMiles),
          lat: business.lat,
          lng: business.lng,
          tasksTotal: grid.length * keywords.length,
        })
        .returning();
      await tx.insert(localPoints).values(
        keywords.flatMap((k) => grid.map((p) => ({ workspaceId: scope.workspaceId, checkId: check.id, keywordId: k.id, ...p }))),
      );
      return check;
    });
  } catch (e) {
    if (isUniqueViolation(e, ONE_ACTIVE_CHECK_INDEX)) return null;
    throw e;
  }
}

const POST_BATCH = 100;

/**
 * Posts one Maps task per pending point of a check. Safe to retry: points that already have a task
 * are skipped. A check id from another project does nothing.
 */
export async function postCheck(scope: ProjectScope, checkId: number): Promise<void> {
  const check = await getCheck(scope, checkId);
  if (!check || check.status !== "posting") return;
  const [project] = await db
    .select({ languageCode: projects.languageCode })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) return;
  const todo = await db
    .select({ id: localPoints.id, lat: localPoints.lat, lng: localPoints.lng, keyword: localKeywords.keyword })
    .from(localPoints)
    .innerJoin(localKeywords, eq(localKeywords.id, localPoints.keywordId))
    .where(and(eq(localPoints.workspaceId, scope.workspaceId), eq(localPoints.checkId, checkId), isNull(localPoints.taskId), eq(localPoints.status, "pending")));

  let cost = 0;
  let error: string | null = null;
  try {
    for (let i = 0; i < todo.length; i += POST_BATCH) {
      const batch = todo.slice(i, i + POST_BATCH);
      const res = await dfsPost<null>(
        "serp/google/maps/task_post",
        batch.map((p) => ({
          keyword: p.keyword,
          location_coordinate: locationCoordinate(p.lat, p.lng, check.zoom),
          language_code: project.languageCode,
          device: "mobile",
          os: "android",
          depth: DEPTH,
          priority: 1,
          tag: makeTag(check.id, p.id),
        })),
        {
          workspaceId: scope.workspaceId,
          module: "local",
          projectId: scope.projectId,
          ttlSeconds: 0,
          // Refused up front when this batch would pass the ceiling or the research credits.
          estimateUsd: estimateCheckUsd(1, batch.length),
        },
      );
      cost += res.cost ?? 0;
      const now = new Date();
      // Task ids and refusals by point id. A point named twice keeps the later one of each, as when
      // each task was written in turn: the two writes set different columns.
      const posted = new Map<number, string>();
      const refused = new Map<number, string>();
      for (const task of res.tasks ?? []) {
        const ids = parseTag(String(task.data?.tag ?? ""));
        if (!ids || ids.checkId !== check.id) continue;
        if (task.status_code === 20100) posted.set(ids.pointId, task.id);
        else {
          error = `${task.status_code} ${task.status_message}`;
          refused.set(ids.pointId, error);
        }
      }
      // Two statements per post, not one per point. A post is at most POST_BATCH tasks, so one JSON parameter each.
      if (posted.size) {
        const rows = [...posted].map(([id, taskId]) => ({ id, task_id: taskId }));
        await db
          .update(localPoints)
          .set({ taskId: sql`v.task_id`, postedAt: now })
          .from(sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(id integer, task_id text)`)
          .where(and(eq(localPoints.id, sql`v.id`), eq(localPoints.workspaceId, scope.workspaceId)));
      }
      if (refused.size) {
        const rows = [...refused].map(([id, why]) => ({ id, error: why }));
        await db
          .update(localPoints)
          .set({ status: "failed", error: sql`v.error`, fetchedAt: now })
          .from(sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(id integer, error text)`)
          .where(and(eq(localPoints.id, sql`v.id`), eq(localPoints.workspaceId, scope.workspaceId)));
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await finishPosting(scope, checkId, error, cost);
}

/** Ends a check's posting. What was posted goes on to be polled; a check with nothing posted has failed. */
async function finishPosting({ workspaceId }: WorkspaceScope, checkId: number, error: string | null, cost = 0): Promise<void> {
  // Points the post never reached can't land: say why, so they show as failed rather than waiting forever.
  await db
    .update(localPoints)
    .set({ status: "failed", error: error ?? "Not posted", fetchedAt: new Date() })
    .where(and(eq(localPoints.workspaceId, workspaceId), eq(localPoints.checkId, checkId), isNull(localPoints.taskId), eq(localPoints.status, "pending")));

  const [{ posted }] = await db
    .select({ posted: sql<number>`count(*)::int` })
    .from(localPoints)
    .where(and(eq(localPoints.workspaceId, workspaceId), eq(localPoints.checkId, checkId), isNotNull(localPoints.taskId)));
  await db
    .update(localChecks)
    .set({
      status: posted > 0 ? "pending" : "failed",
      costUsd: sql`${localChecks.costUsd} + ${cost}`,
      error,
      finishedAt: posted > 0 ? null : new Date(),
    })
    .where(and(eq(localChecks.id, checkId), eq(localChecks.workspaceId, workspaceId)));
  await refreshCheck(checkId);
}

/**
 * The local.check job was refused, so nothing else will post this check. Without this it reads as
 * running, and blocks the business's next check and the workspace's delete. A resumed job then finds
 * it closed and does nothing, as it does for a check the client refused partway through posting.
 */
export async function closeRefusedCheck({ workspaceId, projectId, checkId }: { workspaceId?: number; projectId?: number; checkId: number }, reason: string): Promise<void> {
  if (!Number.isInteger(workspaceId) || !Number.isInteger(projectId)) return;
  const scope = { workspaceId: workspaceId!, projectId: projectId! };
  const check = await getCheck(scope, checkId);
  if (check?.status === "posting") await finishPosting(scope, checkId, reason);
}

/** Checks that lost their local.check job. This job isn't gated by plan, so it also reaches a workspace that can't start another check. */
async function closeStalePosting(): Promise<void> {
  const stale = await db
    .select({ id: localChecks.id, workspaceId: localChecks.workspaceId })
    .from(localChecks)
    .where(and(eq(localChecks.status, "posting"), lt(localChecks.createdAt, new Date(Date.now() - STALE_POSTING_MS))));
  for (const c of stale) await finishPosting(c, c.id, POSTING_NEVER_FINISHED);
}

/** Statuses where the task is gone for good. */
const GONE = new Set([40401, 40403]);
/** Tasks without a result after this long are given up on (tasks_ready only covers 3 days). */
const GIVE_UP_MS = 3 * 86_400_000;
/** Tasks not listed in tasks_ready after this long are fetched directly, in case another poller consumed the listing. */
const DIRECT_FETCH_AFTER_MS = 15 * 60_000;
/** Server-side errors (5xxxx) are retried on later passes for this long before the point fails. */
const RETRY_ERRORS_MS = 6 * 3_600_000;

export interface PollStats {
  pending: number;
  fetched: number;
  stored: number;
  failed: number;
}

/**
 * One polling pass: one tasks_ready call (free), then task_get (free) for each of our ready
 * tasks. Makes no API call when nothing is pending. Global across workspaces; each point's check
 * says which workspace and business its result belongs to.
 */
export async function pollOnce(): Promise<PollStats> {
  await closeStalePosting();
  const pending = await db
    .select({
      id: localPoints.id,
      taskId: localPoints.taskId,
      checkId: localPoints.checkId,
      postedAt: localPoints.postedAt,
      workspaceId: localChecks.workspaceId,
      projectId: localChecks.projectId,
      cid: localBusinesses.cid,
      placeId: localBusinesses.placeId,
    })
    .from(localPoints)
    .innerJoin(localChecks, and(eq(localChecks.id, localPoints.checkId), eq(localChecks.workspaceId, localPoints.workspaceId)))
    .innerJoin(localBusinesses, and(eq(localBusinesses.id, localChecks.businessId), eq(localBusinesses.workspaceId, localChecks.workspaceId)))
    .where(and(eq(localPoints.status, "pending"), isNotNull(localPoints.taskId)));
  const stats: PollStats = { pending: pending.length, fetched: 0, stored: 0, failed: 0 };
  if (!pending.length) return stats;

  const ready = await dfsGet<TasksReadyResult>("serp/google/maps/tasks_ready", { module: "local", free: true });
  const readyIds = new Set((ready.tasks?.[0]?.result ?? []).map((r) => r.id));
  const now = Date.now();
  const age = (t: (typeof pending)[number]) => now - (t.postedAt?.getTime() ?? now);
  const due = pending.filter((t) => readyIds.has(t.taskId!) || age(t) > DIRECT_FETCH_AFTER_MS);

  const limit = pLimit(5);
  const touched = new Set<number>();
  await Promise.all(
    due.slice(0, 300).map((t) =>
      limit(async () => {
        let task: DfsTask<MapsResult> | undefined;
        try {
          const res = await dfsGet<MapsResult>(`serp/google/maps/task_get/advanced/${t.taskId}`, {
            workspaceId: t.workspaceId,
            module: "local",
            projectId: t.projectId,
            free: true,
          });
          task = res.tasks?.[0];
        } catch (e) {
          console.error(`[local.poll] task_get ${t.taskId}`, e);
          return;
        }
        stats.fetched++;
        const out = pointOutcome(task, { cid: t.cid, placeId: t.placeId });
        const code = task?.status_code ?? 0;
        // A server-side error may clear up: try again on a later pass, unless the task is gone or old.
        if (out.status === "wait" || (out.status === "failed" && code >= 50000 && !GONE.has(code) && age(t) < RETRY_ERRORS_MS)) return;
        try {
          await db
            .update(localPoints)
            .set(
              out.status === "done"
                ? { status: "done", rank: out.rank, items: out.items, error: null, fetchedAt: new Date() }
                : { status: "failed", rank: null, error: out.error, fetchedAt: new Date() },
            )
            .where(and(eq(localPoints.id, t.id), eq(localPoints.status, "pending")));
        } catch (e) {
          console.error(`[local.poll] storing ${t.taskId}`, e);
          return;
        }
        if (out.status === "done") stats.stored++;
        else stats.failed++;
        touched.add(t.checkId);
      }),
    ),
  );

  const stale = await db
    .update(localPoints)
    .set({ status: "failed", error: "No result after 3 days", fetchedAt: new Date() })
    .where(and(eq(localPoints.status, "pending"), lt(localPoints.postedAt, new Date(now - GIVE_UP_MS))))
    .returning({ checkId: localPoints.checkId });
  for (const s of stale) touched.add(s.checkId);

  for (const id of touched) await refreshCheck(id);
  return stats;
}

/** Recounts a check's points and closes it when nothing is pending. */
export async function refreshCheck(checkId: number) {
  const counts = await db
    .select({ status: localPoints.status, n: sql<number>`count(*)::int` })
    .from(localPoints)
    .where(eq(localPoints.checkId, checkId))
    .groupBy(localPoints.status);
  const get = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const pending = get("pending");
  await db
    .update(localChecks)
    .set({
      tasksDone: get("done"),
      tasksFailed: get("failed"),
      ...(pending === 0 ? { status: get("done") > 0 ? "done" : "failed", finishedAt: new Date() } : {}),
    })
    .where(and(eq(localChecks.id, checkId), eq(localChecks.status, "pending")));
}

/** Active projects with at least one scheduled business: the daily fan-out. */
export async function projectsToCheck(): Promise<ProjectScope[]> {
  return activeProjects(
    inArray(
      projects.id,
      db.selectDistinct({ id: localBusinesses.projectId }).from(localBusinesses).where(eq(localBusinesses.scheduled, true)),
    ),
  );
}

/**
 * Creates the weekly check for each scheduled business of a project whose last check (scheduled
 * or manual, not failed) is a week old or more, or that has never been checked. Returns the
 * checks to post. Idempotent: a business with a recent or running check is skipped.
 */
export async function scheduleProject(scope: ProjectScope, now = new Date()): Promise<LocalCheck[]> {
  const businesses = await db
    .select()
    .from(localBusinesses)
    .where(and(eq(localBusinesses.workspaceId, scope.workspaceId), eq(localBusinesses.projectId, scope.projectId), eq(localBusinesses.scheduled, true)));
  // A little slack, so a check that ran at 06:31 last week is due again at 06:30.
  const dueBefore = new Date(now.getTime() - CHECK_EVERY_DAYS * 86_400_000 + 3 * 3_600_000);
  const out: LocalCheck[] = [];
  for (const b of businesses) {
    const [recent] = await db
      .select({ id: localChecks.id })
      .from(localChecks)
      .where(
        and(
          eq(localChecks.workspaceId, scope.workspaceId),
          eq(localChecks.businessId, b.id),
          inArray(localChecks.status, ["posting", "pending", "done"]),
          // Through the column, not raw sql: a raw Date is sent as Date.toString(), which Postgres rejects.
          gt(localChecks.createdAt, dueBefore),
        ),
      )
      .limit(1);
    if (recent) continue;
    const check = await createCheck(scope, b, "scheduled");
    if (check) out.push(check);
  }
  return out;
}
