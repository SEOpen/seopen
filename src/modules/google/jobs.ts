import { isNotNull } from "drizzle-orm";
import { projects } from "@/db/schema";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, jobScope, type ProjectJobPayload, type ProjectScope } from "@/lib/workspace";
import { GoogleAccessError } from "./auth";
import { GoogleNotConnectedError } from "./types";
import { syncGa4, syncGsc, type SyncResult } from "./sync";

/** Re-queue a project's sync: soon while backfilling, later after a quota error. */
async function follow(name: string, scope: ProjectScope, r: SyncResult) {
  if (!r.more) return;
  await enqueue(name, scope, { singletonKey: `project:${scope.projectId}`, startAfter: r.retryAfterSeconds ?? 30 });
}

/** The daily cron run has no projectId: it fans out one job per mapped project, each with its workspace. */
function syncJob(name: string, column: typeof projects.gscProperty | typeof projects.ga4Property, run: (scope: ProjectScope) => Promise<SyncResult>, cron: string) {
  return defineJob<ProjectJobPayload>({
    name,
    cron,
    cronData: {},
    policy: "stately",
    retryLimit: 2,
    retryDelay: 300,
    expireInSeconds: 60 * 60,
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await activeProjects(isNotNull(column));
        for (const s of targets) await enqueue(name, s, { singletonKey: `project:${s.projectId}` });
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload);
      if (!scoped.ok) return { skipped: scoped.reason };
      try {
        const r = await run(scoped.scope);
        await follow(name, scoped.scope, r);
        return r;
      } catch (err) {
        // No account, a revoked token or a property it can't reach: retrying can't help until the user acts.
        if (err instanceof GoogleNotConnectedError || err instanceof GoogleAccessError) return { skipped: err.message };
        throw err;
      }
    },
  });
}

// Background jobs for the google module. Names must start with "google.".
export const jobs: AnyJobDef[] = [
  syncJob("google.gsc.sync", projects.gscProperty, (s) => syncGsc(s), "0 7 * * *"),
  syncJob("google.ga4.sync", projects.ga4Property, (s) => syncGa4(s), "20 7 * * *"),
];
