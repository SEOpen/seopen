/**
 * Background worker: runs every module's jobs and cron schedules.
 * Start with `pnpm worker` (loads .env.local), or `pnpm worker:start` where the host supplies
 * the env (a .env.local is read too, if there is one; the host's own values win). The web app only enqueues jobs.
 */
import { PgBoss } from "pg-boss";
import { migrateOnce } from "@/db/migrate";
import { dbSsl } from "@/db/ssl";
import { sourceOf, withBillingContext } from "@/lib/billing/context";
import { SpendRefusedError } from "@/lib/billing/errors";
import { loadJobs } from "@/lib/jobs/registry";
import { markWorkerStarted, writeHeartbeat } from "@/lib/jobs/heartbeat";
import { SCHEDULE_TIME_ZONE } from "@/lib/schedule";

async function main() {
  // In production the worker owns schema changes: each deploy applies new drizzle/ migrations first.
  if (process.env.MIGRATE_ON_START === "1") {
    await migrateOnce();
    console.log("[worker] migrations applied");
  }

  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, ssl: dbSsl(), max: 5, schema: "pgboss" });
  boss.on("error", (err) => console.error("[worker] pg-boss error", err));
  await boss.start();

  const allJobs = await loadJobs();
  const names = new Set<string>();
  for (const def of allJobs) {
    if (names.has(def.name)) throw new Error(`Duplicate job name ${def.name}`);
    names.add(def.name);

    const queueOptions = {
      retryLimit: def.retryLimit ?? 2,
      retryDelay: def.retryDelay ?? 60,
      expireInSeconds: def.expireInSeconds ?? 15 * 60,
    };
    // Policy is fixed at creation; changing a job's policy means deleting its queue.
    if (await boss.getQueue(def.name)) await boss.updateQueue(def.name, queueOptions);
    else await boss.createQueue(def.name, { ...queueOptions, policy: def.policy ?? "standard" });

    await boss.work(def.name, { localConcurrency: def.concurrency ?? 1 }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          // The job's name and payload travel with its paid calls, so a refused call pauses this job,
          // and work an AI agent started is recorded as theirs.
          await withBillingContext({ job: { name: def.name, data: job.data }, source: sourceOf(job.data) }, () => def.handler(job.data, job));
          console.log(`[worker] ${def.name} ${job.id} done in ${Date.now() - started}ms`);
        } catch (err) {
          // A billing refusal is a pause (the client recorded it), not a failure: a retry can't help.
          if (err instanceof SpendRefusedError) {
            console.log(`[worker] ${def.name} ${job.id} paused: ${err.code}`);
            continue;
          }
          console.error(`[worker] ${def.name} ${job.id} failed`, err);
          throw err;
        }
      }
    });

    if (def.cron) await boss.schedule(def.name, def.cron, def.cronData ?? {}, { tz: SCHEDULE_TIME_ZONE });
    else await boss.unschedule(def.name).catch(() => {});
  }

  console.log(`[worker] running ${allJobs.length} job types: ${[...names].join(", ") || "(none yet)"}`);
  // The first beat, so a deploy shows as running at once; `worker.heartbeat` writes the rest. A failed
  // write isn't fatal: the cron's beats prove the worker is up better than this one does.
  markWorkerStarted(allJobs.length);
  await writeHeartbeat().catch((err) => console.error("[worker] first heartbeat not written", err));

  const shutdown = async () => {
    console.log("[worker] stopping");
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
