import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditPages, gscPages, indexingPages, indexingSettings } from "@/db/schema";
import { inScope, type ProjectScope } from "@/lib/workspace";
import {
  indexNowBatch,
  indexStatus,
  linkFrom,
  NOT_INDEXED,
  NOW_INDEXED_DAYS,
  adviceFor,
  requestPending,
  requestRank,
  STATUS_LABEL,
  type IndexStatus,
} from "./state";

export interface IndexingPage {
  url: string;
  status: IndexStatus;
  label: string;
  advice: string;
  coverage: string | null;
  inspectedAt: Date | null;
  lastCrawlTime: Date | null;
  googleCanonical: string | null;
  /** Search Console's page for the URL, where Request Indexing is. */
  inspectionLink: string | null;
  /** When the owner marked it requested. */
  requestedAt: Date | null;
  indexedAt: Date | null;
  submittedAt: Date | null;
}

export interface LinkHint {
  /** Internal links to the page in the latest finished site audit; null without one, or when the audit didn't reach it. */
  linksIn: number | null;
  /** Indexed pages to link from, best first. */
  from: string[];
}

export interface IndexingView {
  settings: typeof indexingSettings.$inferSelect | null;
  counts: { pages: number; inspected: number; indexed: number; notIndexed: number; requestIndexing: number; unchecked: number; submitted: number };
  /** Pages Google hasn't indexed: the ones Request Indexing helps first, then the ones to fix. */
  notIndexed: IndexingPage[];
  /** Pages to press Request Indexing on, best first: not requested yet, or requested over a week ago and still out. */
  toRequest: IndexingPage[];
  /** Pages requested in the last week that Google hasn't indexed yet. */
  requested: IndexingPage[];
  /** Pages Google hasn't indexed that a request won't help: fix first, duplicates and the rest. */
  others: IndexingPage[];
  /** Requests marked in the last 24 hours, against Search Console's daily limit. */
  requestedToday: number;
  /** Pages that became indexed in the last NOW_INDEXED_DAYS, newest first. */
  nowIndexed: IndexingPage[];
  /** Pages IndexNow would get on the next run. */
  pendingIndexNow: number;
}

const ORDER: Record<IndexStatus, number> = { waiting: 0, blocked: 1, duplicate: 2, other: 3, error: 4, unchecked: 5, indexed: 6 };
const DAY_MS = 86_400_000;

/** The Indexing tab and get_indexing: every sitemap page's state, read from what the worker stored. Costs nothing. */
export async function indexingView(scope: ProjectScope, now = new Date()): Promise<IndexingView> {
  const [[settings], rows] = await Promise.all([db.select().from(indexingSettings).where(inScope(indexingSettings, scope)), db.select().from(indexingPages).where(inScope(indexingPages, scope))]);
  const pages: IndexingPage[] = rows.map((r) => {
    const status = indexStatus(r);
    return {
      url: r.url,
      status,
      label: STATUS_LABEL[status],
      advice: adviceFor(status, r.verdict === "ERROR" ? null : r.coverageState),
      coverage: r.verdict === "ERROR" ? null : r.coverageState,
      inspectedAt: r.inspectedAt,
      lastCrawlTime: r.lastCrawlTime,
      googleCanonical: r.googleCanonical,
      inspectionLink: r.inspectionLink,
      requestedAt: r.requestedAt,
      indexedAt: r.indexedAt,
      submittedAt: r.submittedAt,
    };
  });
  const since = now.getTime() - NOW_INDEXED_DAYS * DAY_MS;
  const notIndexed = pages.filter((p) => NOT_INDEXED.includes(p.status)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.url.localeCompare(b.url));
  const pending = (p: IndexingPage) => requestPending(p.requestedAt, now);
  const nowIndexed = pages
    .filter((p) => p.status === "indexed" && p.indexedAt && p.indexedAt.getTime() >= since)
    .sort((a, b) => b.indexedAt!.getTime() - a.indexedAt!.getTime());
  return {
    settings: settings ?? null,
    counts: {
      pages: pages.length,
      inspected: pages.filter((p) => p.status !== "unchecked").length,
      indexed: pages.filter((p) => p.status === "indexed").length,
      notIndexed: notIndexed.length,
      requestIndexing: notIndexed.filter((p) => p.status === "waiting").length,
      unchecked: pages.filter((p) => p.status === "unchecked").length,
      submitted: pages.filter((p) => p.submittedAt).length,
    },
    notIndexed,
    toRequest: notIndexed.filter((p) => p.status === "waiting" && !pending(p)).sort((a, b) => requestRank(a.coverage) - requestRank(b.coverage) || a.url.localeCompare(b.url)),
    requested: notIndexed.filter(pending).sort((a, b) => b.requestedAt!.getTime() - a.requestedAt!.getTime()),
    others: notIndexed.filter((p) => p.status !== "waiting" && !pending(p)),
    requestedToday: rows.filter((r) => r.requestedAt && now.getTime() - r.requestedAt.getTime() < DAY_MS).length,
    nowIndexed,
    pendingIndexNow: settings?.indexnowHost ? indexNowBatch(rows, settings.indexnowHost).length : 0,
  };
}

/** "https://a.com/x/" and "https://a.com/x" are one page. */
const bare = (u: string) => u.replace(/\/+$/, "");

/**
 * For each target page: its internal links in the latest finished audit, and indexed pages to link
 * from (same section first, then by Search Console clicks in the last 28 days). Stored data only.
 */
export async function linkHints(scope: ProjectScope, targets: string[], now = new Date()): Promise<Map<string, LinkHint>> {
  const out = new Map<string, LinkHint>();
  if (!targets.length) return out;
  const start = new Date(now.getTime() - 28 * DAY_MS).toISOString().slice(0, 10);
  const [indexed, clicks, [crawl]] = await Promise.all([
    db
      .select({ url: indexingPages.url })
      .from(indexingPages)
      .where(and(inScope(indexingPages, scope), eq(indexingPages.verdict, "PASS"))),
    db
      .select({ page: gscPages.page, clicks: sql<number>`sum(${gscPages.clicks})::int` })
      .from(gscPages)
      .where(and(inScope(gscPages, scope), gte(gscPages.date, start)))
      .groupBy(gscPages.page),
    db
      .select({ id: auditCrawls.id })
      .from(auditCrawls)
      .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done")))
      .orderBy(desc(auditCrawls.finishedAt))
      .limit(1),
  ]);
  const clicksBy = new Map(clicks.map((c) => [bare(c.page), c.clicks]));
  const candidates = indexed.map((p) => ({ url: p.url, clicks: clicksBy.get(bare(p.url)) ?? 0 }));

  const linksIn = new Map<string, number | null>();
  if (crawl) {
    const variants = targets.flatMap((t) => [bare(t), `${bare(t)}/`]);
    const rows = await db
      .select({ url: auditPages.url, n: auditPages.internalLinksIn })
      .from(auditPages)
      .where(and(eq(auditPages.workspaceId, scope.workspaceId), eq(auditPages.crawlId, crawl.id), inArray(auditPages.url, variants)));
    for (const r of rows) linksIn.set(bare(r.url), r.n);
  }
  for (const t of targets) out.set(t, { linksIn: linksIn.get(bare(t)) ?? null, from: linkFrom(t, candidates) });
  return out;
}
