import { purgeAuthRows } from "@/lib/auth/retention";
import { purgeUnconfirmedSignups } from "@/lib/signup";
import { checkDataForSEOBalance } from "@/lib/dataforseo/balance";
import { purgeExpiredClaims } from "@/lib/dataforseo/claims";
import { purgeExpiredCache } from "@/lib/dataforseo/retention";
import { enqueue } from "@/lib/jobs/boss";
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { purgeOldInspections } from "@/modules/google/retention";
import { purgeFinishedTasks } from "@/modules/rank/retention";
import { sendPlatformCapAlert, sendSpendAlerts } from "./alerts";
import { resumeLapsedPauses } from "./jobs-gate";
import { releaseStaleReservations } from "./usage";

/** Runs one step of the daily job, logging a failure instead of throwing, so a retry doesn't send the spend alert twice. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T | { failed: string }> {
  try {
    return await run();
  } catch (err) {
    console.error(`[billing.alerts] ${name} failed:`, err instanceof Error ? err.message : err);
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

// Background jobs for billing. Names start with "billing.".
export const jobs: AnyJobDef[] = [
  defineJob<Record<string, never>>({
    name: "billing.alerts",
    // Daily at 08:00 local: reservations a crashed call never settled, the platform cap alert, the
    // DataForSEO balance alert, paused jobs whose monthly limit or platform cap has room again (on the
    // 1st, say), lookup claims a crashed call left behind, Better Auth's expired sessions and old rate
    // limit counters (both hold raw IP addresses), expired DataForSEO responses and who paid for them,
    // finished rank runs' tasks, URL inspections past each project's newest 200, and the owner's spend
    // alert. The free tools' own purge is `tools.purge`, a cloud job.
    cron: "0 8 * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 1,
    handler: async () => {
      const released = await releaseStaleReservations();
      const platform = await step("platform cap alert", () => sendPlatformCapAlert());
      const balance = await step("DataForSEO balance check", () => checkDataForSEOBalance());
      const resumed = await step("resuming paused jobs", () => resumeLapsedPauses(enqueue));
      const claims = await step("purging lapsed lookup claims", () => purgeExpiredClaims());
      const auth = await step("purging expired sessions and rate limits", () => purgeAuthRows());
      const unconfirmed = await step("purging unconfirmed sign-ups", () => purgeUnconfirmedSignups());
      const lookups = await step("purging expired lookups", () => purgeExpiredCache());
      const rankTasks = await step("purging finished rank tasks", () => purgeFinishedTasks());
      const inspections = await step("purging old URL inspections", () => purgeOldInspections());
      const sent = await sendSpendAlerts();
      return { ...sent, released, platform, balance, resumed, claims, auth, unconfirmed, lookups, rankTasks, inspections };
    },
  }),
];
