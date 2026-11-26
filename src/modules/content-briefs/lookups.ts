import "server-only";
import { and, asc, between, desc, eq, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditCrawls, auditPages, gscQueryPages } from "@/db/schema";
import { taskResults, TTL, type DfsResponse } from "@/lib/dataforseo/client";
import { isGoogleRedirect, serpTarget } from "@/lib/dataforseo/serp-target";
import { fetchErrorMessage, safeFetch } from "@/lib/web/fetch";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { gscDataRange } from "@/modules/google/data";
import { addDays } from "@/modules/google/windowing";
import { peek, pendingSpecs, type DfsSpec } from "@/modules/keywords/dfs";
import { labsCost, questionsSpec, serpSpec, keywordOverviewSpec, type Market } from "@/modules/keywords/requests";
import type { SerpResult } from "@/modules/keywords/types";
import { plainLine, pageHeadings } from "./headings";
import { topicTerms, type LinkInput } from "./links";
import type { TopPage } from "./types";

/**
 * The paid lookups behind a brief, and the free reads of the project's own data. Keyword metrics and
 * the live top 10 are the Keyword research page's own requests, so anything already looked up there
 * (or for an earlier brief) is free, unless Google hid the top pages' addresses in that top 10; a
 * brief's own top 10 is kept a week.
 */

/**
 * The live top 10 with a late-loading AI Overview asked for, kept a week. Google hides about half of
 * a page's result links behind its own redirects, and a brief can only read the top pages it has the
 * address of, so DataForSEO is asked to follow them (`resolve_goto_urls`). That adds at least 40
 * seconds and can run to 260, so the call isn't retried. A link it can't follow comes back as it was.
 * Its price is the plain top 10's (one page plus the poisoned-results check) and one more page for
 * the AI Overview.
 */
export function briefSerpSpec(keyword: string, m: Market): DfsSpec {
  const base = serpSpec(keyword, m);
  return { ...base, task: { ...base.task, load_async_ai_overview: true, resolve_goto_urls: true }, ttlSeconds: TTL.week, estUsd: base.estUsd * 1.5, retries: 0 };
}

/** Question keywords, fewer rows than the Ideas tab asks for, so cheaper. */
export const BRIEF_QUESTIONS = 50;
export function briefQuestionsSpec(keyword: string, m: Market): DfsSpec {
  const base = questionsSpec(keyword, m);
  return { ...base, task: { ...base.task, limit: BRIEF_QUESTIONS }, estUsd: labsCost(BRIEF_QUESTIONS) };
}

/** Metrics for the keywords merged into the page, in one request. */
export function mergedSpec(keywords: string[], m: Market): DfsSpec {
  const base = keywordOverviewSpec(keywords[0], m);
  return { ...base, task: { ...base.task, keywords }, estUsd: labsCost(keywords.length) };
}

export interface LookupPlan {
  overview: DfsSpec;
  merged: DfsSpec | null;
  serp: DfsSpec;
  /** Whether that top 10 asked Google for a late AI Overview. */
  serpAio: boolean;
  questions: DfsSpec;
  /** What the lookups not saved yet cost. 0 when everything is saved. */
  usd: number;
  /** Those lookups: the only ones the price covers, so the only ones a brief may buy. */
  unpaid: DfsSpec[];
}

/** Whether every one of a saved top 10's first 3 organic results has its real address, so the brief can read them all. */
function top3Readable(res: DfsResponse<SerpResult>): boolean {
  const result = taskResults(res)[0] ?? null;
  return (result?.items ?? [])
    .filter((i) => i.type === "organic")
    .slice(0, 3)
    .every((i) => !isGoogleRedirect(i.url));
}

/**
 * The cheapest set of requests. A saved question list from Keyword research is used as it is, and
 * so is its saved top 10 when Google showed the real address of each of the top 3 pages (Keyword
 * research doesn't ask DataForSEO to follow Google's redirects).
 */
export async function planLookups(keyword: string, merged: string[], m: Market, workspaceId: number): Promise<LookupPlan> {
  const aio = briefSerpSpec(keyword, m);
  const plain = serpSpec(keyword, m);
  const ideas = questionsSpec(keyword, m);
  const [aioHit, plainHit, ideasHit] = await Promise.all([peek(aio, workspaceId), peek<SerpResult>(plain, workspaceId), peek(ideas, workspaceId)]);
  const serp = aioHit || !plainHit || !top3Readable(plainHit.res) ? aio : plain;
  const plan = {
    overview: keywordOverviewSpec(keyword, m),
    merged: merged.length ? mergedSpec(merged, m) : null,
    serp,
    serpAio: serp === aio,
    questions: ideasHit ? ideas : briefQuestionsSpec(keyword, m),
  };
  const unpaid = await pendingSpecs([plan.overview, ...(plan.merged ? [plan.merged] : []), plan.serp, plan.questions], workspaceId);
  return { ...plan, usd: unpaid.reduce((sum, spec) => sum + spec.estUsd, 0), unpaid };
}

/** How long reading one competitor page may take. */
const PAGE_TIMEOUT_MS = 6000;

/** The top 3 organic results, with the headings read off each page. Free: a plain fetch of a public page. */
export async function readTop3(result: SerpResult | null): Promise<TopPage[]> {
  const organic = (result?.items ?? []).filter((i) => i.type === "organic").slice(0, 3);
  return Promise.all(
    organic.map(async (item): Promise<TopPage> => {
      const target = serpTarget(item);
      const base = { position: item.rank_group, url: target.url, domain: target.domain?.replace(/^www\./, "") ?? null, title: item.title ? plainLine(item.title) : null, headings: [] };
      if (!target.url || isGoogleRedirect(item.url)) return { ...base, read: "hidden", why: "Google hides this result's address, so the page couldn't be read." };
      try {
        const res = await safeFetch(target.url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: 1_500_000 });
        const type = String(res.headers["content-type"] ?? "");
        if (res.status !== 200) return { ...base, read: "failed", why: `The page answered with status ${res.status}.` };
        if (type && !/html/i.test(type)) return { ...base, read: "failed", why: "The page isn't HTML." };
        return { ...base, read: "read", why: null, headings: pageHeadings(res.body) };
      } catch (e) {
        return { ...base, read: "failed", why: fetchErrorMessage(e) };
      }
    }),
  );
}

const MAX_PAIRS = 3000;
const MAX_AUDIT_PAGES = 1000;

/** Search Console's last 28 days of stored data and the latest finished crawl, filtered to the topic's words. */
export async function loadLinkData(scope: ProjectScope, keyword: string): Promise<Omit<LinkInput, "keyword">> {
  const terms = topicTerms(keyword);
  if (!terms.length) return { gsc: null, audit: null };
  const like = (col: AnyPgColumn) => or(...terms.map((t) => sql`${col} ilike ${`%${t}%`}`));

  const [range, [crawl]] = await Promise.all([
    gscDataRange(scope),
    db
      .select({ id: auditCrawls.id, workspaceId: auditCrawls.workspaceId, finishedAt: auditCrawls.finishedAt })
      .from(auditCrawls)
      .where(and(inScope(auditCrawls, scope), eq(auditCrawls.status, "done")))
      .orderBy(desc(auditCrawls.finishedAt))
      .limit(1),
  ]);

  let gsc: LinkInput["gsc"] = null;
  if (range) {
    const start = addDays(range.last, -27) < range.first ? range.first : addDays(range.last, -27);
    const t = gscQueryPages;
    const rows = await db
      .select({
        query: t.query,
        page: t.page,
        clicks: sql<number>`coalesce(sum(${t.clicks}), 0)::int`,
        impressions: sql<number>`coalesce(sum(${t.impressions}), 0)::int`,
        position: sql<number>`round((sum(${t.position} * ${t.impressions}) / nullif(sum(${t.impressions}), 0))::numeric, 1)::float`,
      })
      .from(t)
      .where(and(inScope(t, scope), between(t.date, start, range.last), like(t.query)))
      .groupBy(t.query, t.page)
      .orderBy(desc(sql`sum(${t.impressions})`), asc(t.query))
      .limit(MAX_PAIRS);
    gsc = { pairs: rows.map((r) => ({ ...r, position: r.position ?? 0 })), source: { label: `Search Console, ${start} to ${range.last}`, at: null } };
  }

  let audit: LinkInput["audit"] = null;
  if (crawl) {
    const pages = await db
      .select({ url: auditPages.url, title: auditPages.title, h1: auditPages.h1, statusCode: auditPages.statusCode, indexable: auditPages.indexable, internalLinksIn: auditPages.internalLinksIn })
      .from(auditPages)
      .where(and(eq(auditPages.workspaceId, crawl.workspaceId), eq(auditPages.crawlId, crawl.id), or(like(auditPages.title), like(auditPages.h1))))
      .orderBy(desc(auditPages.internalLinksIn), asc(auditPages.url))
      .limit(MAX_AUDIT_PAGES);
    audit = { pages, source: { label: "Latest site audit crawl", at: crawl.finishedAt?.toISOString() ?? null } };
  }
  return { gsc, audit };
}
