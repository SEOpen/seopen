import { notInArray } from "drizzle-orm";
import { db } from "@/db";
import { googleSyncState } from "@/db/schema";
import { enqueue } from "@/lib/jobs/boss";
import type { ProjectScope } from "@/lib/workspace";
import { historyStart, todayIn } from "@/modules/google/windowing";
import { SYNC_JOB } from "./jobs";
import { SOURCE } from "./sync";

/**
 * Queues an Umami sync and shows "queued" until the worker picks it up. The worker creates the
 * queue when it starts, so right after a deploy the web app can be ahead of it; then the project
 * waits for the daily cron, which syncs every mapped project.
 */
export async function queueUmamiSync(scope: ProjectScope, property: string) {
  let message = "Waiting for the worker";
  try {
    if (!(await enqueue(SYNC_JOB, scope, { singletonKey: `project:${scope.projectId}` }))) return;
  } catch (err) {
    if ((err as { code?: string }).code !== "PGBOSS_QUEUE_NOT_FOUND") throw err;
    message = "Starts with the next daily sync";
  }
  await db
    .insert(googleSyncState)
    .values({ ...scope, source: SOURCE, property, backfillStart: historyStart(todayIn("UTC")), status: "queued", message })
    .onConflictDoUpdate({
      target: [googleSyncState.projectId, googleSyncState.source],
      set: { status: "queued", message },
      setWhere: notInArray(googleSyncState.status, ["running", "quota"]),
    });
}
