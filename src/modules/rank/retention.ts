import { and, eq, gte, inArray, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { rankRuns, rankTasks } from "@/db/schema/rank";
import { deleteInBatches } from "@/lib/purge";

/**
 * How long a finished run's tasks stay after the last one was fetched. The poller marks a task
 * that never finished as failed and only then settles its keyword from the run's earlier looks
 * (`pollOnce` in tracker.ts), so this covers a pass in flight: twelve times the 5 minutes rank.poll
 * may run.
 */
export const TASK_KEEP_MS = 60 * 60_000;

/**
 * Deletes the tasks of runs that are done or failed, once none of the run's tasks is pending and
 * the last was fetched TASK_KEEP_MS ago (the daily billing.alerts job). The tracker reads a run's
 * tasks only while the run is posting (`postRun`, `stopPosting`), while a task is pending
 * (`pollOnce`, and `settleKeyword` for the earlier looks), and `refreshRun` recounts only a pending
 * run. A finished run keeps its counts on rank_runs and its positions in rank_results. A run closed
 * while tasks were still out (`createRun` fails a stale posting run) keeps them until they finish.
 * Runs in the worker.
 */
export async function purgeFinishedTasks(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - TASK_KEEP_MS);
  const other = alias(rankTasks, "other");
  const busy = db
    .select({ id: other.id })
    .from(other)
    .where(
      and(
        eq(other.runId, rankTasks.runId),
        or(eq(other.status, "pending"), gte(other.fetchedAt, since), and(isNull(other.fetchedAt), gte(other.postedAt, since))),
      ),
    );
  return deleteInBatches(async (limit) => {
    const batch = db
      .select({ id: rankTasks.id })
      .from(rankTasks)
      .innerJoin(rankRuns, and(eq(rankRuns.id, rankTasks.runId), eq(rankRuns.workspaceId, rankTasks.workspaceId)))
      .where(and(inArray(rankRuns.status, ["done", "failed"]), notExists(busy)))
      .limit(limit);
    const rows = await db.delete(rankTasks).where(inArray(rankTasks.id, batch)).returning({ id: rankTasks.id });
    return rows.length;
  });
}
