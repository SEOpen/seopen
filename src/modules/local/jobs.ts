import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { closeRefusedCheck, pollOnce, postCheck, projectsToCheck, scheduleProject } from "./tracker";

// Background jobs for the local module. Names must start with "local.".
export const jobs: AnyJobDef[] = [
  // Daily at 06:30 local: each scheduled business whose last check is a week old gets a new one.
  // The cron run has no project and fans out one local.schedule per project.
  defineJob<ProjectJobPayload>({
    name: "local.schedule",
    cron: "30 6 * * *",
    cronData: {},
    policy: "singleton",
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await projectsToCheck();
        for (const s of targets) await enqueue("local.schedule", s, { singletonKey: `local.schedule:${s.projectId}` });
        console.log(`[local.schedule] fanned out ${targets.length} project(s)`);
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      const checks = await scheduleProject(scoped.scope);
      for (const c of checks) await enqueue("local.check", { ...scoped.scope, checkId: c.id });
      return { checks: checks.map((c) => c.id) };
    },
  }),

  // Posts the tasks of one check (scheduled or "Check now").
  defineJob<ProjectJobPayload & { checkId: number }>({
    name: "local.check",
    retryLimit: 2,
    handler: async (payload) => {
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) {
        await closeRefusedCheck(payload, scoped.refusal?.message ?? POSTING_NEVER_FINISHED);
        return { skipped: scoped.reason };
      }
      await postCheck(scoped.scope, payload.checkId);
    },
  }),

  // Every 2 minutes: tasks_ready + task_get (both free). Global, like rank.poll.
  defineJob<Record<string, never>>({
    name: "local.poll",
    cron: "*/2 * * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 5 * 60,
    handler: async () => {
      const s = await pollOnce();
      if (s.pending) console.log(`[local.poll] pending ${s.pending}, fetched ${s.fetched}, stored ${s.stored}, failed ${s.failed}`);
    },
  }),
];
