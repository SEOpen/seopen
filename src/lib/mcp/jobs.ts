import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { purgeUnusedOAuthClients } from "@/lib/auth/retention";
import { pruneLimitCounters } from "./limits";

// Background jobs for the MCP server. Names start with "mcp.".
export const jobs: AnyJobDef[] = [
  defineJob<Record<string, never>>({
    name: "mcp.prune",
    // Daily at 04:15 local: rate limit counters older than a day, and apps registered over 90 days ago
    // with no consent. A purge that meets a consent being saved fails and is retried.
    cron: "15 4 * * *",
    cronData: {},
    policy: "singleton",
    retryLimit: 1,
    handler: async () => ({ pruned: await pruneLimitCounters(), apps: await purgeUnusedOAuthClients() }),
  }),
];
