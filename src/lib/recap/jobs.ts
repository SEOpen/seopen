import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { RECAP_AT } from "./gate";
import { sendWeeklyRecaps } from "./send";

const [hour, minute] = RECAP_AT.split(":").map(Number);

// The weekly recap email. Names start with "recap.".
export const jobs: AnyJobDef[] = [
  defineJob<Record<string, never>>({
    name: "recap.weekly",
    // Mondays at RECAP_AT, 10:00 local (15:00 UTC in winter, 14:00 in summer): after Monday's site audits
    // (05:30), rank checks (06:00), Search Console sync (07:00) and AI visibility run (07:00) have
    // had time to finish. A retry sends only what didn't go out: every send is claimed.
    cron: `${minute} ${hour} * * 1`,
    cronData: {},
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 600,
    expireInSeconds: 30 * 60,
    handler: async () => sendWeeklyRecaps(),
  }),
];
