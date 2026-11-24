import { PgBoss, type SendOptions } from "pg-boss";
import { dbSsl } from "@/db/ssl";
import { billingContext } from "@/lib/billing/context";

declare global {
  var __seopenBoss: Promise<PgBoss> | undefined;
}

async function startSender(): Promise<PgBoss> {
  // Senders don't supervise, run cron or migrate pg-boss's schema; the worker process does all three.
  // They also keep pg-boss's timers quiet. A serverless host freezes a function between requests, and a timer's
  // connection caught by a freeze of over 10 seconds fails on thaw, so nothing that only
  // sends should keep reconnecting: no instance registry heartbeat, and a queue list refreshed hourly.
  // pg-boss re-reads a queue itself when an insert finds its cached copy is out of date.
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    ssl: dbSsl(),
    max: 2,
    schema: "pgboss",
    supervise: false,
    schedule: false,
    migrate: false,
    registerInstance: false,
    queueCacheIntervalSeconds: 3600,
  });
  boss.on("error", (err) => console.error("[pg-boss]", err));
  try {
    await boss.start();
  } catch (err) {
    // A partial start leaves timers and a pool behind. Nothing else holds this object to stop them.
    await boss.stop({ graceful: false }).catch(() => {});
    throw err;
  }
  return boss;
}

/** Started pg-boss client for sending jobs. The worker process runs handlers; see src/worker.ts. */
export function getBoss(): Promise<PgBoss> {
  // A failed start isn't kept: one bad connection must not fail every later enqueue in this process.
  globalThis.__seopenBoss ??= startSender().catch((err) => {
    globalThis.__seopenBoss = undefined;
    throw err;
  });
  return globalThis.__seopenBoss;
}

/**
 * Queue a job by name, e.g. enqueue("audit.start", { projectId }). Returns the job id. Work an AI
 * agent started (`source` in the billing context) stays marked as such: the payload carries it, and
 * the worker restores it, so the job's paid calls land in the ledger as "mcp". Retry options set
 * here override the queue's for this one job.
 */
export async function enqueue<T extends object>(
  name: string,
  data: T,
  options?: { startAfter?: Date | number; singletonKey?: string; priority?: number } & Pick<SendOptions, "retryLimit" | "retryDelay" | "retryBackoff" | "retryDelayMax">,
): Promise<string | null> {
  const boss = await getBoss();
  const { source } = billingContext();
  return boss.send(name, source ? { ...data, source } : data, options);
}
