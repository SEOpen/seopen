import { onPlanMeter } from "@/lib/billing/context";
import { BudgetExceededError, DataForSEOError, LookupInFlightError } from "@/lib/dataforseo/client";
import { isPaymentRequired } from "@/lib/dataforseo/balance";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { activeProjects, jobScope, type ProjectJobPayload } from "@/lib/workspace";
import { getSummary } from "./api";

/**
 * Retries of one project's weekly snapshot. pg-boss waits retryDelay * (1 to 2) * 2^n
 * seconds before retry n+1, so the three retries start 30 to 60 minutes, then 1 to 2 hours, then 2 to
 * 4 hours after the try before them: all of them within about 7 hours of the first, and the jitter
 * spreads a week's projects out instead of retrying them together.
 *
 * A retry doesn't re-pay. The snapshot is one paid call, backlinks/summary/live (about $0.024), and a
 * successful answer is saved to this workspace's cache for 24 hours before anything else happens, so a
 * retry after it (the snapshot's own write failed) reads the saved answer for free and files it. A
 * failed call isn't charged or saved. The worst case is a successful call whose cache write and
 * snapshot write both failed: each retry then pays for the call again, at most 3 × $0.024 ≈ $0.07.
 */
export const SNAPSHOT_RETRY = { retryLimit: 3, retryDelay: 30 * 60, retryBackoff: true, retryDelayMax: 4 * 60 * 60 } as const;

/**
 * Whether a failed snapshot is worth another try in an hour: DataForSEO out of balance (402, 40200,
 * 40210), rate limits, its own server errors and timeouts (HTTP 5xx, task codes 5xxxx such as 50401),
 * another call still fetching the same lookup, and anything that isn't a DataForSEO answer (a network
 * error, a timeout, the database). A request DataForSEO refused (an invalid target, 40501) fails the
 * same way next time, and so does the workspace's cap, which a retry would only hit again.
 */
export function retryable(err: unknown): boolean {
  if (err instanceof BudgetExceededError) return false;
  if (err instanceof LookupInFlightError) return true;
  if (!(err instanceof DataForSEOError)) return true;
  const code = err.statusCode;
  return isPaymentRequired(code) || code === 429 || (code >= 500 && code < 600) || code >= 50000;
}

// Background jobs for the backlinks module. Names must start with "backlinks.".
export const jobs: AnyJobDef[] = [
  defineJob<ProjectJobPayload>({
    name: "backlinks.snapshot",
    // Mondays 07:30 local. One summary call per project (≈ $0.024, or free within the 24 h cache).
    // The cron run has no project: it fans out one job per project, each charged to its workspace.
    cron: "30 7 * * 1",
    cronData: {},
    policy: "singleton",
    // The fan-out runs once. Each project's own job is sent with SNAPSHOT_RETRY, so a failed call
    // retries that project only.
    retryLimit: 0,
    handler: async (payload) => {
      if (payload.projectId === undefined) {
        const targets = await activeProjects();
        for (const s of targets) await enqueue("backlinks.snapshot", s, { singletonKey: `backlinks.snapshot:${s.projectId}`, ...SNAPSHOT_RETRY });
        return { fannedOut: targets.length };
      }
      // Every attempt, retries included, passes the billing check first: a paused or capped workspace
      // stops here, and the client reserves against the cap again on the call itself.
      const scoped = await jobScope(payload, { paid: true });
      if (!scoped.ok) return { skipped: scoped.reason };
      try {
        // getSummary files the snapshot for every project of the workspace with this domain, so reruns are idempotent.
        // Covered by the plan, not research credits.
        await onPlanMeter(() => getSummary(scoped.project.domain, scoped.scope));
      } catch (err) {
        // A billing refusal goes to the worker, which records it as a pause. The platform cap fails the
        // job so Admin → Health shows it; its retries spend nothing and file the snapshot if the cap is
        // raised in time. Any other failure a retry can't fix ends the job here, so pg-boss doesn't
        // retry it; the ledger keeps the failed call.
        if (err instanceof BudgetExceededError || retryable(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[backlinks] snapshot for project ${scoped.scope.projectId} failed, not retrying: ${message}`);
        return { failed: message };
      }
    },
  }),
];
