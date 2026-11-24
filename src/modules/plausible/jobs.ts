import { isNotNull } from "drizzle-orm";
import { projects } from "@/db/schema";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { syncPlausible } from "./sync";
import { PlausibleAccessError, PlausibleNotConnectedError } from "./types";

export const SYNC_JOB = "plausible.sync";

/** Daily, on PostHog's schedule. The cron run fans out one job per project mapped to Plausible. */
const sync = defineJob<ProjectJobPayload>({
  name: SYNC_JOB,
  cron: "40 7 * * *",
  cronData: {},
  policy: "stately",
  retryLimit: 2,
  retryDelay: 300,
  expireInSeconds: 60 * 60,
  handler: async (payload) => {
    if (payload.projectId === undefined) {
      const targets = await activeProjects(isNotNull(projects.plausibleSite));
      for (const s of targets) await enqueue(SYNC_JOB, s, { singletonKey: `project:${s.projectId}` });
      return { fannedOut: targets.length };
    }
    const scoped = await jobScope(payload);
    if (!scoped.ok) return { skipped: scoped.reason };
    try {
      const r = await syncPlausible(scoped.scope);
      // Re-queue soon while backfilling, later after a rate limit.
      if (r.more) await enqueue(SYNC_JOB, scoped.scope, { singletonKey: `project:${scoped.scope.projectId}`, startAfter: r.retryAfterSeconds ?? 30 });
      return r;
    } catch (err) {
      // No connection, a refused key or a site it can't reach: retrying can't help until the customer changes something.
      if (err instanceof PlausibleNotConnectedError || err instanceof PlausibleAccessError) return { skipped: err.message };
      throw err;
    }
  },
});

// Background jobs for the plausible module. Names must start with "plausible.".
export const jobs: AnyJobDef[] = [sync];
