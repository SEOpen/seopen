import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { workspaceJobPauses } from "@/db/schema";
import { billingContext } from "./context";
import type { Refusal } from "./errors";

/**
 * When a workspace hits a limit, its scheduled jobs pause with a banner ("Rankings paused:
 * monthly limit reached...") instead of failing every day. A pause row keeps the job's payload;
 * an upgrade re-queues it (so does `resumeLapsedPauses` in jobs-gate.ts, once the platform cap or a
 * new month gives it room), and the job passing its checks again clears it.
 */

/** What a paused job did, for the banner. */
export const JOB_LABELS: Record<string, string> = {
  "rank.schedule": "Rankings",
  "rank.check": "Rankings",
  "rank.volumes": "Keyword volumes",
  "audit.schedule": "Weekly site audit",
  "audit.start": "Site audit",
  "audit.lighthouse": "Lighthouse",
  "backlinks.snapshot": "Backlinks snapshot",
  "ai.run": "AI visibility checks",
  "local.schedule": "Local SEO checks",
  "local.check": "Local SEO checks",
};

export const jobLabel = (job: string) => JOB_LABELS[job] ?? job;

type Payload = { workspaceId?: unknown; projectId?: unknown };

function scopeOf(data: unknown): { workspaceId: number; projectId: number } | null {
  const p = (data ?? {}) as Payload;
  return Number.isInteger(p.workspaceId) && Number.isInteger(p.projectId) ? { workspaceId: p.workspaceId as number, projectId: p.projectId as number } : null;
}

/** Records (or refreshes) a pause for a job of this workspace's project. */
export async function pauseJob(job: string, payload: object, refusal: Refusal): Promise<void> {
  const scope = scopeOf(payload);
  if (!scope) return;
  const row = { ...scope, job, payload, reason: refusal.code, message: refusal.message, pausedAt: new Date() };
  await db
    .insert(workspaceJobPauses)
    .values(row)
    .onConflictDoUpdate({
      target: [workspaceJobPauses.workspaceId, workspaceJobPauses.projectId, workspaceJobPauses.job],
      set: { payload, reason: refusal.code, message: refusal.message, pausedAt: row.pausedAt },
    });
}

/** Called by the DataForSEO client on a refusal: pauses the job it ran in, if any, for that job's workspace. */
export async function recordJobPause(err: { workspaceId: number; refusal: Refusal }): Promise<void> {
  const job = billingContext().job;
  if (!job) return;
  const scope = scopeOf(job.data);
  if (!scope || scope.workspaceId !== err.workspaceId) return;
  await pauseJob(job.name, job.data as object, err.refusal);
}

/** The job ran: its pause, if any, is over. */
export async function clearPause(job: string, scope: { workspaceId: number; projectId: number }): Promise<void> {
  await db
    .delete(workspaceJobPauses)
    .where(and(eq(workspaceJobPauses.workspaceId, scope.workspaceId), eq(workspaceJobPauses.projectId, scope.projectId), eq(workspaceJobPauses.job, job)));
}

/**
 * The workspace's current pauses. A ceiling or credits pause from an earlier month is over (the
 * meter reset on the 1st), so it isn't shown even before the job runs again.
 */
export async function listPauses(workspaceId: number) {
  return db
    .select()
    .from(workspaceJobPauses)
    .where(
      and(
        eq(workspaceJobPauses.workspaceId, workspaceId),
        or(
          and(ne(workspaceJobPauses.reason, "ceiling"), ne(workspaceJobPauses.reason, "credits"), ne(workspaceJobPauses.reason, "platform")),
          gte(workspaceJobPauses.pausedAt, sql`date_trunc('month', now())`),
        ),
      ),
    )
    .orderBy(desc(workspaceJobPauses.pausedAt));
}

/**
 * After an upgrade or a grant: queues each of the workspace's paused jobs again with its payload,
 * and deletes its pause. Returns how many were queued.
 *
 * Each row is taken by its own delete, so of two resumes at once only the one whose delete takes
 * it queues it. A job that couldn't be queued gets its row back (unless a new pause has landed
 * since), so its banner stays and the jobs after it are still queued. As `resumeLapsedPauses`.
 */
export async function resumePausedJobs(workspaceId: number, enqueue: (name: string, data: object) => Promise<unknown>): Promise<number> {
  const p = workspaceJobPauses;
  const rows = await db.select().from(p).where(eq(p.workspaceId, workspaceId));
  let queued = 0;
  for (const r of rows) {
    const [taken] = await db
      .delete(p)
      .where(and(eq(p.workspaceId, r.workspaceId), eq(p.projectId, r.projectId), eq(p.job, r.job)))
      .returning();
    if (!taken) continue;
    try {
      await enqueue(taken.job, taken.payload as object);
      queued++;
    } catch (err) {
      await db.insert(p).values(taken).onConflictDoNothing();
      console.error(`[billing] couldn't resume ${taken.job} for workspace ${taken.workspaceId}, project ${taken.projectId}:`, err instanceof Error ? err.message : err);
    }
  }
  return queued;
}
