import { and, eq, gt, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { aiRuns, auditCrawls, localChecks, rankRuns } from "@/db/schema";
import type { WorkspaceScope } from "./index";

/**
 * Past this a row is stuck, not running. The longest a real check takes is about 3 days: rank and
 * Local give up on a task after 3 days and AI after 73 hours. A dead worker or a lost job can leave a
 * row like that, and it mustn't block a delete for good.
 */
const STUCK_AFTER_MS = 4 * 86_400_000;

const CHECKS = [
  { table: rankRuns, since: rankRuns.createdAt },
  { table: aiRuns, since: aiRuns.startedAt },
  { table: auditCrawls, since: auditCrawls.createdAt },
  { table: localChecks, since: localChecks.createdAt },
];

/** Whether a check in the workspace, or in one project of it, is still running and would go on writing. */
export async function anyCheckRunning(scope: WorkspaceScope & { projectId?: number }): Promise<boolean> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const counts = await Promise.all(
    CHECKS.map(({ table, since }) =>
      db.$count(
        table,
        and(
          eq(table.workspaceId, scope.workspaceId),
          scope.projectId === undefined ? undefined : eq(table.projectId, scope.projectId),
          notInArray(table.status, ["done", "failed"]),
          gt(since, cutoff),
        ),
      ),
    ),
  );
  return counts.some((n) => n > 0);
}
