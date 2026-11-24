import { and, count, desc, eq, inArray, ne, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditPages, fixes } from "@/db/schema";
import { ISSUES } from "@/modules/audit/taxonomy";
import { gscDataRange, queriesForPage } from "@/modules/google/data";
import { addDays } from "@/modules/google/windowing";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { canAgentFix, fixDef, fixTitle, isGscCode, isManualCode, likelyFiles, pathOf, plainIssue, proposedChange, whyItMatters, type FixKind } from "./catalog";
import { anchorDay, pageVariants } from "./measure";
import { coveredBy } from "./pairs";
import { latestResult, readStored, resultLines, resultSentence, visitsMeaning, type MeasuredFix, type ResultLine } from "./results";
import { organicVisits, type CheckpointVisits, type VisitsSource } from "./visits";

export type Fix = typeof fixes.$inferSelect;

/** Where a record came from: a crawl, Search Console, or a change someone logged (`record_change`, "Log a change"). */
export const FIX_SOURCES = ["audit", "search_console", "manual"] as const;
export type FixSource = (typeof FIX_SOURCES)[number];

export const FIX_STATUSES = ["open", "applied", "live", "measured", "resolved", "dismissed"] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

/**
 * A page folded into its similar pair (`pairs.ts`) is stored as resolved, but nothing was changed, so
 * it isn't done. It stays out of every count and tab, shows only as a line on the record that carries
 * the fix, and comes back from a list only when asked for as "covered".
 */
export const LIST_STATUSES = [...FIX_STATUSES, "covered"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
const COVERED = sql<boolean>`(${fixes.status} = 'resolved' and ${fixes.evidence} ->> 'covered_by' is not null)`;
const isCovered = (f: Pick<Fix, "status" | "evidence">) => f.status === "resolved" && coveredBy(f) !== null;

/** How urgent a finding reads: audit severity, with Search Console findings just behind errors. */
const urgency = (code: string) => (isGscCode(code) ? 0.5 : ({ error: 0, warning: 1, notice: 2 } as Record<string, number>)[ISSUES[code]?.severity ?? "notice"] ?? 2);

/** Worst first, then the pages people actually see. */
export function byPriority(a: Pick<Fix, "code" | "pageImpressions">, b: Pick<Fix, "code" | "pageImpressions">): number {
  return urgency(a.code) - urgency(b.code) || b.pageImpressions - a.pageImpressions;
}

export interface FixFilter {
  status?: ListStatus[];
  code?: string;
  source?: FixSource;
  /** Every source but this one: the Fixes page's list leaves logged changes to their own heading. */
  notSource?: FixSource;
  kind?: FixKind;
  urlContains?: string;
}

/** A filter's parts other than status and kind, in SQL. */
const filterWhere = (filter: Omit<FixFilter, "status" | "kind">) =>
  and(
    filter.code ? eq(fixes.code, filter.code) : undefined,
    filter.source ? eq(fixes.source, filter.source) : undefined,
    filter.notSource ? ne(fixes.source, filter.notSource) : undefined,
    filter.urlContains ? sql`${fixes.url} ilike ${`%${filter.urlContains}%`}` : undefined,
  );

/** `kind` comes from the catalogue, so it's applied to rows rather than in SQL. */
const ofKind = (kind: FixKind | undefined) => (f: { code: string }) => !kind || fixDef(f.code).kind === kind;

/** Fixes matching a filter, in priority order, with what a list needs. */
export async function listFixes(scope: ProjectScope, filter: FixFilter = {}, limit = 50): Promise<{ total: number; rows: Fix[] }> {
  const statuses = filter.status?.filter((s): s is FixStatus => s !== "covered") ?? [];
  const covered = filter.status?.includes("covered") ?? false;
  const where = and(inScope(fixes, scope), or(filter.status?.length ? (statuses.length ? and(inArray(fixes.status, statuses), not(COVERED)) : undefined) : not(COVERED), covered ? COVERED : undefined), filterWhere(filter));
  // The order comes from the catalogue too, so it's applied here rather than in SQL.
  const rows = await db.select().from(fixes).where(where).orderBy(desc(fixes.pageImpressions), fixes.id).limit(5_000);
  const kept = rows.filter(ofKind(filter.kind));
  return { total: kept.length, rows: [...kept].sort(byPriority).slice(0, limit) };
}

/** How many fixes are in each status, for the same filter as a list less its status. */
export async function fixCounts(scope: ProjectScope, filter: Omit<FixFilter, "status"> = {}): Promise<Record<FixStatus, number>> {
  const rows = await db
    .select({ status: fixes.status, code: fixes.code, n: count() })
    .from(fixes)
    .where(and(inScope(fixes, scope), not(COVERED), filterWhere(filter)))
    .groupBy(fixes.status, fixes.code);
  const out = Object.fromEntries(FIX_STATUSES.map((s) => [s, 0])) as Record<FixStatus, number>;
  for (const r of rows.filter(ofKind(filter.kind))) if (r.status in out) out[r.status as FixStatus] += r.n;
  return out;
}

/**
 * How many open fixes an agent can make in the code. Counted per code in SQL; `kind` comes from the
 * catalogue, so the codes are summed here. An open fix is never covered, so none needs leaving out.
 */
export async function openInCodeCount(scope: ProjectScope): Promise<number> {
  const rows = await db.select({ code: fixes.code, n: count() }).from(fixes).where(and(inScope(fixes, scope), eq(fixes.status, "open"))).groupBy(fixes.code);
  return rows.reduce((sum, r) => sum + (fixDef(r.code).kind === "code" ? r.n : 0), 0);
}

/** Changes logged without a finding (`record_change`, "Log a change"), the newest first. */
export async function loggedChanges(scope: ProjectScope, limit = 50): Promise<{ total: number; rows: Fix[] }> {
  const where = and(inScope(fixes, scope), eq(fixes.source, "manual"));
  const [total, rows] = await Promise.all([db.$count(fixes, where), db.select().from(fixes).where(where).orderBy(sql`${fixes.appliedAt} desc nulls last`, desc(fixes.id)).limit(limit)]);
  return { total, rows };
}

/**
 * The days fixes on a page went live, for a mark on its Search Console chart: each fix or logged change
 * seen live on any address the page is reported under, with its short name. Oldest first.
 */
export async function liveDaysForPage(scope: ProjectScope, url: string): Promise<{ date: string; label: string }[]> {
  const rows = await db
    .select({ code: fixes.code, detail: fixes.detail, liveAt: fixes.liveAt, appliedAt: fixes.appliedAt })
    .from(fixes)
    .where(and(inScope(fixes, scope), inArray(fixes.url, pageVariants(url)), inArray(fixes.status, ["live", "measured"]), sql`${fixes.liveAt} is not null`));
  return rows
    .map((r) => ({ date: anchorDay(r)!, label: isManualCode(r.code) && r.detail ? r.detail : fixTitle(r.code) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

/** How many pages are folded into their similar pair, for the same filter as a list less its status. */
export async function coveredCount(scope: ProjectScope, filter: Omit<FixFilter, "status"> = {}): Promise<number> {
  const rows = await db
    .select({ code: fixes.code, n: count() })
    .from(fixes)
    .where(and(inScope(fixes, scope), COVERED, filterWhere(filter)))
    .groupBy(fixes.code);
  return rows.filter(ofKind(filter.kind)).reduce((sum, r) => sum + r.n, 0);
}

/** For records on a list, the folded pages each one's fix also covers. */
export async function coveredPairs(scope: ProjectScope, urls: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!urls.length) return out;
  const by = sql<string>`${fixes.evidence} ->> 'covered_by'`;
  const rows = await db.select({ url: fixes.url, by }).from(fixes).where(and(inScope(fixes, scope), COVERED, inArray(by, urls))).orderBy(fixes.url);
  for (const r of rows) out.set(r.by, [...(out.get(r.by) ?? []), r.url]);
  return out;
}

export async function getFix(scope: ProjectScope, id: number): Promise<Fix | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(fixes).where(and(inScope(fixes, scope), eq(fixes.id, id)));
  return row ?? null;
}

export async function fixesByIds(scope: ProjectScope, ids: number[]): Promise<Fix[]> {
  if (!ids.length) return [];
  return db.select().from(fixes).where(and(inScope(fixes, scope), inArray(fixes.id, ids)));
}

/** A page as the latest finished crawl saw it. */
export async function crawledPage(scope: ProjectScope, url: string) {
  const [row] = await db
    .select({ title: auditPages.title, description: auditPages.description, h1: auditPages.h1, canonical: auditPages.canonical, statusCode: auditPages.statusCode, wordCount: auditPages.wordCount, crawledAt: auditCrawls.finishedAt })
    .from(auditPages)
    .innerJoin(auditCrawls, eq(auditCrawls.id, auditPages.crawlId))
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done"), inArray(auditPages.url, pageVariants(url))))
    .orderBy(desc(auditCrawls.finishedAt))
    .limit(1);
  return row ?? null;
}

/** The searches a page shows for over the last 28 days, so an agent writes wording people actually use. */
export async function topQueriesFor(scope: ProjectScope, url: string, limit = 15) {
  const range = await gscDataRange(scope);
  if (!range) return [];
  const current = { start: addDays(range.last, -27), end: range.last };
  const lists = await Promise.all(pageVariants(url).map((page) => queriesForPage(scope, page, current)));
  return lists
    .flat()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.position }));
}

/** One line for a list. */
export function fixSummary(f: Fix) {
  const def = fixDef(f.code);
  const latest = latestResult(f.results);
  return {
    id: f.id,
    url: f.url,
    path: pathOf(f.url),
    code: f.code,
    title: fixTitle(f.code),
    issue: plainIssue(f),
    status: isCovered(f) ? "covered" : f.status,
    ...(isCovered(f) ? { covered_by: coveredBy(f) } : {}),
    kind: def.kind,
    can_agent_fix: canAgentFix(f.code),
    source: f.source,
    impressions_28d: f.pageImpressions,
    first_seen: f.firstSeenAt.toISOString().slice(0, 10),
    // What was done and when, so an agent working through the list on a schedule doesn't do it twice.
    ...(f.appliedAt ? { applied_on: f.appliedAt.toISOString().slice(0, 10), ...(f.appliedCommit ? { applied_commit: f.appliedCommit } : {}) } : {}),
    ...(f.appliedNote ? { applied_note: f.appliedNote } : {}),
    ...(f.liveCheck ? { live_check: f.liveCheck.state } : {}),
    latest_result: latest ? resultSentence(readStored(latest), latest.days) : null,
  };
}

/**
 * `page_now` is the latest crawl, which can predate the change: SEOpen keeps no copy of the live page.
 * When a fetch of the live page (not a crawl, whose checks carry no status) found the change after that
 * crawl, it says so rather than pass the old title off as the page now.
 */
function crawlBehindNote(f: Pick<Fix, "liveCheck">, crawledAt: Date | null): { note?: string } {
  const check = f.liveCheck;
  if (!crawledAt || check?.state !== "fixed" || check.status === null || new Date(check.checkedAt) <= crawledAt) return {};
  return { note: `This is the page as the site audit on ${crawledAt.toISOString().slice(0, 10)} saw it. The live check on ${check.checkedAt.slice(0, 10)} found the change, so the live page differs. The next site audit brings this up to date.` };
}

/** Everything an agent needs to make the change. */
export async function fixDetail(scope: ProjectScope, f: Fix, opts: { showResults: boolean }) {
  const [page, queries, visits] = await Promise.all([crawledPage(scope, f.url), topQueriesFor(scope, f.url), opts.showResults ? organicVisits(scope, [f]) : null]);
  return {
    ...fixSummary(f),
    why_it_matters: whyItMatters(f.code),
    proposed_change: proposedChange(f.code, f.url),
    expected_effect: fixDef(f.code).effect,
    detail: f.detail,
    evidence: f.evidence,
    page_now: page ? { title: page.title, description: page.description, h1: page.h1, canonical: page.canonical, status: page.statusCode, words: page.wordCount, crawled_at: page.crawledAt?.toISOString() ?? null, ...crawlBehindNote(f, page.crawledAt) } : null,
    search_console: { top_queries: queries },
    likely_files: likelyFiles(f.code, f.url),
    applied: f.appliedAt ? { at: f.appliedAt.toISOString(), via: f.appliedVia, commit: f.appliedCommit, note: f.appliedNote, files: f.appliedFiles } : null,
    live: f.liveCheck ? { state: f.liveCheck.state, saw: f.liveCheck.saw, checked_at: f.liveCheck.checkedAt, live_at: f.liveAt?.toISOString() ?? null } : null,
    google_recrawled_at: f.recrawledAt?.toISOString() ?? null,
    results: opts.showResults ? resultView(f, visits?.visits.get(f.id), visits?.source) : undefined,
    results_note: opts.showResults ? undefined : "Before and after reports at 7, 14 and 28 days are on the Starter plan and up. They're already being measured, so upgrading shows them straight away.",
  };
}

/** Each checkpoint measured so far, in words and numbers, with Plausible's or Umami's visits when the project reads from one (`plausible_visits` or `umami_visits`). */
export function resultView(f: Pick<Fix, "results">, visits?: Record<string, CheckpointVisits>, source: VisitsSource = "plausible") {
  return Object.values(f.results ?? {})
    .sort((a, b) => a.days - b.days)
    .map((r) => {
      const reading = readStored(r);
      return { days: r.days, sentence: resultSentence(reading, r.days), direction: reading.direction, change_percent: reading.change, metric: reading.metric, before: r.before, after: r.after, site_change_percent: reading.siteChange, ...(visits?.[String(r.days)] ? { [`${source}_visits`]: { ...visits[String(r.days)], counts: visitsMeaning(source) } } : {}) };
    });
}

/** Fixes with at least one checkpoint measured. */
export async function measuredFixes(scope: ProjectScope): Promise<MeasuredFix[]> {
  const rows = await db.select({ id: fixes.id, code: fixes.code, url: fixes.url, results: fixes.results, liveAt: fixes.liveAt, appliedAt: fixes.appliedAt }).from(fixes).where(and(inScope(fixes, scope), inArray(fixes.status, ["applied", "live", "measured"]), sql`${fixes.results} is not null`));
  const out: MeasuredFix[] = [];
  for (const r of rows) {
    const liveDay = anchorDay(r);
    if (liveDay) out.push({ id: r.id, code: r.code, url: r.url, results: r.results, liveDay });
  }
  return out;
}

/** "Fixed 12 titles on Nov 18. Clicks up 18% in 14 days.", newest first. */
export async function fixResultLines(scope: ProjectScope): Promise<ResultLine[]> {
  return resultLines(await measuredFixes(scope));
}
