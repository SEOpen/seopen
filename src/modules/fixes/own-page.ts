import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditPages } from "@/db/schema";
import type { ProjectScope } from "@/lib/workspace";
import { gscDataRange, pagesForQuery } from "@/modules/google/data";
import { pageKey } from "@/modules/google/matching";
import { addDays, type DateRange } from "@/modules/google/windowing";
import { coverage, terms, termSet } from "./coverage";
import { pageVariants } from "./measure";
import { ownPageType, type OwnPageType } from "./page-type";

/** Search Console's window for "the page it showed most", the same 28 days as its fixes. */
export const OWN_PAGE_DAYS = 28;

export const AUDIT_TITLE = "from SEOpen's latest site audit";

/** Each page's title in the newest finished crawl that has it, keyed by `pageKey`. Never fetches anything. */
export async function crawlTitles(scope: ProjectScope, urls: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const variants = [...new Set(urls.flatMap(pageVariants))];
  if (!variants.length) return out;
  const rows = await db
    .select({ url: auditPages.url, title: auditPages.title })
    .from(auditPages)
    .innerJoin(auditCrawls, eq(auditCrawls.id, auditPages.crawlId))
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done"), inArray(auditPages.url, variants)))
    .orderBy(desc(auditCrawls.finishedAt), desc(auditCrawls.id));
  for (const r of rows) if (!out.has(pageKey(r.url))) out.set(pageKey(r.url), r.title?.trim() || null);
  return out;
}

/**
 * The project's page whose title, in the newest finished crawl, has every topic word of a search: the
 * page written for it when Google and Search Console haven't tied one to it yet. The most focused title
 * wins (fewest words besides the search's), then the shortest address. Null when none has them all.
 */
export async function pageTitledFor(scope: ProjectScope, query: string): Promise<{ url: string; title: string } | null> {
  const want = new Set(terms(query));
  if (!want.size) return null;
  const [latest] = await db
    .select({ id: auditCrawls.id })
    .from(auditCrawls)
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done")))
    .orderBy(desc(auditCrawls.finishedAt), desc(auditCrawls.id))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select({ url: auditPages.url, title: auditPages.title })
    .from(auditPages)
    .where(and(eq(auditPages.workspaceId, scope.workspaceId), eq(auditPages.crawlId, latest.id), eq(auditPages.resourceType, "html"), sql`${auditPages.statusCode} between 200 and 299`, isNotNull(auditPages.title)));
  const fits = rows
    .map((r) => ({ url: r.url, title: r.title!.trim(), has: termSet(r.title) }))
    .filter((r) => r.title && coverage(query, r.has).label === "covered")
    .sort((a, b) => a.has.size - b.has.size || a.url.length - b.url.length || a.url.localeCompare(b.url));
  return fits[0] ? { url: fits[0].url, title: fits[0].title } : null;
}

/** The page's type from its address and the title the latest audit saw. */
export async function classifyOwnPage(scope: ProjectScope, url: string): Promise<OwnPageType & { title: string | null }> {
  const title = (await crawlTitles(scope, [url])).get(pageKey(url)) ?? null;
  return { ...ownPageType(url, title ? { text: title, from: AUDIT_TITLE } : null), title };
}

export async function searchConsoleWindow(scope: ProjectScope): Promise<DateRange | null> {
  const data = await gscDataRange(scope);
  return data ? { start: addDays(data.last, 1 - OWN_PAGE_DAYS), end: data.last } : null;
}

/** The page Search Console showed most for a search over the last 28 days, with its numbers. Addresses of one page count once. */
export async function topPageForSearch(scope: ProjectScope, query: string): Promise<{ page: string; impressions: number; clicks: number; position: number; period: DateRange } | null> {
  const period = await searchConsoleWindow(scope);
  if (!period) return null;
  const rows = await pagesForQuery(scope, query.trim().toLowerCase(), period);
  const byPage = new Map<string, { page: string; top: number; impressions: number; clicks: number; weighted: number }>();
  for (const r of rows) {
    if (!(r.impressions > 0)) continue;
    const k = pageKey(r.page);
    const a = byPage.get(k) ?? { page: r.page, top: 0, impressions: 0, clicks: 0, weighted: 0 };
    if (r.impressions > a.top) Object.assign(a, { page: r.page, top: r.impressions });
    a.impressions += r.impressions;
    a.clicks += r.clicks;
    a.weighted += r.position * r.impressions;
    byPage.set(k, a);
  }
  const best = [...byPage.values()].sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page))[0];
  return best ? { page: best.page, impressions: best.impressions, clicks: best.clicks, position: Math.round((best.weighted / best.impressions) * 10) / 10, period } : null;
}
