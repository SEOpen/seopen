import { isNotNull } from "drizzle-orm";
import { projects } from "@/db/schema";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { syncPosthog } from "./sync";
import { PosthogAccessError, PosthogNotConnectedError } from "./types";

export const SYNC_JOB = "posthog.sync";

/** Daily, after the Google syncs. The cron run fans out one job per project mapped to PostHog. */
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
      const targets = await activeProjects(isNotNull(projects.posthogProject));
      for (const s of targets) await enqueue(SYNC_JOB, s, { singletonKey: `project:${s.projectId}` });
      return { fannedOut: targets.length };
    }
    const scoped = await jobScope(payload);
    if (!scoped.ok) return { skipped: scoped.reason };
    try {
      const r = await syncPosthog(scoped.scope);
      // Re-queue soon while backfilling, later after a rate limit.
      if (r.more) await enqueue(SYNC_JOB, scoped.scope, { singletonKey: `project:${scoped.scope.projectId}`, startAfter: r.retryAfterSeconds ?? 30 });
      return r;
    } catch (err) {
      // No connection, a revoked token or a project it can't reach: retrying can't help until the user reconnects.
      if (err instanceof PosthogNotConnectedError || err instanceof PosthogAccessError) return { skipped: err.message };
      throw err;
    }
  },
});

// Background jobs for the posthog module. Names must start with "posthog.".
export const jobs: AnyJobDef[] = [sync];
