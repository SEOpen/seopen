import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { closeRefusedRun, fetchVolumes, pollOnce, postRun, projectsToCheck, scheduleProject } from "./tracker";

// Background jobs for the rank module. Names must start with "rank.".
export const jobs: AnyJobDef[] = [
  // Daily at 06:00 local: one Standard-queue task per active keyword. On each
  // project's sweep weekday this becomes the depth-100 sweep with AI Overviews.
  // The cron run has no project: it fans out one rank.schedule per project, so one slow
  // workspace can't hold up the others and a project can't be scheduled twice.
  defineJob<ProjectJobPayload>({
    name: "rank.schedule",
    cron: "0 6 * * *",
    cronData: {},
    policy: "singleton",
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await projectsToCheck();
        for (const s of targets) await enqueue("rank.schedule", s, { singletonKey: `rank.schedule:${s.projectId}` });
        console.log(`[rank.schedule] fanned out ${targets.length} project(s)`);
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      const run = await scheduleProject(scoped.scope);
      if (!run) return { skipped: "no check due" };
      await enqueue("rank.check", { ...scoped.scope, runId: run.id });
      // Refreshes volumes older than 30 days; a no-op (no API call) when all are fresh.
      await enqueue("rank.volumes", scoped.scope, { singletonKey: `rank.volumes:${scoped.scope.projectId}` });
      return { runId: run.id };
    },
  }),

  // Posts the tasks of one run (scheduled or "Check now").
  defineJob<ProjectJobPayload & { runId: number }>({
    name: "rank.check",
    retryLimit: 2,
    handler: async (payload) => {
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) {
        await closeRefusedRun(payload, scoped.refusal?.message ?? POSTING_NEVER_FINISHED);
        return { skipped: scoped.reason };
      }
      await postRun(scoped.scope, payload.runId);
    },
  }),

  // Every 2 minutes: tasks_ready + task_get (both free). One tasks_ready call per pass keeps us far below 20/min.
  // Global: tasks_ready lists every task on the DataForSEO account, and each task's run says whose it is.
  defineJob<Record<string, never>>({
    name: "rank.poll",
    cron: "*/2 * * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 5 * 60,
    handler: async () => {
      const s = await pollOnce();
      if (s.pending) console.log(`[rank.poll] pending ${s.pending}, fetched ${s.fetched}, stored ${s.stored}, failed ${s.failed}`);
    },
  }),

  // Search volume for new keywords (Labs keyword_overview, cached 30 days).
  defineJob<ProjectJobPayload>({
    name: "rank.volumes",
    handler: async (payload) => {
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      const n = await fetchVolumes(scoped.scope);
      if (n) console.log(`[rank.volumes] project ${scoped.scope.projectId}: ${n} keyword(s)`);
    },
  }),
];
