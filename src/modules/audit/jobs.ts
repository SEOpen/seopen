import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { expireStaleLighthouse, pollActiveCrawls, projectsWithWeeklyCrawl, runLighthouse, startCrawl, startScheduledCrawl } from "./crawl";

/**
 * audit.poll's second look, while a crawl is running. Cron fires at most once a minute, so a run that
 * finds a crawl still going waits this long and polls again, which takes a running crawl to the 30 s
 * end of the 30–60 s that docs/dataforseo.md gives for polling on_page/summary. Those polls and the
 * import are free calls, so this spends nothing; it is at most two summary calls a minute per crawl,
 * one at a time, far inside the account's limits. A minute with nothing running looks once.
 */
export const SECOND_POLL_MS = 30_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Background jobs for the audit module. Names must start with "audit.".
export const jobs: AnyJobDef[] = [
  defineJob<ProjectJobPayload & { crawlId: number }>({
    name: "audit.start",
    // Posting costs money, so don't retry blindly; postCrawl is a no-op once the task id is stored.
    retryLimit: 1,
    handler: async (payload) => startCrawl(await jobScope(payload, { paid: true }), payload),
  }),
  defineJob<Record<string, never>>({
    name: "audit.poll",
    // Every minute, and again 30 s later while a crawl runs (SECOND_POLL_MS): checks running crawls
    // (free) and imports finished ones before they expire. Global: each crawl row carries its own workspace.
    cron: "* * * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 0,
    expireInSeconds: 30 * 60,
    handler: async () => {
      const running = await pollActiveCrawls();
      await expireStaleLighthouse();
      if (running > 0) {
        await wait(SECOND_POLL_MS);
        await pollActiveCrawls();
      }
    },
  }),
  defineJob<ProjectJobPayload>({
    name: "audit.schedule",
    // Mondays 05:30 local time, for projects with the weekly re-crawl turned on. The cron run has
    // no project and fans out one job per opted-in project.
    cron: "30 5 * * 1",
    cronData: {},
    policy: "singleton",
    retryLimit: 0,
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await projectsWithWeeklyCrawl();
        for (const s of targets) await enqueue("audit.schedule", s, { singletonKey: `audit.schedule:${s.projectId}` });
        return { fannedOut: targets.length };
      }
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      return { crawlId: await startScheduledCrawl(scoped.project) };
    },
  }),
  defineJob<ProjectJobPayload & { lighthouseId: number }>({
    name: "audit.lighthouse",
    retryLimit: 0,
    expireInSeconds: 5 * 60,
    handler: async (payload) => {
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      await runLighthouse(scoped.scope, payload.lighthouseId);
    },
  }),
];
