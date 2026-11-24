import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { deliverDue } from "./deliver";

// Alert emails. Names start with "alerts.". Finding alerts needs no job: it runs where the data
// arrives, when a crawl is imported and when a rank check closes.
export const jobs: AnyJobDef[] = [
  defineJob<Record<string, never>>({
    name: "alerts.deliver",
    // Hourly: retries emails that didn't all go out and urgent ones a crawl couldn't send, and from
    // ALERTS_DAILY_AT (12:00) sends each project's daily email. Every send is claimed, so a retry never sends twice.
    cron: "20 * * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 300,
    expireInSeconds: 15 * 60,
    handler: async () => deliverDue(),
  }),
];
