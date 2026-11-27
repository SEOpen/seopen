/**
 * What to change on a page that's close to the top, for Search Console Opportunities. Read from the
 * newest finished crawl only, never the live page: the list has up to 200 rows. The rules are the
 * "Refresh this page" panel's (refresh.ts, coverage.ts), so the two never disagree on the same crawl;
 * the panel reads the live page and stays the detailed view.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditPages } from "@/db/schema";
import { THIN_CONTENT_WORDS } from "@/modules/audit/issues";
import { isLikelyBotQuery } from "@/modules/google/bot-queries";
import type { ProjectScope } from "@/lib/workspace";
import { shortOnPurpose } from "./catalog";
import { coverage, fewLinksIn, isBrandSearch, termSet } from "./coverage";
import { pageVariants } from "./measure";

export interface CrawlPage {
  title: string | null;
  h1: string | null;
  words: number | null;
  linksIn: number | null;
}

export interface CrawlPages {
  crawlId: number;
  /** When the crawl finished. */
  at: Date | null;
  /** The median internal links in across the crawl's working HTML pages, as the panel reads it. */
  medianLinksIn: number | null;
  /** By the address as Search Console gave it. A page the crawl didn't reach isn't here. */
  pages: Map<string, CrawlPage>;
}

/** The listed pages' rows in the project's newest finished crawl, matched across http, www and a trailing slash. Null with no finished crawl. */
export async function latestCrawlPages(scope: ProjectScope, urls: string[]): Promise<CrawlPages | null> {
  const [crawl] = await db
    .select({ id: auditCrawls.id, at: auditCrawls.finishedAt })
    .from(auditCrawls)
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done")))
    .orderBy(desc(auditCrawls.finishedAt))
    .limit(1);
  if (!crawl) return null;
  const variants = new Map<string, string>();
  for (const url of urls) for (const v of pageVariants(url)) if (!variants.has(v)) variants.set(v, url);
  const inCrawl = and(eq(auditPages.workspaceId, scope.workspaceId), eq(auditPages.crawlId, crawl.id));
  const [rows, [median]] = await Promise.all([
    variants.size
      ? db
          .select({ url: auditPages.url, title: auditPages.title, h1: auditPages.h1, words: auditPages.wordCount, linksIn: auditPages.internalLinksIn })
          .from(auditPages)
          .where(and(inCrawl, inArray(auditPages.url, [...variants.keys()])))
      : Promise.resolve([]),
    db
      .select({ value: sql<number | null>`percentile_cont(0.5) within group (order by ${auditPages.internalLinksIn})::float` })
      .from(auditPages)
      .where(and(inCrawl, eq(auditPages.resourceType, "html"), sql`${auditPages.statusCode} between 200 and 299`, sql`${auditPages.internalLinksIn} is not null`)),
  ]);
  const pages = new Map<string, CrawlPage>();
  for (const { url, ...row } of rows) {
    const listed = variants.get(url);
    if (listed && !pages.has(listed)) pages.set(listed, row);
  }
  return { crawlId: crawl.id, at: crawl.at, medianLinksIn: median?.value ?? null, pages };
}

const quoted = (s: string) => `“${s}”`;
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};
const samePage = (a: string, b: string) => pageVariants(a).includes(b);

/**
 * Pure: short things to change for one page and the search it's closest on, each what the crawl
 * found. Empty when the crawl didn't reach the page or found nothing to flag.
 * - Another page of the site gets more impressions for the search: that's the one to work on, so
 *   nothing is said about this page's title.
 * - A brand search or another tool's rank check gets no title or H1 hint: there's nothing to add.
 */
export function opportunityHints(input: { query: string; page: string; bestPage?: string | null; crawl: CrawlPage | null; medianLinksIn: number | null; brand: Set<string> }): string[] {
  const { query, page, bestPage, crawl } = input;
  if (bestPage && !samePage(bestPage, page)) return [`Google shows ${pathOf(bestPage)} more for ${quoted(query)}: work on that page, or link to it from this one`];
  if (!crawl) return [];
  const out: string[] = [];
  if (!isLikelyBotQuery(query) && !isBrandSearch(query, input.brand)) {
    if (!crawl.title) out.push("No title");
    else {
      const c = coverage(query, termSet(crawl.title));
      if (c.label !== "covered" && c.absent.length) out.push(`Title is missing ${c.absent.map(quoted).join(", ")}`);
    }
    if (!crawl.h1) out.push("No H1");
    else {
      const c = coverage(query, termSet(crawl.h1));
      if (c.label !== "covered" && c.absent.length) out.push(`H1 is missing ${c.absent.map(quoted).join(", ")}`);
    }
  }
  if (fewLinksIn(crawl.linksIn, input.medianLinksIn)) out.push(`Only ${crawl.linksIn} internal ${crawl.linksIn === 1 ? "link" : "links"} in`);
  if (crawl.words != null && crawl.words < THIN_CONTENT_WORDS && !shortOnPurpose(page)) out.push(`Only ${crawl.words} words`);
  return out;
}
