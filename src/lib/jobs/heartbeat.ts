import { db } from "@/db";
import { settings } from "@/db/schema";
import { defineJob, type AnyJobDef } from "./types";

/**
 * The worker's heartbeat. A worker can crash-loop at startup while its host shows it as running, and
 * nothing would say so. So the worker writes one `settings` row: once when it has registered its jobs,
 * then every 2 minutes from the `worker.heartbeat` cron job, so a fresh row proves pg-boss is scheduling
 * crons and the worker is taking jobs off its queues, not only that the process is up. The web app
 * reads its age (src/lib/jobs/worker-watch.ts): a scheduled call emails the operator when it's stale, and
 * Admin → Health shows it.
 *
 * The worker loads this under plain tsx, so it must never reach a `server-only` module.
 */

export const WORKER_HEARTBEAT_KEY = "platform.worker_heartbeat";

/** How often `worker.heartbeat` runs. The watch allows several missed beats before it calls the worker down. */
export const HEARTBEAT_EVERY_MINUTES = 2;

export interface WorkerHeartbeat {
  /** When this beat was written. */
  at: string;
  /** When the process writing it registered its jobs. */
  startedAt: string;
  /** How many job types it runs. */
  jobs: number;
}

/** Set once by src/worker.ts after every queue is registered. */
let started: { at: string; jobs: number } | null = null;

export function markWorkerStarted(jobs: number, now = new Date()): void {
  started = { at: now.toISOString(), jobs };
}

/** Writes the heartbeat row. Two workers during a deploy both write it; the later beat wins, which is all the watch reads. */
export async function writeHeartbeat(now = new Date()): Promise<WorkerHeartbeat> {
  const value: WorkerHeartbeat = { at: now.toISOString(), startedAt: started?.at ?? now.toISOString(), jobs: started?.jobs ?? 0 };
  await db.insert(settings).values({ key: WORKER_HEARTBEAT_KEY, value, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  return value;
}

// The heartbeat's own job. Names start with "worker.".
export const jobs: AnyJobDef[] = [
  defineJob<Record<string, never>>({
    name: "worker.heartbeat",
    // Every HEARTBEAT_EVERY_MINUTES. A run that can't finish in a minute is late anyway, and the next
    // tick writes a newer beat, so there's no retry.
    cron: "*/2 * * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 60,
    handler: async () => writeHeartbeat(),
  }),
];
