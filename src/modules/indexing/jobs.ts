import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, jobScope, type ProjectJobPayload, type ProjectScope } from "@/lib/workspace";
import { syncIndexing } from "./sync";

export const INDEXING_SYNC = "indexing.sync";

/** Queues one project's run now: the Indexing tab's Check now button and turning IndexNow on. */
export async function queueIndexingSync(scope: ProjectScope) {
  await enqueue(INDEXING_SYNC, scope, { singletonKey: `project:${scope.projectId}` });
}

// Background jobs for the indexing module. Names must start with "indexing.".
export const jobs: AnyJobDef[] = [
  defineJob<ProjectJobPayload>({
    name: INDEXING_SYNC,
    // Every four hours: IndexNow hears about a change within hours, and inspections spread over the day.
    cron: "15 */4 * * *",
    cronData: {},
    policy: "stately",
    retryLimit: 1,
    retryDelay: 600,
    expireInSeconds: 60 * 60,
    handler: async (payload) => {
      // The cron run fans out to every live project, on every plan: it's all free to run.
      if (payload.projectId === undefined) {
        const targets = await activeProjects();
        for (const s of targets) await enqueue(INDEXING_SYNC, s, { singletonKey: `project:${s.projectId}` });
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload);
      if (!scoped.ok) return { skipped: scoped.reason };
      return syncIndexing(scoped.scope, scoped.project);
    },
  }),
];
