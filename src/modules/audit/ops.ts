import { db } from "@/db";
import { auditCrawls } from "@/db/schema";
import { analyticsEnabled, track } from "@/lib/analytics/server";
import { auditJavascript, auditPageLimit, isInternal } from "@/lib/billing/gates";
import { SpendRefusedError } from "@/lib/billing/errors";
import { auditRefusal, loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { CRAWL_NOT_QUEUED, plainCrawlFailure } from "@/lib/dataforseo/failure-copy";
import { enqueue } from "@/lib/jobs/boss";
import { OpError, plural, refused, type Actor, type OpOptions } from "@/lib/ops";
import type { Project } from "@/lib/projects";
import { inScope, projectScope } from "@/lib/workspace";
import { activeCrawl, createCrawl, failUnqueuedCrawl, getSettings, MAX_PAGES_LIMIT, saveSettings } from "./crawl";
import { estimateCrawlCost } from "./transform";

/** Site audit changes shared by the Server Actions and the MCP server (see `src/lib/ops`). */

const ALREADY_RUNNING = "A crawl is already running for this project.";

export interface StartedCrawl {
  dryRun: boolean;
  /** Null on a dry run. */
  crawlId: number | null;
  maxPages: number;
  enableJavascript: boolean;
  estimateUsd: number | null;
  message: string;
}

/**
 * Crawls the project's site. Pages and JavaScript default to the project's saved audit settings,
 * and a run saves what it used as the new settings, as the form does. The plan caps pages per crawl.
 */
export async function startCrawlOp(
  project: Project,
  actor: Actor,
  input: { maxPages?: number; enableJavascript?: boolean },
  opts: OpOptions = {},
): Promise<StartedCrawl> {
  const scope = projectScope(project);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const refusal = (await projectActionRefusal(scope, { paid: true, onFree: true, quiet: opts.dryRun })) ?? (await auditRefusal(ws, scope.projectId));
  if (refusal) throw refused(refusal);
  if (await activeCrawl(scope)) throw new OpError(ALREADY_RUNNING);
  const saved = await getSettings(scope);
  const requested = input.maxPages ?? saved.maxPages;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PAGES_LIMIT) throw new OpError(`Max pages must be between 1 and ${MAX_PAGES_LIMIT}.`);
  const enableJavascript = auditJavascript(ws, input.enableJavascript ?? saved.enableJavascript);
  const maxPages = auditPageLimit(ws, requested);
  const crawl = { maxPages, enableJavascript, loadResources: true };
  const estimateUsd = isInternal(ws) ? estimateCrawlCost(crawl) : null;
  const capped = maxPages < requested ? ` (your plan's limit per audit)` : "";
  const what = `a crawl of up to ${plural(maxPages, "page")}${capped}${enableJavascript ? " with JavaScript" : ""}`;
  if (opts.dryRun) return { dryRun: true, crawlId: null, maxPages, enableJavascript, estimateUsd, message: `Would start ${what}.` };
  await saveSettings(scope, { maxPages: requested, enableJavascript, loadResources: true });
  let crawlId: number;
  try {
    crawlId = await createCrawl(project, crawl, "manual");
  } catch (err) {
    if (err instanceof SpendRefusedError) throw refused(err.refusal);
    // A concurrent submit won the race. createCrawl says so with this same text.
    if (err instanceof Error && err.message === ALREADY_RUNNING) throw new OpError(ALREADY_RUNNING);
    // Anything else (a database error, say) stays in the logs.
    console.error("[audit] crawl not created:", err);
    throw new OpError(plainCrawlFailure(null).message);
  }
  try {
    await enqueue("audit.start", { ...scope, crawlId });
  } catch (err) {
    // Nothing would ever pick the row up, and it would hold the project's one active crawl.
    console.error("[audit] crawl not queued:", err);
    try {
      await failUnqueuedCrawl(scope, crawlId);
    } catch (e) {
      console.error(`[audit] crawl ${crawlId} left open:`, e);
    }
    throw new OpError(plainCrawlFailure(CRAWL_NOT_QUEUED).message);
  }
  // Kick the poller so progress shows up without waiting for the next cron tick. The crawl is
  // already queued, and that tick picks it up if this fails.
  try {
    await enqueue("audit.poll", {}, { startAfter: 30 });
  } catch (err) {
    console.error("[audit] poll not queued:", err);
  }
  // The project's first crawl: the audit was just set up.
  if (analyticsEnabled() && (await db.$count(auditCrawls, inScope(auditCrawls, scope))) === 1) {
    track(actor.userId, "module_activated", { module: "audit", project_id: scope.projectId, max_pages: maxPages }, { workspaceId: scope.workspaceId });
  }
  return { dryRun: false, crawlId, maxPages, enableJavascript, estimateUsd, message: `Started ${what}. Progress shows on the Site audit page.` };
}
