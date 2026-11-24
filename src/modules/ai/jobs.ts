import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { onResearchMeter } from "@/lib/billing/context";
import { BudgetExceededError } from "@/lib/dataforseo/client";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { closeRefusedRun, closeStaleQueuedRuns, executeRun, pollRun, projectsWithPrompts, runningRuns, startRun } from "./run";

/** Retries of one ai.run job. A retry resumes the same run, so it asks only what's still pending. */
const RUN_RETRY_LIMIT = 1;

// Background jobs for the ai module. Names must start with "ai.".
export const jobs: AnyJobDef[] = [
  /**
   * Weekly (Monday 07:00): one run per project with active prompts. The cron run has no project
   * and fans out one ai.run per project; "Run now" sends { workspaceId, projectId, runId }, and
   * that run's calls use research credits.
   * Asks every platform live, posts AI Overview SERP checks, refreshes LLM Mentions. Live answers
   * take a while each, so a large run (100 prompts on 4 platforms) gets an hour.
   */
  defineJob<ProjectJobPayload & { runId?: number }>({
    name: "ai.run",
    cron: "0 7 * * 1",
    cronData: {},
    expireInSeconds: 60 * 60,
    retryLimit: RUN_RETRY_LIMIT,
    handler: async (payload, job) => {
      if (payload.projectId === undefined) {
        const targets = await projectsWithPrompts();
        for (const s of targets) await enqueue("ai.run", s, { singletonKey: `ai.run:${s.projectId}` });
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) {
        await closeRefusedRun(payload, scoped.refusal?.message ?? POSTING_NEVER_FINISHED);
        return { skipped: scoped.reason };
      }
      // On the last attempt a throw closes the run on what came back; before it, the retry resumes it.
      const final = (job?.retryCount ?? RUN_RETRY_LIMIT) >= RUN_RETRY_LIMIT;
      // A run with an id is one started by hand: it spends research credits, not the plan.
      if (payload.runId) return onResearchMeter(() => executeRun(scoped.scope, payload.runId!, { final }));
      try {
        // A weekly retry finds the run its first attempt started (still running) and resumes it.
        const id = await startRun(scoped.scope, "cron");
        if (id) await executeRun(scoped.scope, id, { final });
      } catch (err) {
        // A run that would pass the workspace's cap is skipped; other projects still run.
        if (!(err instanceof BudgetExceededError)) throw err;
        console.warn(`[ai] weekly run for project ${scoped.scope.projectId} skipped: ${err.message}`);
        return { skipped: err.message };
      }
    },
  }),
  /**
   * Polls a run's Standard tasks (free task_get calls) every 30 s until it is done: AI Overview
   * checks, and answers from runs posted before the platforms moved to Live.
   * The cron payload { } sweeps every running run, in case a poll chain broke; each run's own
   * workspace is used. A run's own poll job carries its scope and only polls that run.
   */
  defineJob<ProjectJobPayload & { runId?: number }>({
    name: "ai.poll",
    cron: "*/15 * * * *",
    cronData: {},
    policy: "stately",
    handler: async (payload) => {
      if (!payload.runId) {
        await closeStaleQueuedRuns();
        for (const id of await runningRuns()) await pollRun(id);
        return;
      }
      const scoped = await jobScope(payload, { allowArchived: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      const state = await pollRun(payload.runId, scoped.scope);
      if (state === "pending") {
        await enqueue("ai.poll", { ...scoped.scope, runId: payload.runId }, { startAfter: 30, singletonKey: `poll-${payload.runId}` });
      }
    },
  }),
];
