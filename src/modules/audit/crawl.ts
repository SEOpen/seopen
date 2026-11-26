import { createHash } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  apiLedger,
  auditCrawls,
  auditDuplicates,
  auditIssues,
  auditLighthouse,
  auditLinks,
  auditNonIndexable,
  auditPages,
  auditResources,
  auditSettings,
  projects,
} from "@/db/schema";
import { withBillingContext } from "@/lib/billing/context";
import { auditJavascript, auditPageLimit } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { BudgetExceededError, DataForSEOError, dfsGet, dfsPost, recordLedgerAdjustment, TTL, type DfsResponse } from "@/lib/dataforseo/client";
import { CRAWL_CANCELLED, CRAWL_NOT_QUEUED, CRAWL_NOT_SAVED, CRAWL_NOT_STARTED, storedFailure } from "@/lib/dataforseo/failure-copy";
import type { Project } from "@/lib/projects";
import { syncAuditFixes } from "@/modules/fixes/sync";
import { safeFetch } from "@/lib/web/fetch";
import { contentWordCount } from "@/lib/web/html";
import { activeProjects, jobScope, projectScope, type JobScope, type ProjectJobPayload, type ProjectScope } from "@/lib/workspace";
import { alertsAfterCrawl } from "@/modules/alerts/after";
import { checkAccess } from "./access";
import { detectIssues, THIN_CONTENT_WORDS, type ContentMatch } from "./issues";
import { imageAltCounts, type ImagesWithoutAlt } from "./image-alt";
import { hasDuplicateTitleOrDescription } from "./meta-tags";
import { healthScore } from "./score";
import {
  acceptLanguage,
  crawlFailureReason,
  crawlTaskBody,
  estimateCrawlCost,
  lighthouseScores,
  pageRow,
  summarySubset,
  toCrawledLink,
  toCrawledPage,
  toContentMatch,
  toCrawledResource,
  toDuplicateGroups,
  toSiteInfo,
} from "./transform";
import type { DfsContentMatches, DfsDuplicateGroup, DfsItems, DfsLighthouse, DfsLink, DfsNonIndexable, DfsPage, DfsResource, DfsSummary } from "./types";

/** Keep in sync with the partial unique index on audit_crawls (one active crawl per project). */
export const ACTIVE_STATUSES = ["queued", "posting", "crawling", "importing"] as const;
export const MAX_PAGES_LIMIT = 5000;
/** A crawl still running after this long is given up on. */
const STALE_AFTER_MS = 12 * 3600_000;
/** A claimed post that never recorded a task id is checked against DataForSEO after this long. */
const POSTING_TIMEOUT_MS = 10 * 60_000;
const PAGE_SIZE = 1000;
/** Upper bound on pages fetched per list endpoint during import. */
const MAX_IMPORT_ROWS = 20_000;
/** Flagged pages to look up a closest match for. One call each, so a site of near-copies can't hold up the import. */
const MAX_CONTENT_MATCHES = 500;
/** DataForSEO allows 30 simultaneous requests per account, and other jobs are running too. */
const CONTENT_MATCH_BATCH = 10;
/**
 * Flagged pages the import fetches to confirm DataForSEO's checks. Past this they keep their flags.
 * Pages flagged for duplicate meta tags go first, then alt, then pages that read as thin, so later kinds never crowd out earlier ones.
 */
const MAX_PAGE_CONFIRMS = 200;
/** Pages fetched at once: these are the customer's own pages. */
const PAGE_CONFIRM_BATCH = 5;
const PAGE_CONFIRM_TIMEOUT_MS = 8000;
/** No new batch of confirmation fetches starts after this, so a slow site can't stall the import. The rest keep their flags. */
const PAGE_CONFIRM_BUDGET_MS = 120_000;

export type AuditSettings = typeof auditSettings.$inferSelect;
export type AuditCrawl = typeof auditCrawls.$inferSelect;

const COUNTRY_ISO: Record<number, string> = {
  2840: "US", 2826: "GB", 2124: "CA", 2036: "AU", 2554: "NZ", 2372: "IE", 2356: "IN", 2276: "DE",
  2250: "FR", 2724: "ES", 2484: "MX", 2076: "BR", 2380: "IT", 2528: "NL", 2752: "SE", 2392: "JP",
};

export async function getSettings(scope: ProjectScope): Promise<AuditSettings> {
  const [row] = await db
    .select()
    .from(auditSettings)
    .where(and(eq(auditSettings.workspaceId, scope.workspaceId), eq(auditSettings.projectId, scope.projectId)));
  return row ?? { ...scope, maxPages: 500, enableJavascript: false, loadResources: true, weeklyEnabled: false, updatedAt: new Date() };
}

export async function saveSettings(scope: ProjectScope, patch: Partial<Omit<AuditSettings, "workspaceId" | "projectId" | "updatedAt">>) {
  const current = await getSettings(scope);
  const next = { ...current, ...patch, ...scope, updatedAt: new Date() };
  await db.insert(auditSettings).values(next).onConflictDoUpdate({ target: auditSettings.projectId, set: next });
}

const crawlsIn = (s: ProjectScope) => and(eq(auditCrawls.workspaceId, s.workspaceId), eq(auditCrawls.projectId, s.projectId));

export async function activeCrawl(scope: ProjectScope): Promise<AuditCrawl | null> {
  const [row] = await db
    .select()
    .from(auditCrawls)
    .where(and(crawlsIn(scope), inArray(auditCrawls.status, [...ACTIVE_STATUSES])))
    .orderBy(desc(auditCrawls.createdAt))
    .limit(1);
  return row ?? null;
}

/** Creates the crawl row. The audit.start job posts it to DataForSEO. */
export async function createCrawl(
  project: Project,
  opts: { maxPages: number; enableJavascript: boolean; loadResources: boolean },
  trigger: "manual" | "schedule",
): Promise<number> {
  const busy = new Error("A crawl is already running for this project.");
  if (await activeCrawl(projectScope(project))) throw busy;
  // The plan caps pages per audit (500 outside the owner's workspace).
  const billing = await loadBillingWorkspace(project.workspaceId);
  const planPages = auditPageLimit(billing, MAX_PAGES_LIMIT);
  const enableJavascript = auditJavascript(billing, opts.enableJavascript);
  const maxPages = Math.min(Math.max(Math.round(opts.maxPages), 1), planPages);
  try {
    const [row] = await db
      .insert(auditCrawls)
      .values({
        workspaceId: project.workspaceId,
        projectId: project.id,
        target: project.domain,
        trigger,
        maxPages,
        enableJavascript,
        loadResources: opts.loadResources || enableJavascript,
        estimatedCostUsd: estimateCrawlCost({ ...opts, enableJavascript, maxPages }),
      })
      .returning({ id: auditCrawls.id });
    return row.id;
  } catch (err) {
    // A concurrent submit won the race to the one-active-crawl index.
    if (isUniqueViolation(err)) throw busy;
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if ((e as Error & { code?: string }).code === "23505") return true;
  }
  return false;
}

async function fail(id: number, err: unknown) {
  await db.update(auditCrawls).set({ status: "failed", error: storedFailure(err), finishedAt: new Date() }).where(eq(auditCrawls.id, id));
}

/**
 * Posts the crawl task. The row is claimed (queued → posting) in one UPDATE first, so overlapping
 * callers (audit.start, the poller's re-post, the weekly schedule) can't each pay for a crawl.
 * The claim only matches a crawl of `scope`, so a job can't post another workspace's crawl. A crawl
 * queued before a downgrade is posted at what the plan allows now: its pages and JavaScript.
 */
export async function postCrawl(scope: ProjectScope, crawlId: number): Promise<void> {
  const claimable = and(eq(auditCrawls.id, crawlId), crawlsIn(scope), eq(auditCrawls.status, "queued"), isNull(auditCrawls.taskId));
  const [queued] = await db.select().from(auditCrawls).where(claimable);
  if (!queued) return;
  const billing = await loadBillingWorkspace(scope.workspaceId);
  const maxPages = Math.min(queued.maxPages, auditPageLimit(billing, MAX_PAGES_LIMIT));
  const enableJavascript = auditJavascript(billing, queued.enableJavascript);
  const [crawl] = await db
    .update(auditCrawls)
    .set({
      status: "posting",
      startedAt: new Date(),
      maxPages,
      enableJavascript,
      estimatedCostUsd: estimateCrawlCost({ maxPages, enableJavascript, loadResources: queued.loadResources }),
    })
    .where(claimable)
    .returning();
  if (crawl) await sendCrawl(crawl);
}

/**
 * What audit.start runs once `jobScope` has checked that the project and workspace are still live
 * and able to pay. A refused crawl is closed with the reason, so nothing posts it later; a pause the
 * refusal records re-queues the job, which then finds the crawl closed and spends nothing.
 */
export async function startCrawl(scoped: JobScope, payload: ProjectJobPayload & { crawlId: number }): Promise<{ skipped: string } | undefined> {
  if (!scoped.ok) {
    await closeRefusedCrawl(payload, scoped.refusal?.message ?? CRAWL_NOT_STARTED);
    return { skipped: scoped.reason };
  }
  await postCrawl(scoped.scope, payload.crawlId);
}

/** A queued crawl whose start job was lost (e.g. the worker was down): the poller runs audit.start's checks for it, as audit.start. */
export async function startLostCrawl(crawl: ProjectScope & { id: number }): Promise<void> {
  const payload = { workspaceId: crawl.workspaceId, projectId: crawl.projectId, crawlId: crawl.id };
  await withBillingContext({ job: { name: "audit.start", data: payload } }, async () => startCrawl(await jobScope(payload, { paid: true }), payload));
}

async function closeRefusedCrawl({ workspaceId, projectId, crawlId }: ProjectJobPayload & { crawlId: number }, reason: string): Promise<void> {
  if (!Number.isInteger(workspaceId) || !Number.isInteger(projectId) || !Number.isInteger(crawlId)) return;
  await db
    .update(auditCrawls)
    .set({ status: "failed", error: reason, finishedAt: new Date() })
    .where(and(eq(auditCrawls.id, crawlId), crawlsIn({ workspaceId: workspaceId!, projectId: projectId! }), eq(auditCrawls.status, "queued"), isNull(auditCrawls.taskId)));
}

/**
 * Recovers a crawl stuck in "posting" (the worker died mid-post, the post timed out, or DataForSEO
 * answered 5xx). Adopts the task if DataForSEO has it under our tag, otherwise posts again.
 */
export async function recoverPosting(crawlId: number): Promise<void> {
  const [crawl] = await db
    .update(auditCrawls)
    .set({ startedAt: new Date() })
    .where(
      and(
        eq(auditCrawls.id, crawlId),
        eq(auditCrawls.status, "posting"),
        isNull(auditCrawls.taskId),
        lt(auditCrawls.startedAt, new Date(Date.now() - POSTING_TIMEOUT_MS)),
      ),
    )
    .returning();
  if (!crawl) return;
  const taskId = await findPostedTask(crawl);
  if (taskId) await recordPosted(crawl.id, taskId, await chargeAdoptedTask(crawl));
  else await sendCrawl(crawl);
}

/**
 * Crawl ids repeat across databases, and every environment with real credentials shares one
 * DataForSEO account, so the tag also names the database: a local one can never adopt production's
 * task. A hash of the host and database name only, never the credentials in the URL.
 */
let databaseTag: string | undefined;
function thisDatabase(): string {
  if (databaseTag) return databaseTag;
  // The same URL `@/db` connects with.
  const url = new URL(process.env.DATABASE_URL!);
  databaseTag = createHash("sha256").update(`${url.hostname}${url.pathname}`).digest("hex").slice(0, 10);
  return databaseTag;
}

export const crawlTag = (id: number) => `seopen-audit-${thisDatabase()}-${id}`;
const dfsDate = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} +00:00`;
/** The most ids on_page/id_list returns. A full list may have left our task out. */
const ID_LIST_LIMIT = 1000;

/**
 * Looks up a task_post for this crawl by its tag. Both calls are free. on_page/id_list gives the
 * candidate ids, but its metadata can belong to a different task and its time filter is off by
 * about an hour, so the window is wide and each candidate's tag is confirmed from its summary.
 * Monday's schedule posts a crawl for every opted-in project at once, so a task another crawl has
 * stored is skipped and every other one is checked. Throws rather than say "not posted" when the
 * list came back full, since posting again would pay twice.
 */
async function findPostedTask(crawl: AuditCrawl): Promise<string | null> {
  const free = { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, free: true, ttlSeconds: 0 } as const;
  const res = await dfsPost<{ id: string; url: string; datetime_posted: string }>(
    "on_page/id_list",
    [{ datetime_from: dfsDate(new Date(crawl.createdAt.getTime() - 3 * 3600_000)), datetime_to: dfsDate(new Date()), limit: ID_LIST_LIMIT }],
    free,
  );
  const task = res.tasks?.[0];
  if (!task || task.status_code !== 20000) throw new DataForSEOError(task?.status_message ?? "No task returned", task?.status_code ?? 0, "on_page/id_list");
  const listed = task.result ?? [];
  const posts = listed.filter((r) => r.url.endsWith("on_page/task_post"));
  const ids = posts.map((r) => r.id);
  const stored = ids.length ? await db.select({ id: auditCrawls.taskId }).from(auditCrawls).where(inArray(auditCrawls.taskId, ids)) : [];
  const taken = new Set(stored.map((r) => r.id));
  const candidates = posts.filter((r) => !taken.has(r.id)).sort((a, b) => b.datetime_posted.localeCompare(a.datetime_posted));
  for (const c of candidates) {
    const summary = await dfsGet(`on_page/summary/${c.id}`, free);
    if (summary.tasks?.[0]?.data?.tag === crawlTag(crawl.id)) return c.id;
  }
  if (listed.length >= ID_LIST_LIMIT) throw new Error(`Crawl ${crawl.id}: DataForSEO's task list came back full, so it can't say the crawl wasn't posted. Looking again later.`);
  return null;
}

/**
 * What an adopted task cost the workspace, charging it now if nothing has. A post whose answer never
 * came back (a network error, a 5xx, a worker that died) charged nothing, though DataForSEO charged
 * for the task; one whose answer came back but whose row couldn't be updated was charged then. Only
 * this crawl can have posted for its project since it was created (one active crawl per project), so
 * a task_post charge since then is its own. The estimate is what max_crawl_pages costs up front, and
 * settleCost refunds against it.
 */
async function chargeAdoptedTask(crawl: AuditCrawl): Promise<number> {
  const [row] = await db
    .select({ cost: sql<string | null>`sum(${apiLedger.costUsd})` })
    .from(apiLedger)
    .where(
      and(
        eq(apiLedger.workspaceId, crawl.workspaceId),
        eq(apiLedger.projectId, crawl.projectId),
        eq(apiLedger.module, "audit"),
        eq(apiLedger.endpoint, "on_page/task_post"),
        gt(apiLedger.costUsd, 0),
        gte(apiLedger.createdAt, crawl.createdAt),
      ),
    );
  const recorded = Number(row?.cost ?? 0);
  if (recorded > 0) return recorded;
  await recordLedgerAdjustment({ workspaceId: crawl.workspaceId, endpoint: "on_page/task_post", module: "audit", projectId: crawl.projectId, deltaUsd: crawl.estimatedCostUsd });
  return crawl.estimatedCostUsd;
}

/** An HTTP 5xx. task_post isn't retried on one (defaultServerRetries), and it may still have created the task. */
const serverError = (err: DataForSEOError) => err.statusCode >= 500 && err.statusCode < 600;

async function sendCrawl(crawl: AuditCrawl): Promise<void> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, crawl.workspaceId), eq(projects.id, crawl.projectId)));
  let task;
  try {
    const res = await dfsPost(
      "on_page/task_post",
      [
        crawlTaskBody({
          target: crawl.target,
          maxPages: crawl.maxPages,
          enableJavascript: crawl.enableJavascript,
          loadResources: crawl.loadResources,
          tag: crawlTag(crawl.id),
          acceptLanguage: acceptLanguage(project?.languageCode ?? "en", COUNTRY_ISO[project?.locationCode ?? 0]),
        }),
      ],
      { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, ttlSeconds: 0, estimateUsd: crawl.estimatedCostUsd },
    );
    task = res.tasks[0];
    if (!task || task.status_code !== 20100) {
      throw new DataForSEOError(task?.status_message ?? "No task returned", task?.status_code ?? 0, "on_page/task_post");
    }
  } catch (err) {
    // A rejection means no task exists. A network error or a 5xx may have created one, so the row
    // stays in "posting" and recoverPosting looks it up by tag later.
    if ((err instanceof DataForSEOError && !serverError(err)) || err instanceof BudgetExceededError) await fail(crawl.id, err);
    throw err;
  }
  await recordPosted(crawl.id, task.id, task.cost);
}

/** Closes a crawl whose start job couldn't be queued. A job that did get queued and has claimed the row is left alone. */
export async function failUnqueuedCrawl(scope: ProjectScope, crawlId: number): Promise<void> {
  await db
    .update(auditCrawls)
    .set({ status: "failed", error: CRAWL_NOT_QUEUED, finishedAt: new Date() })
    .where(and(eq(auditCrawls.id, crawlId), crawlsIn(scope), eq(auditCrawls.status, "queued"), isNull(auditCrawls.taskId)));
}

/** Stores the task id of a paid, running crawl. Never marks the crawl failed: the task is already running. */
async function recordPosted(crawlId: number, taskId: string, cost: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.update(auditCrawls).set({ taskId, status: "crawling", startedAt: new Date(), costUsd: cost }).where(eq(auditCrawls.id, crawlId));
      return;
    } catch (err) {
      if (attempt >= 3) {
        // Left in "posting": recoverPosting adopts the task by its tag after the timeout.
        console.error(`[audit] crawl ${crawlId} is running as task ${taskId}, but the row could not be updated`, err);
        throw err;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

/** Asks DataForSEO to stop crawling; the next poll imports whatever was crawled. `crawl` comes from `activeCrawl(scope)`. */
export async function stopCrawl(crawl: AuditCrawl): Promise<void> {
  if (!crawl.taskId) {
    // Only a crawl nobody has claimed can be cancelled here; a "posting" one is stopped once it has a task id.
    await db
      .update(auditCrawls)
      .set({ status: "failed", error: CRAWL_CANCELLED, finishedAt: new Date() })
      .where(and(eq(auditCrawls.id, crawl.id), eq(auditCrawls.workspaceId, crawl.workspaceId), eq(auditCrawls.status, "queued"), isNull(auditCrawls.taskId)));
    return;
  }
  await forceStop(crawl);
}

/** force_stop is best effort: if it fails, the poller still reconciles the crawl from its summary. */
async function forceStop(crawl: AuditCrawl): Promise<void> {
  try {
    await dfsPost("on_page/force_stop", [{ id: crawl.taskId }], {
      module: "audit",
      workspaceId: crawl.workspaceId,
      projectId: crawl.projectId,
      free: true,
      ttlSeconds: 0,
    });
  } catch (err) {
    if (!(err instanceof DataForSEOError)) throw err;
    console.warn(`[audit] force_stop for crawl ${crawl.id} failed`, err.message);
  }
}

/**
 * DataForSEO charges for max_crawl_pages up front and refunds unused pages when the crawl ends.
 * Records that refund once: the update only matches a crawl with no `costSettledAt` and sets it, so
 * a rerun does nothing, whatever `costUsd` reads by then. (It used to match on the charged amount,
 * which this function rewrites, so each poll after a failed import refunded again from the lower figure.)
 * The row and the ledger change in one transaction, so a failed ledger write leaves the refund for
 * the next poll. Callers settle before they close the crawl, which the poller would never look at again.
 */
async function settleCost(crawl: AuditCrawl, pagesCrawled: number): Promise<void> {
  const charged = crawl.costUsd;
  if (!charged || pagesCrawled >= crawl.maxPages) return;
  const actual = Math.round(charged * (Math.max(pagesCrawled, 0) / crawl.maxPages) * 1e6) / 1e6;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(auditCrawls)
      .set({ costUsd: actual, costSettledAt: new Date() })
      .where(and(eq(auditCrawls.id, crawl.id), isNull(auditCrawls.costSettledAt)))
      .returning({ id: auditCrawls.id });
    if (!row) return;
    await recordLedgerAdjustment(
      { workspaceId: crawl.workspaceId, endpoint: "on_page/task_post", module: "audit", projectId: crawl.projectId, deltaUsd: actual - charged },
      tx,
    );
  });
}

/** Pages a stopped crawl got to: its summary's count, or the last poll's when the summary can't be read. */
async function pagesReached(crawl: AuditCrawl): Promise<number> {
  try {
    const res = await dfsGet<DfsSummary>(`on_page/summary/${crawl.taskId}`, { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, free: true });
    return Math.max(res.tasks?.[0]?.result?.[0]?.crawl_status?.pages_crawled ?? 0, crawl.pagesCrawled);
  } catch {
    return crawl.pagesCrawled;
  }
}

function items<T>(res: DfsResponse<DfsItems<T>>): { total: number; items: T[] } {
  const task = res.tasks?.[0];
  if (!task) throw new DataForSEOError("DataForSEO returned no task", 0, "");
  if (task.status_code === 40102) return { total: 0, items: [] };
  if (task.status_code !== 20000) throw new DataForSEOError(task.status_message, task.status_code, task.path?.join("/") ?? "");
  const r = task.result?.[0];
  return { total: r?.total_items_count ?? 0, items: r?.items ?? [] };
}

/** Pages through one of the On-Page list endpoints (pages, links, resources, non_indexable). */
async function fetchAll<T>(endpoint: string, crawl: AuditCrawl, extra: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < MAX_IMPORT_ROWS; offset += PAGE_SIZE) {
    const res = await dfsPost<DfsItems<T>>(
      endpoint,
      [{ id: crawl.taskId, limit: PAGE_SIZE, offset, ...extra }],
      { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, free: true },
    );
    const { total, items: batch } = items(res);
    out.push(...batch);
    if (batch.length < PAGE_SIZE || out.length >= total) break;
  }
  return out;
}

async function fetchDuplicates(crawl: AuditCrawl, type: "duplicate_title" | "duplicate_description") {
  const res = await dfsPost<DfsItems<DfsDuplicateGroup>>(
    "on_page/duplicate_tags",
    [{ id: crawl.taskId, type, limit: PAGE_SIZE }],
    { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, free: true },
  );
  return items(res).items;
}

/**
 * Two of DataForSEO's checks are broader than our findings, so each page flagged for one is
 * fetched once and keeps the flag only when the page really has the problem.
 *
 * duplicate_meta_tags fires when any meta tag repeats, including pairs meant to repeat
 * (theme-color for light and dark mode). The finding is about two titles or two descriptions.
 *
 * no_image_alt fires for alt="" as well as for no alt, and alt="" is right for a decorative
 * image. The finding is an image with no alt attribute, and the fetch names those images. A page
 * whose HTML has no images at all keeps the flag (they may come from JavaScript), and so does one
 * whose HTML was cut short (the image may be past the cut). A crawl that ran JavaScript never
 * clears it: DataForSEO judged the rendered page, and the fetch sees only the raw HTML, which can
 * lack images a script adds. Its fetch still names the images the raw HTML shows without alt.
 *
 * plain_text_word_count leaves out text inside links, so a card grid or a blog index, whose copy
 * is mostly links, reads as thin. Each page under THIN_CONTENT_WORDS is fetched and its content
 * counted with link text (`contentWordCount`), and the page keeps the higher of the two counts:
 * the raw HTML can lack words a script adds, so the fetch only ever raises the count.
 *
 * A page that can't be fetched keeps its flags: it's DataForSEO's word against nothing. So does one
 * the import didn't get to before `budget.ms` ran out.
 */
export async function confirmPageChecks(
  crawl: Pick<AuditCrawl, "id" | "enableJavascript">,
  pages: DfsPage[],
  budget: { ms: number; now: () => number } = { ms: PAGE_CONFIRM_BUDGET_MS, now: Date.now },
): Promise<{ pages: DfsPage[]; imagesWithoutAlt: Map<string, ImagesWithoutAlt> }> {
  const imagesWithoutAlt = new Map<string, ImagesWithoutAlt>();
  const html = pages.filter((p) => p.resource_type === "html");
  const thin = (p: DfsPage) => {
    const words = p.meta?.content?.plain_text_word_count;
    return words != null && words < THIN_CONTENT_WORDS && (p.status_code ?? 0) >= 200 && (p.status_code ?? 0) < 300;
  };
  const flagged = [
    ...html.filter((p) => p.checks?.duplicate_meta_tags === true),
    ...html.filter((p) => p.checks?.duplicate_meta_tags !== true && p.checks?.no_image_alt === true),
    ...html.filter((p) => p.checks?.duplicate_meta_tags !== true && p.checks?.no_image_alt !== true && thin(p)),
  ].slice(0, MAX_PAGE_CONFIRMS);
  if (!flagged.length) return { pages, imagesWithoutAlt };
  const clear = new Map<string, Record<string, boolean>>();
  const words = new Map<string, number>();
  const started = budget.now();
  for (let i = 0; i < flagged.length; i += PAGE_CONFIRM_BATCH) {
    if (budget.now() - started >= budget.ms) {
      console.warn(`[audit] page check confirmation for crawl ${crawl.id} ran out of time with ${flagged.length - i} pages left`);
      break;
    }
    const batch = await Promise.allSettled(
      flagged.slice(i, i + PAGE_CONFIRM_BATCH).map(async (p) => {
        const r = await safeFetch(p.url, { timeoutMs: PAGE_CONFIRM_TIMEOUT_MS });
        return { page: p, ok: r.status >= 200 && r.status < 300, truncated: r.truncated, html: r.body };
      }),
    );
    for (const r of batch) {
      if (r.status === "rejected") {
        console.warn(`[audit] page check confirmation for crawl ${crawl.id} failed`, r.reason);
        continue;
      }
      const { page, ok, truncated, html } = r.value;
      if (!ok) continue;
      const cleared: Record<string, boolean> = {};
      if (page.checks?.duplicate_meta_tags === true && !hasDuplicateTitleOrDescription(html)) cleared.duplicate_meta_tags = false;
      if (page.checks?.no_image_alt === true) {
        const { images, missing, named } = imageAltCounts(html);
        if (missing) imagesWithoutAlt.set(page.url, { missing, named });
        else if (images > 0 && !truncated && !crawl.enableJavascript) cleared.no_image_alt = false;
      }
      if (Object.keys(cleared).length) clear.set(page.url, cleared);
      if (thin(page)) {
        const counted = contentWordCount(html);
        if (counted > (page.meta?.content?.plain_text_word_count ?? 0)) words.set(page.url, counted);
      }
    }
  }
  return {
    pages: pages.map((p) => {
      const checks = clear.get(p.url);
      const counted = words.get(p.url);
      if (!checks && counted == null) return p;
      return {
        ...p,
        ...(checks ? { checks: { ...p.checks, ...checks } } : {}),
        ...(counted != null && p.meta ? { meta: { ...p.meta, content: { plain_text_rate: p.meta.content?.plain_text_rate ?? null, plain_text_word_count: counted } } } : {}),
      };
    }),
    imagesWithoutAlt,
  };
}

/** The closest match for each flagged page. It only adds detail to a finding, so a failed lookup leaves that page's blank. */
async function fetchContentMatches(crawl: AuditCrawl, urls: string[]): Promise<ContentMatch[]> {
  const out: ContentMatch[] = [];
  const wanted = urls.slice(0, MAX_CONTENT_MATCHES);
  for (let i = 0; i < wanted.length; i += CONTENT_MATCH_BATCH) {
    const batch = await Promise.allSettled(
      wanted.slice(i, i + CONTENT_MATCH_BATCH).map(async (url) => {
        const res = await dfsPost<DfsItems<DfsContentMatches>>(
          "on_page/duplicate_content",
          [{ id: crawl.taskId, url }],
          { module: "audit", workspaceId: crawl.workspaceId, projectId: crawl.projectId, free: true },
        );
        return toContentMatch(items(res).items[0]);
      }),
    );
    for (const r of batch) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") console.warn(`[audit] closest match lookup for crawl ${crawl.id} failed`, r.reason);
    }
  }
  return out;
}

/**
 * A copy with every NUL character removed, from strings nested in arrays and objects too. Postgres
 * refuses one in text and in jsonb, and these values come from the audited site (its robots.txt, its
 * tags), so one stray byte would fail the whole import.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)])) as T;
  return value;
}

async function insertChunked<T extends object>(table: Parameters<typeof db.insert>[0], rows: T[], size = 400) {
  for (let i = 0; i < rows.length; i += size) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table).values(rows.slice(i, i + size).map(withoutNul) as any);
  }
}

/** Failed imports a crawl gets before it is closed as failed. The poller would otherwise try again on every run. */
const MAX_IMPORT_ATTEMPTS = 5;

/** Postgres refused the data itself (classes 22 and 23) or a size limit (54): the same rows fail the same way next time. */
function isDataError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (/^(22|23|54)/.test((e as Error & { code?: string }).code ?? "")) return true;
  }
  return false;
}

/**
 * Counts a failed import and closes the crawl when another try can't help: Postgres refused the
 * data, or this was the last try. True when it closed the crawl.
 */
async function importGaveUp(crawl: AuditCrawl, err: unknown): Promise<boolean> {
  const [row] = await db
    .update(auditCrawls)
    .set({ importAttempts: sql`${auditCrawls.importAttempts} + 1` })
    .where(eq(auditCrawls.id, crawl.id))
    .returning({ attempts: auditCrawls.importAttempts });
  if (!isDataError(err) && (row?.attempts ?? 0) < MAX_IMPORT_ATTEMPTS) return false;
  console.error(`[audit] import of crawl ${crawl.id} failed for good`, err);
  await fail(crawl.id, new Error(CRAWL_NOT_SAVED));
  return true;
}

/** Copies a finished crawl into Postgres, detects issues and scores it. Safe to run again. */
export async function importCrawl(crawl: AuditCrawl, summary: DfsSummary): Promise<void> {
  await db.update(auditCrawls).set({ status: "importing" }).where(eq(auditCrawls.id, crawl.id));

  const [rawPages, links, resources, nonIndexable, dupTitles, dupDescriptions] = await Promise.all([
    fetchAll<DfsPage>("on_page/pages", crawl),
    fetchAll<DfsLink>("on_page/links", crawl, { filters: [["is_broken", "=", true], "or", ["dofollow", "=", false]] }),
    fetchAll<DfsResource>("on_page/resources", crawl, { filters: ["status_code", ">", 399] }),
    fetchAll<DfsNonIndexable>("on_page/non_indexable", crawl),
    fetchDuplicates(crawl, "duplicate_title"),
    fetchDuplicates(crawl, "duplicate_description"),
  ]);

  const { pages, imagesWithoutAlt } = await confirmPageChecks(crawl, rawPages);
  const contentMatches = await fetchContentMatches(crawl, [...new Set(pages.filter((p) => p.resource_type === "html" && p.duplicate_content && (p.status_code ?? 0) >= 200 && (p.status_code ?? 0) < 300).map((p) => p.url))]);
  const duplicates = [...toDuplicateGroups("title", dupTitles), ...toDuplicateGroups("description", dupDescriptions)];
  const crawledPages = pages.map((p) => ({ ...toCrawledPage(p), imagesWithoutAlt: imagesWithoutAlt.get(p.url) }));
  const hidden = nonIndexable.map((n) => ({ url: n.url, reason: n.reason }));
  // Crawler and AI access: live robots.txt, the bot fetch test, raw vs rendered, http and the sitemap. It never throws.
  const access = await checkAccess(crawl, crawledPages, hidden);
  const issues = [
    ...detectIssues({
      target: crawl.target,
      pages: crawledPages,
      links: links.map(toCrawledLink),
      resources: resources.map(toCrawledResource),
      duplicates,
      contentMatches,
      nonIndexable: hidden,
      site: toSiteInfo(summary),
    }),
    ...access.issues,
  ];

  const htmlUrls = pages.filter((p) => p.resource_type === "html").map((p) => p.url);
  const score = healthScore(htmlUrls, issues);
  const blocked = new Set(nonIndexable.map((n) => n.url));
  const perUrl = new Map<string, number>();
  for (const i of issues) perUrl.set(i.url, (perUrl.get(i.url) ?? 0) + 1);

  const seen = new Set<string>();
  const pageRows = pages
    .filter((p) => !seen.has(p.url) && seen.add(p.url))
    .map((p) => {
      const row = pageRow(p);
      return {
        ...row,
        workspaceId: crawl.workspaceId,
        crawlId: crawl.id,
        indexable: p.resource_type === "html" ? !blocked.has(p.url) : null,
        issueCount: perUrl.get(p.url) ?? 0,
      };
    });

  await db.transaction(async (tx) => {
    for (const t of [auditPages, auditIssues, auditLinks, auditResources, auditDuplicates, auditNonIndexable]) {
      await tx.delete(t).where(and(eq(t.workspaceId, crawl.workspaceId), eq(t.crawlId, crawl.id)));
    }
  });
  const owner = { workspaceId: crawl.workspaceId, crawlId: crawl.id };
  await insertChunked(auditPages, pageRows, 300);
  await insertChunked(auditIssues, issues.map((i) => ({ ...i, ...owner })));
  await insertChunked(
    auditLinks,
    links.map((l) => ({
      ...owner,
      fromUrl: l.link_from,
      toUrl: l.link_to,
      direction: l.direction,
      linkType: l.type,
      dofollow: l.dofollow,
      isBroken: l.is_broken,
      anchor: l.text?.slice(0, 500) ?? null,
    })),
  );
  await insertChunked(
    auditResources,
    resources.map((r) => ({
      ...owner,
      url: r.url,
      resourceType: r.resource_type,
      statusCode: r.status_code,
      sizeBytes: r.size,
      checks: Object.entries(r.checks ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    })),
  );
  await insertChunked(auditDuplicates, duplicates.map((d) => ({ ...d, ...owner })));
  await insertChunked(auditNonIndexable, nonIndexable.map((n) => ({ ...owner, url: n.url, reason: n.reason })));

  await db
    .update(auditCrawls)
    .set({
      status: "done",
      error: null,
      pagesCrawled: summary.crawl_status?.pages_crawled ?? pages.length,
      pagesInQueue: 0,
      healthScore: score.score,
      errors: score.errors,
      warnings: score.warnings,
      notices: score.notices,
      pagesWithIssues: score.pagesWithIssues,
      summary: withoutNul({ ...summarySubset(summary), access: access.report }),
      finishedAt: new Date(),
    })
    .where(eq(auditCrawls.id, crawl.id));

  // The audit is done whatever happens here: a failed sync leaves the fix list a crawl behind, and the next one catches up.
  await syncAuditFixes(crawl, issues, [...pages.map((p) => p.url), ...resources.map((r) => r.url)]).catch((err) => console.error("[fixes.sync]", err));
  // Alerts too: a clicked page that broke or a search bot newly blocked emails at once. Never fails the import.
  await alertsAfterCrawl({ crawl, pages: pages.map((p) => ({ url: p.url, statusCode: p.status_code ?? null })), nonIndexable: hidden, issues, report: access.report }).catch((err) => console.error("[alerts]", err));
}

/** One poll of a running crawl: updates progress, imports when finished. */
export async function pollCrawl(crawl: AuditCrawl): Promise<"running" | "done" | "failed"> {
  if (!crawl.taskId) return "running";
  if (crawl.startedAt && Date.now() - crawl.startedAt.getTime() > STALE_AFTER_MS) {
    await forceStop(crawl);
    await settleCost(crawl, await pagesReached(crawl));
    await fail(crawl.id, new Error("The crawl did not finish within 12 hours."));
    return "failed";
  }
  try {
    const res = await dfsGet<DfsSummary>(`on_page/summary/${crawl.taskId}`, {
      module: "audit",
      workspaceId: crawl.workspaceId,
      projectId: crawl.projectId,
      free: true,
    });
    const task = res.tasks?.[0];
    if (!task) throw new DataForSEOError("DataForSEO returned no task", 0, "on_page/summary");
    // Still being handed over to the crawler.
    if (task.status_code === 40601 || task.status_code === 40602) return "running";
    if (task.status_code !== 20000) throw new DataForSEOError(task.status_message, task.status_code, "on_page/summary");
    const summary = task.result?.[0] ?? null;
    if (!summary) return "running";

    if (summary.crawl_progress !== "finished") {
      await db
        .update(auditCrawls)
        .set({
          pagesCrawled: summary.crawl_status?.pages_crawled ?? 0,
          pagesInQueue: summary.crawl_status?.pages_in_queue ?? 0,
          lastPolledAt: new Date(),
        })
        .where(eq(auditCrawls.id, crawl.id));
      return "running";
    }
    const pagesCrawled = summary.crawl_status?.pages_crawled ?? 0;
    await settleCost(crawl, pagesCrawled);
    const failure = crawlFailureReason(summary);
    if (failure) {
      await db
        .update(auditCrawls)
        .set({ status: "failed", error: failure, pagesCrawled, summary: summarySubset(summary), finishedAt: new Date() })
        .where(eq(auditCrawls.id, crawl.id));
      return "failed";
    }
    try {
      await importCrawl(crawl, summary);
    } catch (err) {
      if (await importGaveUp(crawl, err)) return "failed";
      throw err;
    }
    return "done";
  } catch (err) {
    // Expired or unknown task ids can never recover; transient errors are retried on the next poll.
    // With no summary to read, the refund is reckoned from the last poll's count.
    if (err instanceof DataForSEOError && [40401, 40403].includes(err.statusCode)) {
      await settleCost(crawl, crawl.pagesCrawled);
      await fail(crawl.id, err);
      return "failed";
    }
    if (crawl.status === "importing") await db.update(auditCrawls).set({ status: "crawling" }).where(eq(auditCrawls.id, crawl.id));
    throw err;
  }
}

/**
 * Polls every crawl that has been posted and isn't finished. Global on purpose: polling is free,
 * and every crawl row carries its own workspace, which each call and import uses. Returns how many
 * posted crawls are still running, one that failed to poll included, so audit.poll can look again soon.
 */
export async function pollActiveCrawls(): Promise<number> {
  const rows = await db
    .select()
    .from(auditCrawls)
    .where(inArray(auditCrawls.status, ["crawling", "importing"]));
  const errors: unknown[] = [];
  let running = 0;
  for (const crawl of rows) {
    try {
      if ((await pollCrawl(crawl)) === "running") running++;
    } catch (err) {
      running++;
      errors.push(err);
      console.error(`[audit] poll of crawl ${crawl.id} failed`, err);
    }
  }
  // Post crawls whose start job was lost (e.g. the worker was down), and recover interrupted posts.
  const stuck = await db
    .select({ id: auditCrawls.id, status: auditCrawls.status, workspaceId: auditCrawls.workspaceId, projectId: auditCrawls.projectId })
    .from(auditCrawls)
    .where(
      or(
        and(eq(auditCrawls.status, "queued"), lt(auditCrawls.createdAt, new Date(Date.now() - 5 * 60_000))),
        and(eq(auditCrawls.status, "posting"), isNull(auditCrawls.taskId), lt(auditCrawls.startedAt, new Date(Date.now() - POSTING_TIMEOUT_MS))),
      ),
    );
  for (const s of stuck) await (s.status === "queued" ? startLostCrawl(s) : recoverPosting(s.id)).catch((e) => errors.push(e));
  if (errors.length === rows.length + stuck.length && errors.length) throw errors[0];
  return running;
}

/** Projects that opted in to the weekly re-crawl, in active workspaces. The schedule fans out over these. */
export async function projectsWithWeeklyCrawl(): Promise<ProjectScope[]> {
  return activeProjects(
    sql`exists (select 1 from ${auditSettings} where ${auditSettings.workspaceId} = ${projects.workspaceId} and ${auditSettings.projectId} = ${projects.id} and ${auditSettings.weeklyEnabled})`,
  );
}

/** Weekly schedule for one project: starts a crawl if it opted in and hasn't crawled in 6 days. */
export async function startScheduledCrawl(project: Project): Promise<number | null> {
  const scope = projectScope(project);
  const settings = await getSettings(scope);
  if (!settings.weeklyEnabled) return null;
  const [recent] = await db
    .select({ id: auditCrawls.id })
    .from(auditCrawls)
    .where(and(crawlsIn(scope), gte(auditCrawls.createdAt, new Date(Date.now() - 6 * 86_400_000))))
    .limit(1);
  if (recent || (await activeCrawl(scope))) return null;
  const id = await createCrawl(project, settings, "schedule");
  await postCrawl(scope, id);
  return id;
}

/** Runs Lighthouse (desktop) for a queued audit_lighthouse row of `scope`. Paid: LIGHTHOUSE_PRICE_USD (transform.ts). */
export async function runLighthouse(scope: ProjectScope, id: number): Promise<void> {
  const where = and(eq(auditLighthouse.id, id), eq(auditLighthouse.workspaceId, scope.workspaceId), eq(auditLighthouse.projectId, scope.projectId));
  const [row] = await db.select().from(auditLighthouse).where(where);
  if (!row || row.status === "done") return;
  try {
    const res = await dfsPost<DfsLighthouse>(
      "on_page/lighthouse/live/json",
      [{ url: row.url, for_mobile: row.forMobile, categories: ["performance", "accessibility", "best_practices", "seo"] }],
      { module: "audit", workspaceId: row.workspaceId, projectId: row.projectId, ttlSeconds: TTL.week },
    );
    const task = res.tasks?.[0];
    if (!task || task.status_code !== 20000) throw new DataForSEOError(task?.status_message ?? "No task", task?.status_code ?? 0, "on_page/lighthouse");
    const lh = task.result?.[0];
    if (!lh) throw new Error("Lighthouse returned no result");
    await db.update(auditLighthouse).set({ ...lighthouseScores(lh), status: "done", error: null }).where(where);
  } catch (err) {
    await db
      .update(auditLighthouse)
      .set({ status: "failed", error: storedFailure(err) })
      .where(where);
    throw err;
  }
}

export const LIGHTHOUSE_ALREADY_QUEUED = "A Lighthouse test is already running for this project. Its scores appear here when it finishes.";

/**
 * Queues one Lighthouse row for the project, or returns null while one is already queued. The audit
 * queue runs one job at a time for every workspace, so a project gets one test in flight, like the
 * other "run now" buttons. The lock makes that hold under double clicks; a row queued over an hour
 * ago no longer counts, since expireStaleLighthouse fails it.
 */
export async function queueLighthouse(scope: ProjectScope, url: string): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seopen-lighthouse:${scope.projectId}`}, 0))`);
    const [queued] = await tx
      .select({ id: auditLighthouse.id })
      .from(auditLighthouse)
      .where(
        and(
          eq(auditLighthouse.workspaceId, scope.workspaceId),
          eq(auditLighthouse.projectId, scope.projectId),
          eq(auditLighthouse.status, "queued"),
          gt(auditLighthouse.createdAt, sql`now() - interval '1 hour'`),
        ),
      )
      .limit(1);
    if (queued) return null;
    const [row] = await tx.insert(auditLighthouse).values({ ...scope, url }).returning({ id: auditLighthouse.id });
    return row.id;
  });
}

/** Fails a queued Lighthouse row whose job never made it onto the queue, so the next click can try again. */
export async function failLighthouse(scope: ProjectScope, id: number, error: string): Promise<void> {
  await db
    .update(auditLighthouse)
    .set({ status: "failed", error })
    .where(and(eq(auditLighthouse.id, id), eq(auditLighthouse.workspaceId, scope.workspaceId), eq(auditLighthouse.projectId, scope.projectId)));
}

/** Marks Lighthouse rows stuck in "queued" for over an hour as failed, so the UI never spins forever. */
export async function expireStaleLighthouse() {
  await db
    .update(auditLighthouse)
    .set({ status: "failed", error: "Timed out" })
    .where(and(eq(auditLighthouse.status, "queued"), lt(auditLighthouse.createdAt, sql`now() - interval '1 hour'`)));
}
