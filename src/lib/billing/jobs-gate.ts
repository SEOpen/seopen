import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { workspaceJobPauses } from "@/db/schema";
import { hooks } from "@/plan-policy/hooks";
import { rules } from "@/plan-policy/rules";
import { billingContext } from "./context";
import type { Refusal } from "./errors";
import { clearPause, pauseJob } from "./pauses";
import { spendBlock } from "./spend";
import { auditRefusal, lighthouseRefusal, LOCKED_REFUSAL, loadBillingWorkspace, projectLocked } from "./workspace";

/** Scheduled jobs whose calls spend research credits, so they pause when credits run out. */
export const RESEARCH_JOBS: ReadonlySet<string> = new Set(["local.schedule", "local.check"]);

/**
 * The billing check a paid project job runs first (through `jobScope(payload, { paid: true })`):
 * a workspace that can't spend, or a project that's read-only after a downgrade, pauses the job
 * with a banner instead of failing. The DataForSEO client still reserves atomically on each call.
 */
export async function paidJobRefusal(job: string, scope: { workspaceId: number; projectId: number }): Promise<Refusal | null> {
  const block = await spendBlock(scope.workspaceId, { research: RESEARCH_JOBS.has(job) });
  if (block) return block;
  const ws = await loadBillingWorkspace(scope.workspaceId);
  if (await projectLocked(ws, scope.projectId)) return LOCKED_REFUSAL;
  if (!job.startsWith("audit.") && rules.isFree(ws)) return rules.notCoveredRefusal;
  // audit.start posts a crawl the action already counted (and created); the weekly schedule creates a new one.
  if (job === "audit.schedule") return auditRefusal(ws, scope.projectId);
  if (job === "audit.lighthouse") return lighthouseRefusal(ws);
  return null;
}

/** Checks a paid job and records or clears its pause. Returns the refusal, or null to go ahead. */
export async function checkPaidJob(payload: object, scope: { workspaceId: number; projectId: number }): Promise<Refusal | null> {
  const job = billingContext().job?.name ?? "";
  const refusal = await paidJobRefusal(job, scope);
  if (refusal) hooks.refused(scope.workspaceId, refusal);
  if (job) {
    // A plan's quiet refusals are how it works, not something for a pause banner to report.
    if (refusal && !rules.quietRefusalCodes.has(refusal.code)) await pauseJob(job, payload, refusal);
    else await clearPause(job, scope);
  }
  return refusal;
}

/**
 * Re-queues paused jobs whose reason went away without an upgrade: a `platform` pause once the cap
 * has room (the owner raised it, or a new month began), and a `ceiling` or `credits` pause from an
 * earlier month, whose meter reset on the 1st. Each row must first pass the check its job runs
 * (`paidJobRefusal`), so a workspace still over its own ceiling, out of credits, on Free, suspended
 * or not paying keeps its pause and banner, as do pauses for any other reason. `platformOnly` is for
 * the cap's Save, and `workspaceIds` narrows the sweep. Returns how many were queued.
 */
export async function resumeLapsedPauses(
  enqueue: (name: string, data: object) => Promise<unknown>,
  opts: { platformOnly?: boolean; workspaceIds?: number[] } = {},
): Promise<number> {
  const p = workspaceJobPauses;
  const platform = eq(p.reason, "platform");
  const lastMonth = and(inArray(p.reason, ["ceiling", "credits"]), lt(p.pausedAt, sql`date_trunc('month', now())`));
  const rows = await db
    .select()
    .from(p)
    .where(and(opts.platformOnly ? platform : or(platform, lastMonth), opts.workspaceIds ? inArray(p.workspaceId, opts.workspaceIds) : undefined));
  let queued = 0;
  for (const r of rows) {
    const scope = { workspaceId: r.workspaceId, projectId: r.projectId };
    try {
      if (await paidJobRefusal(r.job, scope)) continue;
      // Only the sweep whose delete takes the row queues it, so a Save during the daily run queues it once.
      const taken = await db
        .delete(p)
        .where(and(eq(p.workspaceId, r.workspaceId), eq(p.projectId, r.projectId), eq(p.job, r.job), eq(p.reason, r.reason)))
        .returning({ job: p.job });
      if (!taken.length) continue;
      try {
        await enqueue(r.job, r.payload as object);
      } catch (err) {
        // Not queued, so the pause stands for the next sweep.
        await db.insert(p).values(r).onConflictDoNothing();
        throw err;
      }
      queued++;
    } catch (err) {
      console.error(`[billing] couldn't resume ${r.job} for workspace ${r.workspaceId}, project ${r.projectId}:`, err instanceof Error ? err.message : err);
    }
  }
  return queued;
}
