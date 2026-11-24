import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditIssues, auditLighthouse, auditPages } from "@/db/schema";
import type { ProjectScope } from "@/lib/workspace";
import { diffCrawls } from "./diff";
import { statusCounts } from "./brief";
import { severityCounts } from "./score";
import { ISSUES, PAGE_ERROR_CODES, type Severity } from "./taxonomy";

export type CrawlRow = typeof auditCrawls.$inferSelect;

/**
 * A crawl that was loaded through the scope (`resolveCrawl`, `doneCrawls`, `getCrawlForProject`).
 * Child-table reads take one of these instead of a bare id and filter on its workspace too.
 */
export type CrawlRef = Pick<CrawlRow, "id" | "workspaceId">;

const crawlsIn = (s: ProjectScope) => and(eq(auditCrawls.workspaceId, s.workspaceId), eq(auditCrawls.projectId, s.projectId));

/**
 * Crawls with their errors, warnings and notices counted from their issue rows by today's severities
 * (`severityCounts`), so the headline, the history and the trend agree with the Issues tab and the
 * category table. A crawl that stored no counts, such as one still running, keeps none.
 */
async function withCurrentCounts(scope: ProjectScope, crawls: CrawlRow[]): Promise<CrawlRow[]> {
  const counted = crawls.filter((c) => c.errors != null);
  if (!counted.length) return crawls;
  const rows = await db
    .select({ crawlId: auditIssues.crawlId, code: auditIssues.code, n: count() })
    .from(auditIssues)
    .where(and(eq(auditIssues.workspaceId, scope.workspaceId), inArray(auditIssues.crawlId, counted.map((c) => c.id))))
    .groupBy(auditIssues.crawlId, auditIssues.code);
  const byCrawl = new Map<number, { code: string; n: number }[]>();
  for (const r of rows) byCrawl.set(r.crawlId, [...(byCrawl.get(r.crawlId) ?? []), r]);
  return crawls.map((c) => (c.errors == null ? c : { ...c, ...severityCounts(byCrawl.get(c.id) ?? []) }));
}

/** Crawls for a project, newest first. */
export async function listCrawls(scope: ProjectScope, limit = 50) {
  return withCurrentCounts(scope, await db.select().from(auditCrawls).where(crawlsIn(scope)).orderBy(desc(auditCrawls.createdAt)).limit(limit));
}

/** Finished crawls, newest first. */
export async function doneCrawls(scope: ProjectScope, limit = 50) {
  const rows = await db
    .select()
    .from(auditCrawls)
    .where(and(crawlsIn(scope), eq(auditCrawls.status, "done")))
    .orderBy(desc(auditCrawls.finishedAt))
    .limit(limit);
  return withCurrentCounts(scope, rows);
}

/** Each project's newest crawl, for All projects, with one query however many projects there are. */
export function newestCrawls(workspaceId: number, projectIds: number[]) {
  if (!projectIds.length) return Promise.resolve([]);
  return db
    .selectDistinctOn([auditCrawls.projectId], { projectId: auditCrawls.projectId, status: auditCrawls.status, error: auditCrawls.error, createdAt: auditCrawls.createdAt })
    .from(auditCrawls)
    .where(and(eq(auditCrawls.workspaceId, workspaceId), inArray(auditCrawls.projectId, projectIds)))
    .orderBy(auditCrawls.projectId, desc(auditCrawls.createdAt), desc(auditCrawls.id));
}

/** Each project's health score at its latest finished crawl, for the project switcher. */
export function latestHealth(workspaceId: number) {
  return db
    .selectDistinctOn([auditCrawls.projectId], { projectId: auditCrawls.projectId, healthScore: auditCrawls.healthScore })
    .from(auditCrawls)
    .where(and(eq(auditCrawls.workspaceId, workspaceId), eq(auditCrawls.status, "done"), isNotNull(auditCrawls.finishedAt)))
    .orderBy(auditCrawls.projectId, desc(auditCrawls.finishedAt));
}

export async function getCrawlForProject(scope: ProjectScope, id: number): Promise<CrawlRow | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(auditCrawls).where(and(eq(auditCrawls.id, id), crawlsIn(scope)));
  return row ?? null;
}

/** The crawl a page shows: `?crawl=` when valid, else the latest finished one, plus the one before it. */
export async function resolveCrawl(scope: ProjectScope, crawlParam?: string | string[]) {
  const done = await doneCrawls(scope, 100);
  const wanted = Number(Array.isArray(crawlParam) ? crawlParam[0] : crawlParam);
  const idx = Number.isInteger(wanted) ? done.findIndex((c) => c.id === wanted) : 0;
  const i = idx < 0 ? 0 : idx;
  return { crawl: done[i] ?? null, previous: done[i + 1] ?? null, all: done };
}

export async function issueRows(crawl: CrawlRef) {
  return db
    .select({ code: auditIssues.code, url: auditIssues.url })
    .from(auditIssues)
    .where(and(eq(auditIssues.workspaceId, crawl.workspaceId), eq(auditIssues.crawlId, crawl.id)));
}

/** How many pages have at least one error, per crawl id; a crawl with none has no entry. The crawls must share a workspace. */
export async function pagesWithErrors(crawls: CrawlRef[]): Promise<Map<number, number>> {
  if (!crawls.length) return new Map();
  const rows = await db
    .select({ crawlId: auditIssues.crawlId, pages: countDistinct(auditIssues.url) })
    .from(auditIssues)
    .where(and(eq(auditIssues.workspaceId, crawls[0].workspaceId), inArray(auditIssues.crawlId, crawls.map((c) => c.id)), inArray(auditIssues.code, PAGE_ERROR_CODES)))
    .groupBy(auditIssues.crawlId);
  return new Map(rows.map((r) => [r.crawlId, r.pages]));
}

export interface IssueSummary {
  code: string;
  title: string;
  category: string;
  severity: Severity;
  count: number;
  added: number;
  fixed: number;
}

/** Issue counts for a crawl with new/fixed counts against the previous crawl. */
export async function issueSummary(crawl: CrawlRef, previous: CrawlRef | null): Promise<{ rows: IssueSummary[]; newUrls: number; fixedUrls: number }> {
  const [cur, prev] = await Promise.all([issueRows(crawl), previous ? issueRows(previous) : Promise.resolve([])]);
  const previousId = previous?.id ?? null;
  const diff = diffCrawls(prev, cur);
  const rows = diff.codes
    .filter((c) => ISSUES[c.code])
    .map((c) => ({
      code: c.code,
      title: ISSUES[c.code].title,
      category: ISSUES[c.code].category,
      severity: c.severity,
      count: c.after,
      added: previousId ? c.added.length : 0,
      fixed: previousId ? c.fixed.length : 0,
    }));
  return { rows, newUrls: previousId ? diff.totals.added : 0, fixedUrls: previousId ? diff.totals.fixed : 0 };
}

/** Affected URLs for one issue, with whether each is new since the previous crawl. */
export async function issueDetailRows(crawl: CrawlRef, previous: CrawlRef | null, code: string) {
  const rows = await db
    .select({ url: auditIssues.url, detail: auditIssues.detail, title: auditPages.title, statusCode: auditPages.statusCode })
    .from(auditIssues)
    .leftJoin(
      auditPages,
      and(eq(auditPages.workspaceId, auditIssues.workspaceId), eq(auditPages.crawlId, auditIssues.crawlId), eq(auditPages.url, auditIssues.url)),
    )
    .where(and(eq(auditIssues.workspaceId, crawl.workspaceId), eq(auditIssues.crawlId, crawl.id), eq(auditIssues.code, code)))
    .orderBy(asc(auditIssues.url));
  const before = previous
    ? new Set(
        (
          await db
            .select({ url: auditIssues.url })
            .from(auditIssues)
            .where(and(eq(auditIssues.workspaceId, previous.workspaceId), eq(auditIssues.crawlId, previous.id), eq(auditIssues.code, code)))
        ).map((r) => r.url),
      )
    : null;
  return rows.map((r) => ({ ...r, isNew: before ? !before.has(r.url) : false }));
}

export function crawlPages(crawl: CrawlRef) {
  return db
    .select()
    .from(auditPages)
    .where(and(eq(auditPages.workspaceId, crawl.workspaceId), eq(auditPages.crawlId, crawl.id)))
    .orderBy(asc(auditPages.depth), asc(auditPages.url));
}

/** Status-class counts for the crawled-pages bar, sorted the way the Pages tab sorts them (`statusCounts`). */
export async function statusBreakdown(crawl: CrawlRef) {
  const [pages, issues] = await Promise.all([
    db
      .select({ url: auditPages.url, statusCode: auditPages.statusCode })
      .from(auditPages)
      .where(and(eq(auditPages.workspaceId, crawl.workspaceId), eq(auditPages.crawlId, crawl.id))),
    issueRows(crawl),
  ]);
  return statusCounts(pages, issues);
}

export async function latestLighthouse(scope: ProjectScope) {
  const [row] = await db
    .select()
    .from(auditLighthouse)
    .where(and(eq(auditLighthouse.workspaceId, scope.workspaceId), eq(auditLighthouse.projectId, scope.projectId)))
    .orderBy(desc(auditLighthouse.createdAt))
    .limit(1);
  return row ?? null;
}
