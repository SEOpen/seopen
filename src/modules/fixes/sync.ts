import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditCrawls, auditIssues, auditPages, auditResources, fixes, indexingPages } from "@/db/schema";
import { ISSUES } from "@/modules/audit/taxonomy";
import { gscByPage, gscDataRange, gscPagesPastPosition, gscPagesSincePrevious, gscQueryPagePairs, gscStrikingPages, gscTotals } from "@/modules/google/data";
import { isLikelyBotQuery } from "@/modules/google/bot-queries";
import { declining, lowCtr, searchedPairs, SHOWN_MIN_IMPRESSIONS, SHOWN_PAST_POSITION, shownNotRanking, sitelinkPages, splitQueries, splitRecords } from "@/modules/google/insights";
import { pageKey } from "@/modules/google/matching";
import { addDays } from "@/modules/google/windowing";
import { indexStatus, type IndexStatus } from "@/modules/indexing/state";
import { inScope, projectScope, type ProjectScope } from "@/lib/workspace";
import { TRACKED_AUDIT_CODES } from "./catalog";
import { onProjectDomain } from "./domain";
import { coveredBy, foldPairs } from "./pairs";
import { wrongPageTypes, wrongTypeEvidence } from "./wrong-page-type";

/**
 * Keeps the fix records in step with what the audit and Search Console currently find. The rules:
 * - A finding seen again updates its record, and never makes a second one.
 * - An audit finding only goes away if this crawl looked at its page: a smaller crawl proves nothing.
 * - An applied fix the crawl no longer finds is live. A live fix a later crawl finds again reopens.
 * - A dismissed fix stays dismissed.
 * - Two pages that are each other's closest match for similar content are one fix (`pairs.ts`). The
 *   other page's record, if it has one, settles as resolved and says which record carries the pair.
 * - Search Console reads 28 days, so a fixed page keeps its old numbers for weeks. Those findings
 *   only reopen once the 28-day result is in.
 * - For the same reason, a page whose logged change (`record_change`) is waiting to go live or being
 *   measured gets no new Search Console record, and its open ones are covered by the change until
 *   its result is in. `record_change` refuses another change there too.
 */

const CHUNK = 400;
/** How many new records a Search Console finding can add at once, so a big site's list stays readable. */
const NEW_LOW_CTR = 25;
const NEW_LOSING = 15;
const NEW_STRIKING = 20;
/** Close pages still counted as flagged, so an open record below the new-record cutoff stays open. */
const STRIKING_KEPT = 200;
const NEW_SPLIT = 15;
const SPLIT_KEPT = 200;
const NEW_SHOWN = 15;
const SHOWN_KEPT = 200;
const NEW_WRONG_TYPE = 10;
const WRONG_TYPE_KEPT = 100;
/** Searches or pages a Search Console record lists in its evidence. */
const EVIDENCE_LISTED = 5;
const WINDOW_DAYS = 28;

export interface Finding {
  code: string;
  url: string;
  detail?: string | null;
  evidence?: Record<string, unknown> | null;
  pageImpressions: number;
}

/** A page's impressions over the last 28 days, keyed by `pageKey` so http, www and a trailing slash all match. */
export async function impressionsByPage(scope: ProjectScope): Promise<Map<string, number>> {
  const range = await gscDataRange(scope);
  if (!range) return new Map();
  const rows = await gscByPage(scope, { start: addDays(range.last, 1 - WINDOW_DAYS), end: range.last }, null, { limit: 5_000 });
  const out = new Map<string, number>();
  for (const r of rows) out.set(pageKey(r.key), (out.get(pageKey(r.key)) ?? 0) + r.impressions);
  return out;
}

async function upsertFindings(scope: ProjectScope, source: "audit" | "search_console", findings: Finding[], status: SQL, extra: { lastSeenCrawlId?: number; now: Date; resetWhenReopened: SQL<boolean> }) {
  const reopen = extra.resetWhenReopened;
  for (let i = 0; i < findings.length; i += CHUNK) {
    await db
      .insert(fixes)
      .values(findings.slice(i, i + CHUNK).map((f) => ({ ...scope, source, code: f.code, url: f.url, detail: f.detail ?? null, evidence: f.evidence ?? null, pageImpressions: f.pageImpressions, lastSeenCrawlId: extra.lastSeenCrawlId ?? null, firstSeenAt: extra.now, lastSeenAt: extra.now, updatedAt: extra.now })))
      .onConflictDoUpdate({
        target: [fixes.projectId, fixes.source, fixes.code, fixes.url],
        set: {
          detail: sql`excluded.detail`,
          evidence: sql`excluded.evidence`,
          pageImpressions: sql`excluded.page_impressions`,
          lastSeenCrawlId: sql`coalesce(excluded.last_seen_crawl_id, ${fixes.lastSeenCrawlId})`,
          lastSeenAt: extra.now,
          updatedAt: extra.now,
          status,
          reopenedAt: sql`case when ${reopen} then ${extra.now.toISOString()}::timestamptz else ${fixes.reopenedAt} end`,
          // A reopened fix starts over: its old results describe a change that didn't hold.
          liveAt: sql`case when ${reopen} then null else ${fixes.liveAt} end`,
          liveCheck: sql`case when ${reopen} then null else ${fixes.liveCheck} end`,
          recrawledAt: sql`case when ${reopen} then null else ${fixes.recrawledAt} end`,
          results: sql`case when ${reopen} then null else ${fixes.results} end`,
          appliedAt: sql`case when ${reopen} then null else ${fixes.appliedAt} end`,
          resolvedAt: sql`case when ${fixes.status} = 'resolved' then null else ${fixes.resolvedAt} end`,
        },
      });
  }
}

/**
 * Called when a crawl finishes importing. `crawledUrls` are the pages and files this crawl looked at.
 * Takes the crawl's start, because a crawl that began before a fix went live can't speak to it.
 *
 * Only the crawled site (`target`, with or without www, and its subdomains) makes fixes. A crawl's
 * pages stay on it, but the files they load don't: a real crawl of one site flagged a script on
 * a site builder's cdn.builder.example as a broken resource. Site audit still lists those; they just aren't the
 * project's to fix. An off-site record an earlier sync made goes, unless someone acted on it.
 */
export async function syncAuditFixes(crawl: { id: number; workspaceId: number; projectId: number; target: string; createdAt: Date; startedAt: Date | null }, issues: { code: string; url: string; detail: string | null }[], crawledUrls: Iterable<string>): Promise<{ found: number; gone: number }> {
  const scope = projectScope({ id: crawl.projectId, workspaceId: crawl.workspaceId });
  const now = new Date();
  const started = (crawl.startedAt ?? crawl.createdAt).toISOString();
  const onSite = (url: string) => onProjectDomain(url, crawl.target);
  const impressions = await impressionsByPage(scope);
  const tracked = issues
    .filter((i) => TRACKED_AUDIT_CODES.has(i.code) && onSite(i.url))
    .map((i): Finding => ({ code: i.code, url: i.url, detail: i.detail, pageImpressions: impressions.get(pageKey(i.url)) ?? 0 }));
  const similarUrls = tracked.filter((f) => f.code === "duplicate-content").map((f) => f.url);
  const pairRecords = similarUrls.length
    ? await db.select({ id: fixes.id, url: fixes.url, status: fixes.status }).from(fixes).where(and(inScope(fixes, scope), eq(fixes.source, "audit"), eq(fixes.code, "duplicate-content"), inArray(fixes.url, similarUrls)))
    : [];
  const { keep: found, covered } = foldPairs(tracked, pairRecords);

  // A fix the live check couldn't confirm is measured from the day it was applied and has no live date.
  const reopen = sql<boolean>`${fixes.status} in ('live', 'measured') and coalesce(${fixes.liveAt}, ${fixes.appliedAt}) < ${started}::timestamptz`;
  const status = sql`case when ${fixes.status} = 'resolved' or (${reopen}) then 'open' else ${fixes.status} end`;
  await upsertFindings(scope, "audit", found, status, { lastSeenCrawlId: crawl.id, now, resetWhenReopened: reopen });

  const stillFound = new Set(found.map((f) => `${f.code}\u0000${f.url}`));
  const crawled = new Set(crawledUrls);
  const existing = await db
    .select({ id: fixes.id, code: fixes.code, url: fixes.url, status: fixes.status })
    .from(fixes)
    .where(and(inScope(fixes, scope), eq(fixes.source, "audit"), inArray(fixes.status, ["open", "applied"])));
  const offSite = existing.filter((f) => f.status === "open" && !onSite(f.url)).map((f) => f.id);
  if (offSite.length) await db.delete(fixes).where(and(inScope(fixes, scope), inArray(fixes.id, offSite)));
  // An applied record off the site is left as it is: this crawl's silence about it says nothing.
  const gone = existing.filter((f) => onSite(f.url) && !stillFound.has(`${f.code}\u0000${f.url}`) && (ISSUES[f.code]?.site || crawled.has(f.url)));
  const folded = (f: { code: string; url: string }) => f.code === "duplicate-content" && covered.has(f.url);
  for (const f of gone.filter((f) => folded(f) && f.status === "open")) {
    await db.update(fixes).set({ status: "resolved", resolvedAt: now, evidence: { covered_by: covered.get(f.url) }, updatedAt: now }).where(and(inScope(fixes, scope), eq(fixes.id, f.id)));
  }
  // A folded record is never one someone applied (`foldPairs` keeps that one), but it mustn't read as live if it were.
  const ids = (status: string) => gone.filter((f) => f.status === status && !folded(f)).map((f) => f.id);
  if (ids("open").length) await db.update(fixes).set({ status: "resolved", resolvedAt: now, updatedAt: now }).where(and(inScope(fixes, scope), inArray(fixes.id, ids("open"))));
  if (ids("applied").length) {
    const liveCheck = { state: "fixed" as const, saw: "The latest crawl no longer finds this.", checkedAt: now.toISOString(), status: null };
    await db.update(fixes).set({ status: "live", liveAt: now, liveCheck, updatedAt: now }).where(and(inScope(fixes, scope), inArray(fixes.id, ids("applied"))));
  }
  return { found: found.length, gone: gone.length };
}

/**
 * Brings the list up to the latest finished audit, from what that audit stored, so it costs nothing.
 * For audits that finished before the list existed, and for a sync that failed when its crawl ended.
 */
export async function catchUpAuditFixes(scope: ProjectScope) {
  const [crawl] = await db
    .select({ id: auditCrawls.id, workspaceId: auditCrawls.workspaceId, projectId: auditCrawls.projectId, target: auditCrawls.target, createdAt: auditCrawls.createdAt, startedAt: auditCrawls.startedAt })
    .from(auditCrawls)
    .where(and(inScope(auditCrawls, scope), eq(auditCrawls.status, "done")))
    .orderBy(desc(auditCrawls.id))
    .limit(1);
  if (!crawl) return null;
  const [seen] = await db
    .select({ id: fixes.id })
    .from(fixes)
    .where(and(inScope(fixes, scope), eq(fixes.source, "audit"), eq(fixes.lastSeenCrawlId, crawl.id)))
    .limit(1);
  if (seen) return null;
  const inCrawl = <T extends { workspaceId: PgColumn; crawlId: PgColumn }>(t: T) => and(eq(t.workspaceId, scope.workspaceId), eq(t.crawlId, crawl.id));
  const [issues, pages, resources] = await Promise.all([
    db.select({ code: auditIssues.code, url: auditIssues.url, detail: auditIssues.detail }).from(auditIssues).where(inCrawl(auditIssues)),
    db.select({ url: auditPages.url }).from(auditPages).where(inCrawl(auditPages)),
    db.select({ url: auditResources.url }).from(auditResources).where(inCrawl(auditResources)),
  ]);
  return syncAuditFixes(crawl, issues, [...pages, ...resources].map((p) => p.url));
}

/**
 * The sitemap pages Google hasn't indexed for a reason on the site: blocked, a duplicate it wasn't meant
 * to be, or another reason. They come from the Indexing module's rows, which the worker's daily runs and
 * every one-off inspection keep current, so a URL outside the sitemap never gets a fix and an indexed
 * page's fix goes away at the next sync. A page Google simply hasn't got to yet (`waiting`) has nothing
 * to change: it's on the Indexing page's Request indexing list instead. "Alternate page with proper
 * canonical tag" is the canonical working as meant.
 */
export async function pagesToFixForIndexing(scope: ProjectScope) {
  const rows = await db
    .select({
      url: indexingPages.url,
      inspectedAt: indexingPages.inspectedAt,
      verdict: indexingPages.verdict,
      coverageState: indexingPages.coverageState,
      robotsTxtState: indexingPages.robotsTxtState,
      indexingState: indexingPages.indexingState,
      pageFetchState: indexingPages.pageFetchState,
    })
    .from(indexingPages)
    .where(and(inScope(indexingPages, scope), isNotNull(indexingPages.inspectedAt)));
  return rows.flatMap((r) => {
    const status = indexStatus(r);
    if (!r.inspectedAt || !FIX_STATUSES.includes(status)) return [];
    if (/alternate page with proper canonical/i.test(r.coverageState ?? "")) return [];
    return [{ ...r, inspectedAt: r.inspectedAt, status }];
  });
}

const FIX_STATUSES: IndexStatus[] = ["blocked", "duplicate", "other"];

/** What Search Console says is worth fixing now. `keepAll` holds every page still flagged; `add` is the ones worth a new record. */
export async function searchConsoleFindings(scope: ProjectScope): Promise<{ keepAll: Finding[]; add: Set<string> } | null> {
  const range = await gscDataRange(scope);
  if (!range) return null;
  const current = { start: addDays(range.last, 1 - WINDOW_DAYS), end: range.last };
  const previous = { start: addDays(range.last, 1 - 2 * WINDOW_DAYS), end: addDays(range.last, -WINDOW_DAYS) };
  const [pages, falling, close, unindexed] = await Promise.all([
    gscByPage(scope, current, null, { limit: 5_000 }),
    gscPagesSincePrevious(scope, current, previous, 10),
    gscStrikingPages(scope, current),
    pagesToFixForIndexing(scope),
  ]);
  const impressions = new Map(pages.map((p) => [p.key, p.impressions]));
  // Searches and pages a finding should leave out: rank checkers' searches, and rows that are sitelinks under another result.
  const [{ pairs: allPairs }, site, past] = await Promise.all([gscQueryPagePairs(scope, current), gscTotals(scope, current), gscPagesPastPosition(scope, current, SHOWN_PAST_POSITION, SHOWN_MIN_IMPRESSIONS)]);
  const pairs = searchedPairs(allPairs);
  const sitelinks = sitelinkPages(allPairs.filter((p) => !isLikelyBotQuery(p.query)));
  const out: Finding[] = [];
  const add = new Set<string>();
  const key = (code: string, url: string) => `${code}\u0000${url}`;

  lowCtr(pages.filter((p) => !sitelinks.has(p.key))).forEach((p, i) => {
    out.push({ code: "gsc-low-ctr", url: p.key, pageImpressions: p.impressions, evidence: { impressions: p.impressions, clicks: p.clicks, ctr: p.ctr, position: p.position, expected_ctr: p.expectedCtr, missed_clicks: p.missedClicks } });
    if (i < NEW_LOW_CTR) add.add(key("gsc-low-ctr", p.key));
  });

  declining(falling.filter((p) => !sitelinks.has(p.key))).forEach((p, i) => {
    out.push({ code: "gsc-losing-clicks", url: p.key, pageImpressions: p.impressions, evidence: { clicks: p.clicks, previous_clicks: p.prevClicks, position: p.position, previous_position: p.prevPosition } });
    if (i < NEW_LOSING) add.add(key("gsc-losing-clicks", p.key));
  });

  // The same pages, scores and order as Opportunities' Group by page, so a fix names the searches behind it.
  close.pages.slice(0, STRIKING_KEPT).forEach((p, i) => {
    const queries = p.list.slice(0, 5).map((q) => ({ query: q.query, position: q.position, impressions: q.impressions }));
    out.push({ code: "gsc-striking-distance", url: p.page, pageImpressions: impressions.get(p.page) ?? 0, evidence: { queries, searches_in_range: p.queries, impressions: p.impressions, score: p.score, period: current } });
    if (i < NEW_STRIKING) add.add(key("gsc-striking-distance", p.page));
  });

  // Sitemap pages whose latest answer from Google says something on the site stops them.
  for (const r of unindexed) {
    out.push({ code: "gsc-not-indexed", url: r.url, pageImpressions: impressions.get(r.url) ?? 0, evidence: { coverage: r.coverageState, robots: r.robotsTxtState, verdict: r.verdict, status: r.status, inspected_at: r.inspectedAt.toISOString() } });
    add.add(key("gsc-not-indexed", r.url));
  }

  // One search on two or more pages. Rankings' Cannibalization reads tracked keywords' results pages
  // and makes no fixes, so this is the only fix for it, and it reads every search Search Console has.
  splitRecords(splitQueries(pairs, site.impressions, pageKey), pageKey)
    .slice(0, SPLIT_KEPT)
    .forEach((r, i) => {
      const queries = r.queries.slice(0, EVIDENCE_LISTED).map((q) => ({ query: q.query, impressions: q.impressions, pages: q.pages.map((p) => ({ page: p.page, impressions: p.impressions, clicks: p.clicks, position: p.position })) }));
      out.push({ code: "gsc-split-query", url: r.page, pageImpressions: impressions.get(r.page) ?? r.impressions, evidence: { queries, searches_split: r.queries.length, impressions: r.impressions, period: current } });
      if (i < NEW_SPLIT) add.add(key("gsc-split-query", r.page));
    });

  // Shown often, far down. The searches behind each come from the same pairs, most impressions first.
  const far = shownNotRanking(past.filter((p) => !sitelinks.has(p.key)), site.impressions).slice(0, SHOWN_KEPT);
  const behind = new Map<string, { query: string; impressions: number; position: number }[]>(far.map((p) => [p.key, []]));
  for (const q of pairs) {
    const list = behind.get(q.page);
    if (list && list.length < EVIDENCE_LISTED) list.push({ query: q.query, impressions: q.impressions, position: q.position });
  }
  far.forEach((p, i) => {
    out.push({ code: "gsc-shown-not-ranking", url: p.key, pageImpressions: p.impressions, evidence: { impressions: p.impressions, clicks: p.clicks, position: p.position, queries: behind.get(p.key) ?? [], period: current } });
    if (i < NEW_SHOWN) add.add(key("gsc-shown-not-ranking", p.key));
  });

  // A search Google answers with a different kind of page, from saved results only: this spends nothing.
  (await wrongPageTypes(scope, pairs, site.impressions, current)).slice(0, WRONG_TYPE_KEPT).forEach((r, i) => {
    out.push({ code: "gsc-wrong-page-type", url: r.page, pageImpressions: impressions.get(r.page) ?? r.impressions, evidence: wrongTypeEvidence(r, current) });
    if (i < NEW_WRONG_TYPE) add.add(key("gsc-wrong-page-type", r.page));
  });
  return { keepAll: out, add };
}

/**
 * Brings audit records and logged changes up to the page's latest 28 days. Neither is rewritten by the
 * Search Console sync: an audit record took its number when its crawl finished, and a logged change
 * started at 0, so both fell behind the page's real impressions. Search Console records take
 * theirs from the finding each sync.
 */
export async function refreshPageImpressions(scope: ProjectScope): Promise<{ updated: number }> {
  if (!(await gscDataRange(scope))) return { updated: 0 };
  const impressions = await impressionsByPage(scope);
  const rows = await db.select({ id: fixes.id, url: fixes.url, pageImpressions: fixes.pageImpressions }).from(fixes).where(and(inScope(fixes, scope), inArray(fixes.source, ["audit", "manual"])));
  const byValue = new Map<number, number[]>();
  for (const r of rows) {
    const n = impressions.get(pageKey(r.url)) ?? 0;
    if (n !== r.pageImpressions) byValue.set(n, [...(byValue.get(n) ?? []), r.id]);
  }
  for (const [n, ids] of byValue) {
    for (let i = 0; i < ids.length; i += CHUNK) await db.update(fixes).set({ pageImpressions: n }).where(and(inScope(fixes, scope), inArray(fixes.id, ids.slice(i, i + CHUNK))));
  }
  return { updated: [...byValue.values()].reduce((sum, ids) => sum + ids.length, 0) };
}

/** A logged change in these states is still to go live or being measured, the same ones `record_change` refuses another change on. */
const CHANGE_IN_PROGRESS = ["applied", "live"];
/** Statuses the upsert would leave on the list or put back on it. */
const LISTED = ["open", "resolved", "measured"];

export async function syncSearchConsoleFixes(scope: ProjectScope): Promise<{ found: number; gone: number }> {
  const now = new Date();
  const findings = await searchConsoleFindings(scope);
  if (!findings) return { found: 0, gone: 0 };
  const existing = await db.select({ id: fixes.id, code: fixes.code, url: fixes.url, status: fixes.status, evidence: fixes.evidence }).from(fixes).where(and(inScope(fixes, scope), eq(fixes.source, "search_console")));
  const key = (f: { code: string; url: string }) => `${f.code}\u0000${f.url}`;
  const byKey = new Map(existing.map((f) => [key(f), f]));

  // The page each in-progress logged change is on, under any of its addresses.
  const changes = await db.select({ url: fixes.url }).from(fixes).where(and(inScope(fixes, scope), eq(fixes.source, "manual"), inArray(fixes.status, CHANGE_IN_PROGRESS)));
  const changed = new Map(changes.map((c) => [pageKey(c.url), c.url]));
  const changeOn = (url: string) => changed.get(pageKey(url));
  // A record someone is acting on (applied, live) or dismissed keeps being updated: its status doesn't change.
  const held = (f: Finding) => !!changeOn(f.url) && LISTED.includes(byKey.get(key(f))?.status ?? "open");
  const keep = findings.keepAll.filter((f) => (byKey.has(key(f)) || findings.add.has(key(f))) && !held(f));

  const reopen = sql<boolean>`${fixes.status} = 'measured'`;
  const status = sql`case when ${fixes.status} in ('resolved', 'measured') then 'open' else ${fixes.status} end`;
  await upsertFindings(scope, "search_console", keep, status, { now, resetWhenReopened: reopen });

  // Covered by the change, as a folded similar pair is: off the list, and back by itself once the page is free and still flagged.
  for (const f of existing.filter((f) => f.status === "open" && changeOn(f.url))) {
    await db.update(fixes).set({ status: "resolved", resolvedAt: now, evidence: { ...(f.evidence ?? {}), covered_by: changeOn(f.url) }, updatedAt: now }).where(and(inScope(fixes, scope), eq(fixes.id, f.id)));
  }

  // Below the new-record cutoff still counts as flagged: only a page that stopped being flagged goes away.
  // A covered one whose page is free again and no longer flagged goes the same way.
  const flagged = new Set(findings.keepAll.map(key));
  const gone = existing.filter((f) => !changeOn(f.url) && !flagged.has(key(f)) && (f.status === "open" || (f.status === "resolved" && coveredBy(f) !== null))).map((f) => f.id);
  if (gone.length) await db.update(fixes).set({ status: "resolved", resolvedAt: now, evidence: sql`${fixes.evidence} - 'covered_by'`, updatedAt: now }).where(and(inScope(fixes, scope), inArray(fixes.id, gone)));
  return { found: keep.length, gone: gone.length };
}

