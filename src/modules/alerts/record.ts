import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { alertRules, alerts, auditCrawls, auditIssues, gscPages, projects, rankKeywords, rankResults, rankRuns } from "@/db/schema";
import { chartDay } from "@/components/ui/module-card";
import { addDays } from "@/modules/google/windowing";
import type { ProjectScope } from "@/lib/workspace";
import { readAccessReport, type AccessReport } from "@/modules/audit/access";
import { botBlocked, leftTop10, pageBroken, pageKey, type AccessSide, type Detected, type RankRow } from "./detect";
import { ALERT_RULES, RULES, type AlertRule } from "./rules";

/**
 * Where the rules run: when a crawl is imported (page-broken, bot-blocked) and when a rank check
 * closes (left-top-10). Both read data that's already stored, never the customer's site. A rule a
 * project turned off records nothing and closes nothing.
 */

/** Days of Search Console data that count a page as clicked: the 28 ending on the newest stored day. */
export const CLICK_DAYS = 28;
/** How far back a keyword's previous confirmed result may be to compare with. */
const RANK_LOOKBACK_DAYS = 14;

/** Each rule and whether it's on for the project, in `ALERT_RULES` order. */
export async function ruleStates(scope: ProjectScope): Promise<{ rule: AlertRule; enabled: boolean }[]> {
  const rows = await db
    .select({ rule: alertRules.rule, enabled: alertRules.enabled })
    .from(alertRules)
    .where(and(eq(alertRules.workspaceId, scope.workspaceId), eq(alertRules.projectId, scope.projectId)));
  const set = new Map(rows.map((r) => [r.rule, r.enabled]));
  return ALERT_RULES.map((rule) => ({ rule, enabled: set.get(rule) ?? true }));
}

export async function enabledRules(scope: ProjectScope): Promise<Set<AlertRule>> {
  return new Set((await ruleStates(scope)).filter((r) => r.enabled).map((r) => r.rule));
}

/** Opens an alert for each new finding (one already open for the key stays as it is) and closes the open ones the check saw fine. Returns how many opened. */
export async function applyDetected(scope: ProjectScope, rule: AlertRule, detected: Detected, now = new Date()): Promise<number> {
  let opened = 0;
  if (detected.findings.length) {
    const rows = await db
      .insert(alerts)
      .values(detected.findings.map((f) => ({ ...scope, rule, key: f.key, title: f.title, detail: f.detail, screen: f.screen, source: RULES[rule].source, detectedAt: now })))
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    opened = rows.length;
  }
  if (detected.fine.length) {
    await db
      .update(alerts)
      .set({ resolvedAt: now })
      .where(and(eq(alerts.workspaceId, scope.workspaceId), eq(alerts.projectId, scope.projectId), eq(alerts.rule, rule), isNull(alerts.resolvedAt), inArray(alerts.key, detected.fine)));
  }
  return opened;
}

/** Search Console clicks per page (by `pageKey`) over the newest CLICK_DAYS stored days. Empty without Search Console data. */
export async function clickedPages(scope: ProjectScope): Promise<Map<string, number>> {
  const where = and(eq(gscPages.workspaceId, scope.workspaceId), eq(gscPages.projectId, scope.projectId));
  const [latest] = await db.select({ day: sql<string | null>`max(${gscPages.date})` }).from(gscPages).where(where);
  if (!latest?.day) return new Map();
  const rows = await db
    .select({ page: gscPages.page, clicks: sql<number>`sum(${gscPages.clicks})::int` })
    .from(gscPages)
    .where(and(where, gte(gscPages.date, addDays(latest.day, -(CLICK_DAYS - 1)))))
    .groupBy(gscPages.page)
    .having(sql`sum(${gscPages.clicks}) > 0`);
  const out = new Map<string, number>();
  for (const r of rows) out.set(pageKey(r.page), (out.get(pageKey(r.page)) ?? 0) + r.clicks);
  return out;
}

async function blockedIssues(workspaceId: number, crawlId: number) {
  return db
    .select({ url: auditIssues.url, detail: auditIssues.detail })
    .from(auditIssues)
    .where(and(eq(auditIssues.workspaceId, workspaceId), eq(auditIssues.crawlId, crawlId), eq(auditIssues.code, "search-bot-blocked")));
}

/** The finished crawl before this one, with its access report and blocked pages. */
async function previousAccess(scope: ProjectScope, crawlId: number): Promise<AccessSide | null> {
  const [prev] = await db
    .select({ id: auditCrawls.id, summary: auditCrawls.summary })
    .from(auditCrawls)
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done"), lt(auditCrawls.id, crawlId)))
    .orderBy(desc(auditCrawls.id))
    .limit(1);
  if (!prev) return null;
  return { report: readAccessReport(prev.summary), blocked: await blockedIssues(scope.workspaceId, prev.id) };
}

export interface CrawlAlertInput {
  crawl: ProjectScope & { id: number };
  pages: { url: string; statusCode: number | null }[];
  nonIndexable: { url: string; reason: string | null }[];
  issues: { code: string; url: string; detail?: string | null }[];
  report: AccessReport | null;
}

/** Runs page-broken and bot-blocked on a crawl that just finished importing. Returns how many urgent alerts opened. */
export async function alertsFromCrawl(input: CrawlAlertInput, now = new Date()): Promise<number> {
  const scope = { workspaceId: input.crawl.workspaceId, projectId: input.crawl.projectId };
  const on = await enabledRules(scope);
  let opened = 0;
  if (on.has("page-broken")) {
    const clicked = await clickedPages(scope);
    if (clicked.size) opened += await applyDetected(scope, "page-broken", pageBroken({ crawlId: input.crawl.id, clicked, pages: input.pages, nonIndexable: input.nonIndexable }), now);
  }
  if (on.has("bot-blocked")) {
    const current: AccessSide = { report: input.report, blocked: input.issues.filter((i) => i.code === "search-bot-blocked").map((i) => ({ url: i.url, detail: i.detail ?? null })) };
    const previous = await previousAccess(scope, input.crawl.id);
    opened += await applyDetected(scope, "bot-blocked", botBlocked({ crawlId: input.crawl.id, current, previous }), now);
  }
  return opened;
}

/** Runs left-top-10 on a rank check that just closed. Returns how many alerts opened. */
export async function alertsFromRun(runId: number, now = new Date()): Promise<number> {
  const [run] = await db
    .select({ workspaceId: rankRuns.workspaceId, projectId: rankRuns.projectId, date: rankRuns.date, status: rankRuns.status, projectLocation: projects.locationCode })
    .from(rankRuns)
    .innerJoin(projects, and(eq(projects.id, rankRuns.projectId), eq(projects.workspaceId, rankRuns.workspaceId)))
    .where(eq(rankRuns.id, runId));
  if (!run || run.status !== "done") return 0;
  const scope = { workspaceId: run.workspaceId, projectId: run.projectId };
  if (!(await enabledRules(scope)).has("left-top-10")) return 0;
  const current = await db
    .select({ keywordId: rankResults.keywordId, keyword: rankKeywords.keyword, locationCode: rankResults.locationCode, position: rankResults.position, depth: rankResults.depth, notChecked: rankResults.notChecked, date: rankResults.date })
    .from(rankResults)
    .innerJoin(rankKeywords, eq(rankKeywords.id, rankResults.keywordId))
    .where(and(eq(rankResults.workspaceId, scope.workspaceId), eq(rankResults.projectId, scope.projectId), eq(rankResults.runId, runId), eq(rankKeywords.active, true)));
  if (!current.length) return 0;
  const place = (code: number | null) => code ?? run.projectLocation;
  const earlier = await db
    .select({ keywordId: rankResults.keywordId, locationCode: rankResults.locationCode, position: rankResults.position, date: rankResults.date })
    .from(rankResults)
    .where(
      and(
        eq(rankResults.workspaceId, scope.workspaceId),
        eq(rankResults.projectId, scope.projectId),
        inArray(rankResults.keywordId, current.map((c) => c.keywordId)),
        lt(rankResults.date, run.date),
        gte(rankResults.date, addDays(run.date, -RANK_LOOKBACK_DAYS)),
        eq(rankResults.notChecked, false),
      ),
    )
    .orderBy(desc(rankResults.date));
  const latestBefore = new Map<string, { position: number | null; date: string }>();
  for (const e of earlier) {
    const k = `${e.keywordId}:${place(e.locationCode)}`;
    if (!latestBefore.has(k)) latestBefore.set(k, { position: e.position, date: e.date });
  }
  const rows: RankRow[] = current.map((c) => ({
    keywordId: c.keywordId,
    keyword: c.keyword,
    locationCode: place(c.locationCode),
    position: c.position,
    depth: c.depth,
    notChecked: c.notChecked,
    previous: latestBefore.get(`${c.keywordId}:${place(c.locationCode)}`) ?? null,
  }));
  return applyDetected(scope, "left-top-10", leftTop10(rows, chartDay), now);
}
