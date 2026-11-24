import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnyJobDef } from "./types";
import { jobs as ai } from "@/modules/ai/jobs";
import { jobs as alerts } from "@/modules/alerts/jobs";
import { jobs as audit } from "@/modules/audit/jobs";
import { jobs as backlinks } from "@/modules/backlinks/jobs";
import { jobs as domains } from "@/modules/domains/jobs";
import { jobs as fixes } from "@/modules/fixes/jobs";
import { jobs as google } from "@/modules/google/jobs";
import { jobs as indexing } from "@/modules/indexing/jobs";
import { jobs as plausible } from "@/modules/plausible/jobs";
import { jobs as posthog } from "@/modules/posthog/jobs";
import { jobs as umami } from "@/modules/umami/jobs";
import { jobs as keywords } from "@/modules/keywords/jobs";
import { jobs as local } from "@/modules/local/jobs";
import { jobs as rank } from "@/modules/rank/jobs";
import { jobs as billing } from "@/lib/billing/jobs";
import { jobs as mcp } from "@/lib/mcp/jobs";
import { jobs as worker } from "./heartbeat";
import { jobs as recap } from "@/lib/recap/jobs";

/** Every core module's jobs. */
export const coreJobs: AnyJobDef[] = [...domains, ...keywords, ...rank, ...audit, ...fixes, ...backlinks, ...google, ...indexing, ...posthog, ...plausible, ...umami, ...ai, ...local, ...billing, ...mcp, ...recap, ...alerts, ...worker];

/**
 * Jobs from outside core: a copy with `extra.ts` next to this file adds the job sets it exports as
 * `jobs`. Without the file the worker runs core's jobs alone. It's found by path, not imported, so
 * core typechecks without it.
 */
const EXTRA = new URL("./extra.ts", import.meta.url);

/** Core's jobs and any extra ones: what the worker runs. */
export async function loadJobs(): Promise<AnyJobDef[]> {
  if (!existsSync(fileURLToPath(EXTRA))) return coreJobs;
  const extra = (await import(EXTRA.href)) as { jobs: AnyJobDef[] };
  return [...coreJobs, ...extra.jobs];
}
