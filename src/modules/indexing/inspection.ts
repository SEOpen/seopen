import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { gscUrlInspections, indexingPages } from "@/db/schema";
import { inScope, type ProjectScope } from "@/lib/workspace";
import type { GscInspection } from "@/modules/google/types";
import { nextIndexedAt } from "./state";

/**
 * Keeps one of Google's answers about a URL: in the inspection history, and on the page's indexing row
 * when the URL is in the sitemap. The worker's own runs write the row; this is for the answers asked
 * for one at a time (the app's Inspect, `inspect_url`, `verify_fix`), so the Indexing list and the fixes
 * built from it are never older than the newest answer.
 */
export async function saveInspection(scope: ProjectScope, url: string, r: GscInspection, at = new Date()): Promise<void> {
  await db.insert(gscUrlInspections).values({ ...scope, url, ...r, inspectedAt: at, lastCrawlTime: r.lastCrawlTime ? new Date(r.lastCrawlTime) : null });
  const [page] = await db
    .select({ verdict: indexingPages.verdict, indexedAt: indexingPages.indexedAt })
    .from(indexingPages)
    .where(and(inScope(indexingPages, scope), eq(indexingPages.url, url)));
  if (!page) return;
  await db
    .update(indexingPages)
    .set({
      inspectedAt: at,
      verdict: r.verdict,
      coverageState: r.coverageState,
      robotsTxtState: r.robotsTxtState,
      indexingState: r.indexingState,
      pageFetchState: r.pageFetchState,
      lastCrawlTime: r.lastCrawlTime ? new Date(r.lastCrawlTime) : null,
      googleCanonical: r.googleCanonical,
      inspectionLink: r.inspectionResultLink,
      indexedAt: nextIndexedAt(page, r.verdict, at),
    })
    .where(and(inScope(indexingPages, scope), eq(indexingPages.url, url)));
}
