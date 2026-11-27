import { and, asc, eq, or, sql } from "drizzle-orm";
import { isValidElement, type ReactNode } from "react";
import { loadFailures, withFailures, withTimeout } from "@/app/(app)/dashboard-load";
import { DASHBOARD_MODULES } from "@/app/(app)/dashboard-modules";
import { describeChange, shownChange, type AnyDashboardModule, type KpiChange } from "@/components/ui/module-card";
import { pickHighlights, type Highlight } from "@/components/ui/what-changed";
import { db } from "@/db";
import { apiKeys, competitors, projects, workspaces } from "@/db/schema";
import { AI_ASSISTANT_NAMES } from "@/lib/ai-referrers";
import { creditsFor, isInternal, withEndedGrant } from "@/lib/billing/gates";
import { spendBlock, usageSummary } from "@/lib/billing/spend";
import { rules } from "@/plan-policy/rules";
import { failureLine, needsLookSentence, newerFailed, type CheckFailure } from "@/lib/check-failure";
import { plainNextStep } from "@/lib/dataforseo/failure-copy";
import { locationName, trackedPlaceName } from "@/lib/dataforseo/locations";
import { formatDate } from "@/lib/format";
import { normalizeDomain, type Project } from "@/lib/projects";
import { projectScope, workspaceTimeZone, type WorkspaceScope } from "@/lib/workspace";
import { statusCounts, THREAD_RULE, type ActionStatus } from "@/modules/ai/action-list";
import { getAiActions, getOverview as aiOverview, getPromptTable, getSources } from "@/modules/ai/data";
import { isGeminiRedirect, namesBrand } from "@/modules/ai/detect";
import { withFailedPlatforms } from "@/modules/ai/metrics";
import { PLATFORM_KEYS, platformDef } from "@/modules/ai/platforms";
import { readAccessReport, USER_AGENT_ONLY, type AccessReport } from "@/modules/audit/access";
import { issueDetailRows, issueSummary, resolveCrawl } from "@/modules/audit/queries";
import { isSiteWide, SITE_WIDE_NOTE, splitSiteWide } from "@/modules/audit/site-wide";
import { ISSUES, SEVERITIES } from "@/modules/audit/taxonomy";
import { listSnapshots } from "@/modules/backlinks/api";
import { AI_COUNTED, aiReferrals, SOURCE_LABEL, type AiReferrals } from "@/modules/google/ai-referrals";
import { noisyNote, searchConsoleSpan } from "@/modules/google/brief";
import { ga4DataRange, ga4Totals, gscBreakdownRows, gscByPage, gscByQuery, gscByQueryPage, gscDataRange, gscLikelyBotTotals, gscStrikingPages, gscTotals, landingPagesJoined, pagePath, STRIKING_PAIRS, type Totals } from "@/modules/google/data";
import { isLikelyBotQuery, LIKELY_BOT_RULE } from "@/modules/google/bot-queries";
import { countryCode, gscCountryLikelyBotTotals, gscCountryRows, gscCountryTotals } from "@/modules/google/country";
import { countryName } from "@/modules/google/countries";
import { NOISY_UNDER_DAYS, STRIKING_RANGE, strikingFormula, strikingMinImpressions, strikingPages, type StrikingPage } from "@/modules/google/insights";
import type { GscRow } from "@/modules/google/types";
import { daysBetween, maxDate, resolvePeriods, todayIn, type DateRange } from "@/modules/google/windowing";
import { getList, listItems, listSummaries } from "@/modules/keywords/lists";
import { listAlerts, type AlertStatus } from "@/modules/alerts/queries";
import { ruleStates } from "@/modules/alerts/record";
import { RULES } from "@/modules/alerts/rules";
import { emailOrigin } from "@/lib/recap/origin";
import { exportMarkdown } from "@/modules/content-briefs/markdown";
import { getBrief, listBriefs } from "@/modules/content-briefs/ops";
import { toFill } from "@/modules/content-briefs/templates";
import { PAGE_TYPE_LABEL } from "@/modules/content-briefs/types";
import type { RankDashboardData } from "@/modules/rank/dashboard";
import type { Summary } from "@/modules/rank/metrics";
import { latestCheckSummary, pageOneGainsInRows } from "@/modules/rank/not-confirmed";
import { buildOverview, type OverviewFilters } from "@/modules/rank/overview";
import { gridLabel } from "@/modules/local/grid";
import { avgRank, foundShare, rankChange, top3Share, type KeywordStats } from "@/modules/local/metrics";
import { checkStats, latestPair, listBusinesses, listChecks, listKeywords, previousFor } from "@/modules/local/queries";
import { DEPTH_HINT_DAYS, type DepthHint } from "@/modules/rank/depth-hint";
import { loadDepthHint, loadResultsToCarry, loadTracker, resolveWindow, shiftDate } from "@/modules/rank/queries";
import { searchConsoleAverages } from "@/modules/rank/search-console";
import { canResearch, canWrite, type Principal } from "./keys";
import { plainRefusal } from "./plan-wording";

/**
 * What the MCP read tools return. Database reads only: no DataForSEO
 * calls and no writes. Google is read live in two places, both free: get_analytics' AI assistants,
 * and get_search_console's rows for one `country`, which the sync doesn't store. Every function takes the caller's workspace and resolves projects
 * inside it, so an id from an agent can never reach another workspace's rows.
 */

/** A refusal the agent should see as the tool's answer, not a server error. */
export class ToolError extends Error {}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

const limitOf = (n: number | undefined) => Math.min(Math.max(1, Math.floor(n ?? DEFAULT_LIMIT)), MAX_LIMIT);
const round = (n: number | null | undefined, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** The first `limit` rows, and whether any were left out. */
function capped<T>(rows: T[], limit: number | undefined) {
  const n = limitOf(limit);
  return { rows: rows.slice(0, n), total: rows.length, truncated: rows.length > n };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function workspaceProjects(ws: WorkspaceScope) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, ws.workspaceId), eq(projects.archived, false)))
    .orderBy(asc(projects.name));
}

/**
 * A project of the caller's workspace from what an agent passed: an id, a domain or a name. With
 * nothing passed, the workspace's only project. Archived projects are found by id or domain.
 */
export async function resolveProject(ws: WorkspaceScope, ref?: string | number | null): Promise<Project> {
  const text = ref == null ? "" : String(ref).trim();
  if (!text) {
    const all = await workspaceProjects(ws);
    if (all.length === 1) return all[0];
    if (!all.length) throw new ToolError("This workspace has no projects yet. Add one in SEOpen first.");
    throw new ToolError(`This workspace has ${all.length} projects. Pass \`project\` (an id or domain): ${all.map((p) => `${p.id} ${p.domain}`).join(", ")}.`);
  }
  const id = /^\d+$/.test(text) ? Number(text) : null;
  const domain = normalizeDomain(text);
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, ws.workspaceId),
        or(
          id !== null && id >= 1 && id <= 2_147_483_647 ? eq(projects.id, id) : undefined,
          domain ? eq(projects.domain, domain) : undefined,
          sql`lower(${projects.name}) = ${text.toLowerCase()}`,
        ),
      ),
    )
    .orderBy(asc(projects.archived), asc(projects.id))
    .limit(1);
  if (!row) throw new ToolError(`No project “${text}” in this workspace. Call list_projects to see them.`);
  return row;
}

/**
 * The project for a tool that changes or runs something. An archived project's checks are stopped
 * and the app offers no way to change it, so an agent can't either: its keywords and prompts aren't
 * counted against the plan, and a check started on it would be refused by its own job.
 */
export async function resolveLiveProject(ws: WorkspaceScope, ref?: string | number | null): Promise<Project> {
  const row = await resolveProject(ws, ref);
  if (row.archived) throw new ToolError(`${row.domain} is archived, so it can't be changed or checked. Restore it in SEOpen first.`);
  return row;
}

function projectInfo(p: Project) {
  return { id: p.id, name: p.name, domain: p.domain, market: locationName(p.locationCode), rank_place: trackedPlaceName(p), language: p.languageCode, archived: p.archived };
}

export async function listProjectsData(ws: WorkspaceScope) {
  const [all, comps] = await Promise.all([
    workspaceProjects(ws),
    db
      .select({ projectId: competitors.projectId, domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.workspaceId, ws.workspaceId))
      .orderBy(asc(competitors.domain)),
  ]);
  return {
    projects: all.map((p) => ({
      ...projectInfo(p),
      competitors: comps.filter((c) => c.projectId === p.id).map((c) => c.domain),
    })),
  };
}

// ---------------------------------------------------------------------------
// Overview and what changed (the dashboard's cards)
// ---------------------------------------------------------------------------

/** A dashboard loader slower than this counts as failed, as on the dashboard. */
const LOAD_TIMEOUT_MS = 5000;

type Loaded = { module: AnyDashboardModule; status: "ok"; data: unknown } | { module: AnyDashboardModule; status: "not_set_up" | "error"; data: null };

async function loadResults(project: Project): Promise<Loaded[]> {
  return Promise.all(
    DASHBOARD_MODULES.map(async (module): Promise<Loaded> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("took too long to load")), LOAD_TIMEOUT_MS);
        });
        const data = await Promise.race([module.load(project), timeout]);
        return data == null ? { module, status: "not_set_up", data: null } : { module, status: "ok", data };
      } catch (e) {
        console.error(`[mcp] ${module.id} loader failed`, e);
        return { module, status: "error", data: null };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Each module's results with what it said about its newest check, as on Overview. */
async function loadModules(project: Project) {
  const [results, failures] = await Promise.all([loadResults(project), projectFailures(project)]);
  return withFailures(results, failures);
}

type LoadedModule = Awaited<ReturnType<typeof loadModules>>[number];

/** What Overview reads about a project's newest checks, plan rules included. Missing a failure is better than losing the answer, so one that can't be read is logged and skipped. */
async function projectFailures(project: Project) {
  try {
    return (await loadFailures([project], await workspaceTimeZone(project))).get(project.id);
  } catch (e) {
    console.error(`[mcp] couldn't read failed checks for project ${project.id}`, e);
    return undefined;
  }
}

function failureOut(f: CheckFailure) {
  return {
    kind: f.kind,
    summary: failureLine(f),
    what: f.noun,
    at: f.at,
    reason: f.reason,
    can_retry: f.retry,
    ...(f.stuck ? { didnt_start: true } : {}),
    ...(f.blocked ? { blocked: f.blocked } : {}),
    ...(f.provider ? { reconnect: f.provider } : {}),
    next: f.next,
  };
}

/** The sentence over a project's failing sources on Overview. A module that couldn't load says so itself. */
function needsALook(loaded: LoadedModule[]) {
  const sources = loaded.flatMap((l) => (l.lastRunFailed && l.status !== "error" ? [{ label: l.module.label, failure: l.lastRunFailed }] : []));
  return sources.length ? needsLookSentence(sources) : null;
}

/** How much of a check's rank figures rests on positions no look could confirm, as Rankings' captions say it. They stay in the figures. */
function notConfirmedOut(s: Summary) {
  return {
    positions: s.notConfirmed,
    top3: s.top3NotConfirmed,
    top10: s.top10NotConfirmed,
    visibility_points: round(s.visibilityNotConfirmed * 100),
    est_traffic: Math.round(s.trafficNotConfirmed),
  };
}

/** The same for the rank card's latest check. Nothing when the card has no data, or when this can't be read: the rest of the answer still stands. */
async function rankNotConfirmed(project: Project, loaded: LoadedModule[]) {
  const rank = loaded.find((l) => l.module.id === "rank");
  if (rank?.status !== "ok") return null;
  try {
    const latest = await withTimeout(latestCheckSummary(project), LOAD_TIMEOUT_MS);
    if (!latest) return null;
    return { date: latest.date, ...notConfirmedOut(latest), page_one_gains: (rank.data as RankDashboardData).pageOneGainsNotConfirmed, est_traffic_total: Math.round(latest.traffic) };
  } catch (e) {
    console.error(`[mcp] couldn't read unconfirmed positions for project ${project.id}`, e);
    return null;
  }
}

/** Plain text of a card's header line, which may be JSX. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Long series (daily charts) keep their most recent points; the agent rarely needs 90 of them. */
const SERIES_POINTS = 14;

function trimSeries(value: unknown): unknown {
  if (Array.isArray(value)) return (value.length > SERIES_POINTS ? value.slice(-SERIES_POINTS) : value).map(trimSeries);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimSeries(v)]));
  return value;
}

function changeOut(c: KpiChange) {
  const { value, unit } = shownChange(c);
  const { text, tone } = describeChange(value, unit, c.goodWhen);
  return { label: c.label, from: c.format(c.from), to: c.format(c.to), change: text, tone };
}

function highlightOut(h: Highlight, failure: CheckFailure | undefined) {
  return { module: h.module, label: h.label, from: h.from, to: h.to, change: h.signed, compared_with: h.baseline, ...(failure ? { note: newerFailed(failure) } : {}) };
}

function highlightsOut(loaded: LoadedModule[]) {
  const h = pickHighlights(loaded.filter((l) => l.status === "ok").map((l) => ({ module: l.module, data: l.data })));
  const out = (x: Highlight) => highlightOut(x, loaded.find((l) => l.module.label === x.module)?.lastRunFailed);
  return { comparable: h.comparable, worse: h.worse.map(out), better: h.better.map(out) };
}

export async function overviewData(ws: WorkspaceScope, ref?: string | number) {
  const project = await resolveProject(ws, ref);
  const loaded = await loadModules(project);
  const notConfirmed = await rankNotConfirmed(project, loaded);
  return {
    project: projectInfo(project),
    needs_a_look: needsALook(loaded),
    what_changed: highlightsOut(loaded),
    modules: loaded.map((l) => {
      const base = { id: l.module.id, label: l.module.label, status: l.status, ...(l.lastRunFailed ? { last_run_failed: failureOut(l.lastRunFailed) } : {}) };
      if (l.status === "not_set_up") return { ...base, setup: l.module.setup.text };
      if (l.status === "error") return { ...base, error: "Couldn't load this module's data." };
      const changes = (l.module.changes?.(l.data) ?? []).filter((c): c is KpiChange => c != null);
      return {
        ...base,
        period: textOf(l.module.describe(l.data)),
        compared_with: l.module.baseline?.(l.data) ?? null,
        changes: changes.map(changeOut),
        ...(l.module.id === "rank" && notConfirmed ? { not_confirmed: notConfirmed } : {}),
        data: trimSeries(l.data),
      };
    }),
  };
}

export async function whatChangedData(ws: WorkspaceScope, ref?: string | number) {
  const project = await resolveProject(ws, ref);
  const loaded = await loadModules(project);
  const notConfirmed = await rankNotConfirmed(project, loaded);
  return {
    project: projectInfo(project),
    needs_a_look: needsALook(loaded),
    ...highlightsOut(loaded),
    ...(notConfirmed ? { rank_not_confirmed: notConfirmed } : {}),
    not_set_up: loaded.filter((l) => l.status === "not_set_up").map((l) => l.module.label),
    failed: loaded.filter((l) => l.status === "error").map((l) => l.module.label),
    last_run_failed: loaded.flatMap((l) => (l.lastRunFailed ? [{ module: l.module.label, ...failureOut(l.lastRunFailed) }] : [])),
  };
}

// ---------------------------------------------------------------------------
// Rank tracking
// ---------------------------------------------------------------------------

export const RANK_CHANGES = ["improved", "declined", "moved", "new", "lost", "unchanged", "none"] as const;

export async function rankingsData(
  ws: WorkspaceScope,
  args: { project?: string | number; days?: number; change?: (typeof RANK_CHANGES)[number]; tag?: string; limit?: number },
) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const tracker = await loadTracker(scope);
  const days = args.days ?? 7;
  const window = resolveWindow(tracker.dates, days);
  if (!window) {
    return { project: projectInfo(project), checked: false, message: "No rank checks yet. Add keywords on the Rankings page.", keywords: tracker.keywords.length, hint: null };
  }
  const results = await loadResultsToCarry(scope, window.start, window.end, tracker.place);
  const filters: OverviewFilters = { change: args.change as OverviewFilters["change"], tag: args.tag };
  const averages = await searchConsoleAverages(scope, tracker.keywords.map((k) => k.keyword), window.end);
  const o = buildOverview(tracker.keywords, results, filters, averages, window.start);
  // The hint is about every keyword, whatever the filter.
  const all = args.change || args.tag ? buildOverview(tracker.keywords, results, {}, averages, window.start) : o;
  const hint = await loadDepthHint(scope, tracker, all.rows, window.end);
  const summary = (s: typeof o.start) =>
    s && {
      date: s.date,
      visibility: round(s.visibility == null ? null : s.visibility * 100),
      top3: s.top3,
      top10: s.top10,
      avg_position: round(s.avgPosition),
      est_traffic: Math.round(s.traffic),
      not_confirmed: notConfirmedOut(s),
    };
  // Biggest moves first when filtering by change; otherwise by estimated traffic.
  const sorted = [...o.rows].sort((a, b) =>
    args.change ? Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.traffic - a.traffic : b.traffic - a.traffic,
  );
  const { rows, total, truncated } = capped(sorted, args.limit);
  return {
    project: projectInfo(project),
    window: { start: window.start, end: window.end, days, ...trackingBegan(tracker.dates, window, days) },
    summary: { start: summary(o.start), end: summary(o.end), improved: o.improved, declined: o.declined, keywords: o.totalRows, page_one_gains_not_confirmed: pageOneGainsInRows(o.rows) },
    tags: o.tags,
    keywords: rows.map((r) => ({
      keyword: r.keyword,
      device: r.device,
      position: r.position,
      // The latest check couldn't confirm this keyword: `position` is the last one seen.
      ...(r.notChecked ? { not_checked: true } : {}),
      // `position` is beyond the latest check's depth; a deeper check on this date saw it.
      ...(r.deeperCheckDate ? { from_deeper_check: r.deeperCheckDate } : {}),
      // No look found it, but Search Console's average across every location is within the check's depth, so it may be a miss.
      ...(r.searchConsole != null ? { search_console_position: round(r.searchConsole) } : {}),
      start_position: r.start,
      change: r.change,
      position_delta: r.delta,
      url: r.url,
      volume: r.volume,
      tags: r.tags,
      serp_features: r.features,
      // From the latest check that loaded AI Overview sources, which can be older than serp_features' check.
      ai_overview: r.aio,
      ai_overview_checked: r.aioDate ?? null,
    })),
    total,
    truncated,
    hint: hint && depthHintOut(hint),
  };
}

/** When the window reaches back past the first check, the day tracking began, so `days` isn't read as the span covered. */
function trackingBegan(dates: string[], window: { start: string; end: string }, days: number) {
  const first = dates[dates.length - 1];
  if (first !== window.start || first <= shiftDate(window.end, -days)) return {};
  return { tracking_began: first, note: `Tracking began on ${first}, so the window starts there, not ${days} days back.` };
}

/** `depthHint` for an agent: the sentence to pass on, and the figures behind it. */
function depthHintOut(h: DepthHint) {
  return {
    message: h.message,
    keywords: h.keywords,
    deepest_search_console_position: h.deepest,
    search_console_days: DEPTH_HINT_DAYS,
    daily_depth: h.depth,
    suggested_daily_depth: h.suggestedDepth,
    covered_by_suggested_depth: h.covered,
    keyword_units_each: { now: h.unitsNow, at_suggested_depth: h.unitsSuggested },
    weekly_check_depth: h.sweepDepth,
    weekly_check_may_find: h.sweepCovers,
    not_found_by_a_deep_enough_check: h.lookedAlready,
    change_depth_in: "Rankings settings, Daily check depth",
  };
}

// ---------------------------------------------------------------------------
// Search Console and GA4
// ---------------------------------------------------------------------------

export const COMPARE = ["previous", "year"] as const;

/**
 * The last `days` days of stored data, and what they're compared with: the same length just before,
 * or a year earlier. No comparison when that period ends before the first synced day, as on the
 * dashboard, so missing history never reads as a drop to zero. The period starts no earlier than the
 * first synced day, as the dashboard's "N days to" does, so it never claims days with no data.
 */
function periods(range: { first: string; last: string }, days: number, compare: (typeof COMPARE)[number] = "previous"): { current: DateRange; previous: DateRange | null } {
  const p = resolvePeriods(range.last, days, compare === "year" ? "yoy" : "prev");
  return { current: { start: maxDate(p.current.start, range.first), end: p.current.end }, previous: p.previous && p.previous.end >= range.first ? p.previous : null };
}

export const GSC_DIMENSIONS = ["query", "page", "query_page", "striking_distance", "country", "device"] as const;

/**
 * How much Search Console data the project has stored, so an agent can tell a young site from one
 * with nothing to find: comparisons and striking distance rest on few searches under 90 days.
 */
function gscHistory(range: { first: string; last: string }) {
  const days = daysBetween(range.first, range.last) + 1;
  return { first_day: range.first, last_day: range.last, days, under_90_days: days < NOISY_UNDER_DAYS };
}

const COUNTRY_NOTE =
  "Totals are the country's stored daily figures. The rows are read from Search Console now with its country filter, since SEOpen stores countries only as site totals, so they aren't capped per day like the stored lists and can include searches those leave out.";

function countryField(country: string | null) {
  return country ? { country: { code: country, name: countryName(country) } } : {};
}

/** The rows a live read for one country stops at for the period before, which only joins in changes. */
const COMPARE_ROWS = 25_000;

/**
 * get_search_console's rows for one country, in the same shape as the stored ones. Countries are
 * stored only as daily totals, so only `dimension: "country"` reads the database; the rest ask
 * Search Console with its country filter (`gscCountryRows`), once for the period and once for the
 * one before.
 */
async function countryRowsData(
  project: Project,
  dimension: (typeof GSC_DIMENSIONS)[number],
  current: DateRange,
  previous: DateRange | null,
  opts: { country: string; contains?: string; limit?: number; positions: { min: number; max: number }; days: number },
): Promise<{ rows: Record<string, unknown>[]; striking: { truncated: boolean } | null }> {
  const scope = projectScope(project);
  const { country, contains } = opts;
  if (dimension === "country") {
    const dim = await gscBreakdownRows(scope, "country", current, previous);
    const row = dim.find((r) => r.key === country);
    return { rows: row ? [{ country: row.key, clicks: row.clicks, clicks_change: row.clicksDelta, share_of_clicks: round(row.share, 3), impressions: row.impressions, ctr: round(row.ctr, 4), position: row.position }] : [], striking: null };
  }
  if (!project.gscProperty) throw new ToolError("This project has no Search Console property, so its searches can't be read by country. Connect Google on its Search Console page.");
  const base = { property: project.gscProperty, workspaceId: project.workspaceId, country };
  const live = (read: Omit<Parameters<typeof gscCountryRows>[0], keyof typeof base>, range: DateRange) => liveCountryRead(() => gscCountryRows({ ...base, ...read }, range));
  const want = limitOf(opts.limit) + 1;

  if (dimension === "striking_distance") {
    const pairs = await live({ dimensions: ["query", "page"], maxRows: STRIKING_PAIRS + 1 }, current);
    const truncated = pairs.length > STRIKING_PAIRS;
    const close = strikingPages(
      pairs.slice(0, STRIKING_PAIRS).map((r) => ({ query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: round(r.position) ?? 0 })),
      opts.positions,
      strikingMinImpressions(opts.days),
    );
    const needle = contains?.toLowerCase();
    const pages = needle ? close.filter((p) => pagePath(p.page).toLowerCase().includes(needle) || p.list.some((q) => q.query.toLowerCase().includes(needle))) : close;
    return { rows: pages.map(strikingRow), striking: { truncated } };
  }

  // Each search, page or device with the same key's numbers in the period before.
  const dims: ("query" | "page" | "device")[] = dimension === "query_page" ? ["query", "page"] : [dimension];
  const reads: Parameters<typeof live>[0][] =
    dimension === "query_page" && contains
      ? // Stored query_page matches the search or the page; Search Console's filters all have to match, so it's two reads.
        [
          { dimensions: dims, contains: { dimension: "query", text: contains }, maxRows: want },
          { dimensions: dims, contains: { dimension: "page", text: contains }, maxRows: want },
        ]
      : [{ dimensions: dims, contains: contains && dimension !== "device" ? { dimension: dimension === "page" ? "page" : "query", text: contains } : undefined, maxRows: dimension === "device" ? 10 : want }];
  const key = (r: GscRow) => r.keys.join("\u0000");
  const merge = (lists: GscRow[][]) => [...new Map(lists.flat().map((r) => [key(r), r])).values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  // Search Console matches a page's whole address; the stored rows match its path, so the site's own domain doesn't match every page.
  const onPath = (read: Parameters<typeof live>[0]) => (rows: GscRow[]) => {
    const text = read.contains?.dimension === "page" ? read.contains.text.toLowerCase() : null;
    return text ? rows.filter((r) => pagePath(r.keys[dims.indexOf("page")]).toLowerCase().includes(text)) : rows;
  };
  const [cur, prev] = await Promise.all([
    Promise.all(reads.map((r) => live(r, current).then(onPath(r)))).then(merge),
    previous ? Promise.all(reads.map((r) => live({ ...r, maxRows: COMPARE_ROWS }, previous).then(onPath(r)))).then(merge) : null,
  ]);
  const before = new Map((prev ?? []).map((r) => [key(r), r]));
  const totalClicks = cur.reduce((n, r) => n + r.clicks, 0);
  return {
    rows: cur.slice(0, want).map((r) => {
      const p = before.get(key(r));
      const position = round(r.position) ?? 0;
      const change = {
        clicks_change: prev ? r.clicks - (p?.clicks ?? 0) : null,
        impressions_change: prev ? r.impressions - (p?.impressions ?? 0) : null,
      };
      if (dimension === "device") return { device: r.keys[0], clicks: r.clicks, clicks_change: change.clicks_change, share_of_clicks: round(totalClicks ? r.clicks / totalClicks : 0, 3), impressions: r.impressions, ctr: round(r.ctr, 4), position };
      return {
        ...(dimension === "query_page" ? { query: r.keys[0], ...botFlag(r.keys[0]), page: r.keys[1] } : { [dimension]: r.keys[0], ...(dimension === "query" ? botFlag(r.keys[0]) : {}) }),
        clicks: r.clicks,
        clicks_change: change.clicks_change,
        impressions: r.impressions,
        impressions_change: change.impressions_change,
        ctr: round(r.ctr, 4),
        position,
        position_change: p && p.position ? round(p.position - r.position) : null,
      };
    }),
    striking: null,
  };
}

export async function searchConsoleData(
  ws: WorkspaceScope,
  args: {
    project?: string | number;
    dimension?: (typeof GSC_DIMENSIONS)[number];
    days?: number;
    compare?: (typeof COMPARE)[number];
    contains?: string;
    country?: string;
    limit?: number;
    min_position?: number;
    max_position?: number;
  },
) {
  const positions = { min: args.min_position ?? STRIKING_RANGE.min, max: args.max_position ?? STRIKING_RANGE.max };
  if (positions.min > positions.max) throw new ToolError(`min_position (${positions.min}) must be at or below max_position (${positions.max}).`);
  const country = args.country == null ? null : countryCode(args.country);
  if (args.country != null && !country) throw new ToolError(`“${args.country}” isn't a country code. Use Search Console's three-letter code, such as usa, gbr, esp or deu (dimension: "country" lists the site's).`);
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const range = await gscDataRange(scope);
  if (!range) return { project: projectInfo(project), connected: false, message: "No Search Console data yet. Connect Google on the Search Console page." };
  const { current, previous } = periods(range, args.days ?? 28, args.compare);
  const dimension = args.dimension ?? "query";
  // Totals leave out searches that look like another tool's rank check, read at the time of the call.
  const totalsOf = async (r: DateRange): Promise<{ totals: Totals; bots: { clicks: number; impressions: number } }> => {
    if (!country) {
      const [totals, bots] = await Promise.all([gscTotals(scope, r), gscLikelyBotTotals(scope, r)]);
      return { totals, bots };
    }
    const [all, bots] = await Promise.all([
      gscCountryTotals(scope, r, country),
      project.gscProperty ? liveCountryRead(() => gscCountryLikelyBotTotals({ property: project.gscProperty!, workspaceId: project.workspaceId, country }, r)) : { clicks: 0, impressions: 0, weighted: 0 },
    ]);
    const clicks = Math.max(0, all.clicks - bots.clicks);
    const impressions = Math.max(0, all.impressions - bots.impressions);
    const position = impressions ? (all.position * all.impressions - bots.weighted) / impressions : 0;
    return { totals: { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: position >= 1 ? position : all.position }, bots: { clicks: bots.clicks, impressions: bots.impressions } };
  };
  const [nowRead, beforeRead] = await Promise.all([totalsOf(current), previous ? totalsOf(previous) : null]);
  const now = nowRead.totals;
  const before = beforeRead?.totals ?? null;
  const totals = (t: Totals) => ({ clicks: t.clicks, impressions: t.impressions, ctr: round(t.ctr, 4), position: round(t.position) });
  const contains = args.contains?.trim() || undefined;
  // `contains` picks rows; the totals stay every search's, so say so beside them.
  const totalsOut = {
    current: totals(now),
    previous: before && totals(before),
    ...(contains ? { note: `Every search${country ? ` from ${countryName(country)}` : ""}, not only the rows matching “${contains}”.` } : {}),
  };
  const leftOut =
    nowRead.bots.impressions || beforeRead?.bots.impressions
      ? {
          likely_bot_left_out: {
            current: nowRead.bots,
            previous: beforeRead?.bots ?? null,
            note: `Searches that look like another tool's rank check (${LIKELY_BOT_RULE}) are left out of these totals and marked likely_bot in rows.`,
          },
        }
      : {};

  let rows: Record<string, unknown>[];
  let striking: { truncated: boolean } | null = null;
  if (country) {
    const read = await countryRowsData(project, dimension, current, previous, { country, contains, limit: args.limit, positions, days: args.days ?? 28 });
    rows = read.rows;
    striking = read.striking;
  } else if (dimension === "striking_distance") {
    // The rows Opportunities' Group by page shows for the same days and positions.
    const close = await gscStrikingPages(scope, current, { positions, minImpressions: strikingMinImpressions(args.days ?? 28) });
    const needle = contains?.toLowerCase();
    const pages = needle ? close.pages.filter((p) => pagePath(p.page).toLowerCase().includes(needle) || p.list.some((q) => q.query.toLowerCase().includes(needle))) : close.pages;
    striking = { truncated: close.truncated };
    rows = pages.map(strikingRow);
  } else if (dimension === "query_page") {
    const dim = await gscByQueryPage(scope, current, previous, { contains, limit: limitOf(args.limit) + 1 });
    rows = dim.map((r) => ({
      query: r.query,
      ...botFlag(r.query),
      page: r.page,
      clicks: r.clicks,
      clicks_change: r.clicksDelta,
      impressions: r.impressions,
      impressions_change: r.impressionsDelta,
      ctr: round(r.ctr, 4),
      position: r.position,
      position_change: r.positionDelta,
    }));
  } else if (dimension === "query" || dimension === "page") {
    const fetch = dimension === "query" ? gscByQuery : gscByPage;
    const dim = await fetch(scope, current, previous, { contains, limit: limitOf(args.limit) + 1 });
    rows = dim.map((r) => ({
      [dimension]: r.key,
      ...(dimension === "query" ? botFlag(r.key) : {}),
      clicks: r.clicks,
      clicks_change: r.clicksDelta,
      impressions: r.impressions,
      impressions_change: r.impressionsDelta,
      ctr: round(r.ctr, 4),
      position: r.position,
      position_change: r.positionDelta,
    }));
  } else {
    const dim = await gscBreakdownRows(scope, dimension, current, previous);
    rows = dim.map((r) => ({
      [dimension]: r.key,
      clicks: r.clicks,
      clicks_change: r.clicksDelta,
      share_of_clicks: round(r.share, 3),
      impressions: r.impressions,
      ctr: round(r.ctr, 4),
      position: r.position,
    }));
  }
  const { rows: shown, truncated } = capped(rows, args.limit);
  if (striking) {
    const noisy = noisyNote(range);
    return {
      project: projectInfo(project),
      period: current,
      history: gscHistory(range),
      source: searchConsoleSpan(current),
      ...countryField(country),
      positions,
      note: [
        `Pages whose searches average position ${positions.min} to ${positions.max} over the period, by the page Google showed for each search, highest score first: the same rows as Opportunities' Group by page. ${strikingFormula(positions)} A page needs ${strikingMinImpressions(args.days ?? 28)} impressions across its searches in range. \`searches\` lists up to 10 of them, most score first.`,
        args.compare ? "`compare` sets only the totals' earlier period. The pages are scored from this period alone, with no change against an earlier one." : null,
        // A copy without plans keeps every pair Search Console sends (gscRowsPerDay is null there).
        rules.hasPlans ? "Each day keeps its top search-and-page pairs by clicks up to the plan's limit, so pairs with few clicks may be missing." : null,
        striking.truncated
          ? country
            ? `This site has more pairs in ${countryName(country)} than SEOpen reads at once, so the pages are scored from the pairs with the most clicks.`
            : "This site has more pairs in range than SEOpen reads at once, so the pages are scored from the pairs with the most impressions."
          : null,
        country ? COUNTRY_NOTE : null,
        noisy,
      ]
        .filter(Boolean)
        .join(" "),
      ...(noisy ? { noisy: true } : {}),
      totals: totalsOut,
      ...leftOut,
      dimension,
      rows: shown,
      total: rows.length,
      truncated,
    };
  }
  return {
    project: projectInfo(project),
    period: current,
    history: gscHistory(range),
    compared_with: previous ?? "nothing: no data that far back",
    ...countryField(country),
    note: [
      dimension === "query_page"
        ? country
          ? "position_change is positive when the position improved (moved up). Each row is one search and the page Google showed for it; a search on several rows is split across pages."
          : "position_change is positive when the position improved (moved up). Each row is one search and the page Google showed for it; a search on several rows is split across pages. Each day keeps its top pairs by clicks up to the plan's limit, so pairs with few clicks may be missing."
        : "position_change is positive when the position improved (moved up).",
      country && dimension !== "country" ? COUNTRY_NOTE : null,
    ]
      .filter(Boolean)
      .join(" "),
    totals: totalsOut,
    ...leftOut,
    dimension,
    rows: shown,
    truncated,
  };
}

function strikingRow(p: StrikingPage) {
  return {
    page: p.page,
    score: p.score,
    searches_in_range: p.queries,
    impressions: p.impressions,
    clicks: p.clicks,
    best_position: p.bestPosition,
    top_query: p.topQuery.query,
    top_query_position: p.topQuery.position,
    top_query_impressions: p.topQuery.impressions,
    searches: p.list.slice(0, 10).map((q) => ({ query: q.query, ...botFlag(q.query), position: q.position, impressions: q.impressions, clicks: q.clicks })),
  };
}

/** `likely_bot: true` on a search that looks like another tool's rank check (`isLikelyBotQuery`). */
function botFlag(query: string) {
  return isLikelyBotQuery(query) ? { likely_bot: true } : {};
}

/** A read from Search Console for one country, with its failure in plain words. */
async function liveCountryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error("[mcp.get_search_console] country read", err);
    throw new ToolError(plainNextStep(err, "Search Console didn't answer that read by country. Try again in a minute, or leave out country."));
  }
}

/** Sessions from AI assistants over the same period, read from the source now, or why they couldn't be. */
function aiAssistantsField(ai: AiReferrals) {
  if (ai.state === "none") return null;
  const note = `${AI_COUNTED[ai.source]}. Assistants looked for: ${AI_ASSISTANT_NAMES}. Read live from ${SOURCE_LABEL[ai.source]}, not stored, and not compared with an earlier period.`;
  if (ai.state === "error") return { available: false, message: ai.message, note };
  return {
    available: true,
    period: ai.period,
    sessions: ai.sessions,
    engaged_sessions: ai.engagedSessions,
    assistants: ai.assistants.map((a) => ({ name: a.name, sessions: a.sessions, engaged_sessions: a.engagedSessions, seen_as: a.seenAs })),
    note,
  };
}

export async function analyticsData(ws: WorkspaceScope, args: { project?: string | number; days?: number; compare?: (typeof COMPARE)[number]; limit?: number }) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const range = await ga4DataRange(scope);
  if (!range) return { project: projectInfo(project), connected: false, message: project.umamiSite ? "No analytics data yet from this project's Umami website." : project.plausibleSite ? "No analytics data yet from this project's Plausible site." : "No analytics data yet. Connect Google Analytics or PostHog on the Analytics page." };
  const { current, previous } = periods(range, args.days ?? 28, args.compare);
  const [now, before, pages, ai] = await Promise.all([ga4Totals(scope, current), previous ? ga4Totals(scope, previous) : null, landingPagesJoined(scope, current, previous), aiReferrals(project, current)]);
  const { rows, total, truncated } = capped(pages, args.limit);
  return {
    project: projectInfo(project),
    period: current,
    compared_with: previous ?? "nothing: no data that far back",
    source: project.umamiSite ? "umami" : project.plausibleSite ? "plausible" : project.posthogProject ? "posthog" : "ga4",
    note: `Organic search sessions by landing page (${project.umamiSite ? "Umami: visits whose first page view came from a search site (Google, Bing, DuckDuckGo, Ecosia, Yandex, Baidu, Brave Search or MSN), so not only Google; days are UTC, engaged means more than one page view, and it has no key events or revenue" : project.plausibleSite ? "Plausible: visits on its Organic Search channel, which covers any search site it knows and links tagged with the medium organic, so not only Google; engaged means not bounced, and it has no key events or revenue" : project.posthogProject ? "PostHog; engaged means not bounced, and it has no key events or revenue" : "GA4"}), joined with Search Console clicks for the same page.`,
    totals: { current: now, previous: before },
    ai_assistants: aiAssistantsField(ai),
    landing_pages: rows.map((r) => ({
      url: r.url,
      sessions: r.sessions,
      sessions_change: r.sessionsDelta,
      engagement_rate: round(r.engagementRate, 3),
      key_events: r.keyEvents,
      revenue: round(r.totalRevenue, 2),
      gsc_clicks: r.gscClicks,
      gsc_position: r.gscPosition,
    })),
    total,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Site audit
// ---------------------------------------------------------------------------

export async function auditData(
  ws: WorkspaceScope,
  args: { project?: string | number; issue?: string; severity?: (typeof SEVERITIES)[number]; limit?: number },
) {
  const project = await resolveProject(ws, args.project);
  const { crawl, previous } = await resolveCrawl(projectScope(project));
  if (!crawl) return { project: projectInfo(project), crawled: false, message: "No finished crawl yet. Start one on the Site audit page." };
  const crawlInfo = {
    id: crawl.id,
    target: crawl.target,
    finished: crawl.finishedAt?.toISOString() ?? null,
    pages_crawled: crawl.pagesCrawled,
    health_score: round(crawl.healthScore),
    errors: crawl.errors,
    warnings: crawl.warnings,
    notices: crawl.notices,
    compared_with: previous?.finishedAt ? `crawl of ${previous.finishedAt.toISOString().slice(0, 10)}` : null,
  };

  if (args.issue) {
    const def = ISSUES[args.issue];
    if (!def) throw new ToolError(`Unknown issue code “${args.issue}”. Call get_audit_issues without \`issue\` to see the codes.`);
    const urls = await issueDetailRows(crawl, previous, def.code);
    const { rows, total, truncated } = capped(urls, args.limit);
    return {
      project: projectInfo(project),
      crawl: crawlInfo,
      issue: {
        code: def.code,
        title: def.title,
        severity: def.severity,
        category: def.category,
        why: def.why,
        fix: def.fix,
        detail: def.detailLabel ?? null,
        ...(isSiteWide({ severity: def.severity, count: new Set(urls.map((u) => u.url)).size }, crawl.pagesCrawled) ? { site_wide: true, note: SITE_WIDE_NOTE } : {}),
      },
      urls: rows.map((r) => ({ url: r.url, detail: r.detail, page_title: r.title, status: r.statusCode, new: r.isNew })),
      total,
      truncated,
    };
  }

  const summary = await issueSummary(crawl, previous);
  const rank = (s: string) => SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);
  const issues = summary.rows
    .filter((r) => r.count > 0 || r.fixed > 0)
    .filter((r) => !args.severity || r.severity === args.severity)
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.count - a.count);
  // Notices on nearly every page are one template issue, listed last, so a new notice isn't buried under them.
  const { rest, siteWide } = splitSiteWide(issues, crawl.pagesCrawled);
  const issueOut = (r: (typeof issues)[number]) => ({ code: r.code, title: r.title, severity: r.severity, category: r.category, urls: r.count, new: r.added, fixed: r.fixed });
  const grouped = [
    ...rest.map(issueOut),
    ...(siteWide.length ? [{ site_wide: true, title: "Site-wide notices", severity: "notice", note: SITE_WIDE_NOTE, issues: siteWide.map(issueOut) }] : []),
  ];
  const { rows, total, truncated } = capped(grouped, args.limit);
  return {
    project: projectInfo(project),
    crawl: crawlInfo,
    new_urls: summary.newUrls,
    fixed_urls: summary.fixedUrls,
    issues: rows,
    total,
    truncated,
    crawler_access: crawlerAccessData(readAccessReport(crawl.summary)),
  };
}

/** The "Crawler and AI access" checks of a crawl, compact. Training crawlers are the owner's choice, never issues. */
function crawlerAccessData(r: AccessReport | null) {
  if (!r) return { available: false, message: "This crawl has no crawler access report: it ran before these checks existed, or they failed during the crawl. Start a new crawl to run them." };
  const blocked = (role: string) => r.crawlers.filter((c) => c.role === role && !c.allowed).map((c) => ({ crawler: c.token, rule: c.rule }));
  return {
    robots_txt: { url: r.robots.url, status: r.robots.status, found: r.robots.found, fetched_at: r.robots.fetchedAt, error: r.robots.error },
    search_crawlers_blocked: blocked("search"),
    training_crawlers_blocked: blocked("training"),
    training_note: "Blocking training crawlers is the site owner's choice and is never reported as an issue.",
    bot_fetch: r.probes.map((p) => ({ url: p.url, visitor_status: p.baseline, crawlers: Object.fromEntries(p.bots.map((b) => [b.token, b.status])) })),
    bot_fetch_note: USER_AGENT_ONLY,
    raw_vs_rendered: r.rendered ? { pages_checked: r.rendered.checked, pages_needing_javascript: r.rendered.flagged } : "Only checked on crawls with JavaScript rendering on.",
  };
}

// ---------------------------------------------------------------------------
// AI visibility
// ---------------------------------------------------------------------------

const pct = (n: number | null | undefined) => (n == null ? null : round(n * 100));
const platformLabel = (key: string) => platformDef(key)?.label ?? key;

export async function aiVisibilityData(ws: WorkspaceScope, args: { project?: string | number; limit?: number }) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const [o, prompts, sources] = await Promise.all([aiOverview(project), getPromptTable(scope), getSources(project)]);
  if (!prompts.length) return { project: projectInfo(project), tracked: false, message: "No AI prompts tracked yet. Add some on the AI visibility page." };
  const vis = (v: (typeof o)["current"] | null) => v && { mentioned_pct: pct(v.score), answers: v.total, avg_position: round(v.avgPosition) };
  const { rows, total, truncated } = capped(prompts, args.limit);
  return {
    project: projectInfo(project),
    last_run: o.lastRunAt?.toISOString() ?? null,
    note: `mentioned_pct is the share of AI answers that name the site. Compared with the answers before the latest run. ${
      !o.promptCounts.branded
        ? "No prompt names the site, so every prompt is counted."
        : o.includesBranded
          ? `Visibility and share of voice count ${o.promptCounts.branded} branded prompt(s), whose question names the site, because the project counts them or every prompt is branded.`
          : `Visibility and share of voice leave out ${o.promptCounts.branded} branded prompt(s), whose question names the site; the prompt list has every prompt.`
    } An answer that failed isn't one that didn't name the site: answers and mentioned_pct count only answers that came back, and failed_answers and each platform's failed count the prompts whose newest answer failed.${
      o.failedRun ? ` No answer came back from the newest run (${o.failedRun}), so these are the answers before it and previous is null: nothing is compared.` : ""
    }`,
    visibility: { current: vis(o.current), previous: vis(o.previous), failed_answers: o.failed },
    // Counted apart whatever the project's setting, so branded prompts can't hide weak generic visibility.
    by_prompt_type: { generic: { prompts: o.promptCounts.nonBranded, ...vis(o.groups.generic) }, branded: { prompts: o.promptCounts.branded, ...vis(o.groups.branded) } },
    by_platform: withFailedPlatforms(o.byPlatform, o.failedByPlatform, PLATFORM_KEYS).map((p) => ({
      platform: platformLabel(p.platform),
      mentioned_pct: pct(p.score),
      previous_pct: pct(o.previousByPlatform.find((q) => q.platform === p.platform)?.score),
      answers: p.total,
      failed: o.failedByPlatform[p.platform] ?? 0,
    })),
    share_of_voice: o.sov.map((s) => ({
      domain: s.domain,
      own: s.own,
      mention_rate_pct: pct(s.rate),
      previous_pct: pct(o.previousSov?.find((q) => q.domain === s.domain)?.rate),
    })),
    prompts: rows.map((r) => ({
      prompt: r.prompt.prompt,
      branded: namesBrand(r.prompt.prompt, o.brands[0]),
      results: Object.fromEntries(
        Object.entries(r.results).map(([platform, v]) => [platformLabel(platform), v && { status: v.status, mentioned: v.mentioned, cited: v.cited, position: v.position }]),
      ),
      ai_overview: r.aio && { present: r.aio.present, cited: r.aio.cited },
    })),
    total_prompts: total,
    truncated,
    top_cited_domains: sources.domains.slice(0, 10).map((d) => ({ domain: d.domain, citations: d.citations, prompts: d.prompts, without_us: d.withoutUs, own: d.own })),
  };
}

/** Actions listed per prompt unless the call asks for more: one prompt can have dozens. */
export const DEFAULT_ACTIONS_PER_PROMPT = 5;

/** Prompts listed unless the call asks for more: 25 with their actions ran to about 38,000 characters. */
export const DEFAULT_ACTION_PROMPTS = 10;

/** AI visibility → Actions: what to do about each prompt whose latest answers don't name the site. */
export async function aiActionsData(ws: WorkspaceScope, args: { project?: string | number; status?: ActionStatus | "all"; limit?: number; actions_per_prompt?: number }) {
  const project = await resolveProject(ws, args.project);
  const [view, timeZone] = await Promise.all([getAiActions(project), workspaceTimeZone(project)]);
  // A run's day in the workspace's zone, as Overview dates it.
  const runDay = (iso: string) => todayIn(timeZone, new Date(iso));
  const perPrompt = Math.min(Math.max(1, Math.floor(args.actions_per_prompt ?? DEFAULT_ACTIONS_PER_PROMPT)), MAX_LIMIT);
  if (!view.prompts.length) {
    return { project: projectInfo(project), prompts: [], message: "No answers to work from yet. Actions come from the answers to the tracked AI prompts, after a run." };
  }
  const status = args.status ?? "open";
  const keep = (s: ActionStatus) => status === "all" || s === status;
  const notNamed = view.prompts.filter((p) => p.state === "not_named");
  const listed = notNamed
    .map((p) => ({ ...p, actions: p.actions.filter((a) => keep(a.status)) }))
    .filter((p) => p.actions.length || (p.noneBecause && (status === "open" || status === "all")));
  const { rows, total, truncated } = capped(listed, args.limit ?? DEFAULT_ACTION_PROMPTS);
  const latest = view.prompts.map((p) => p.runAt).sort().at(-1)!;
  return {
    project: projectInfo(project),
    source: "AI visibility run",
    latest_run: runDay(latest),
    note: `Worked out from the stored answers: a prompt is listed when its latest run's answers don't all name the site, and resolved once two runs in a row name it in every answer. write: no page of the site is cited, so write or extend one. featured: a third-party page cited in answers that leave the site out, with the tracked competitors those answers name (the page itself isn't read). thread: a Reddit, Quora or YouTube page cited the same way, with the rule for answering in person. Never post for the user, and nothing here posts anywhere. A gemini_redirect url is Gemini's link to the page, not its address, kept when it couldn't be followed or was stored before links were followed: it stops working after a while, and domain is the site it leads to. Only AI answers make actions: AI Overview sources aren't listed. Showing ${status === "all" ? "every" : status} action, at most ${perPrompt} per prompt: write first, then featured, then thread, each most cited first. actions_total is how many the prompt has.`,
    counts: {
      not_named: notNamed.length,
      waiting_to_confirm: view.prompts.filter((p) => p.state === "confirming").length,
      resolved: view.prompts.filter((p) => p.state === "resolved").length,
      actions: statusCounts(view.prompts),
    },
    prompts: rows.map((p) => ({
      prompt_id: p.promptId,
      prompt: p.prompt,
      branded: p.branded,
      run_date: runDay(p.runAt),
      answers: p.answered,
      named_in: p.named,
      not_named_on: p.missedOn.map(platformLabel),
      previous_run: p.previous && { date: runDay(p.previous.runAt), named_in_every_answer: p.previous.named },
      actions_total: p.actions.length,
      actions: p.actions.slice(0, perPrompt).map((a) => ({
        kind: a.kind,
        ...(a.url ? { url: a.url, title: a.title, domain: a.domain } : {}),
        ...(isGeminiRedirect(a.url) ? { gemini_redirect: true } : {}),
        answers: a.answers,
        platforms: [...new Set(a.platforms)].map(platformLabel),
        competitors_named: a.competitors,
        status: a.status,
        ...(a.kind === "featured" ? { on_outreach_list: a.saved } : {}),
        ...(a.kind === "thread" ? { rule: THREAD_RULE } : {}),
      })),
      ...(p.noneBecause && !p.actions.length ? { no_actions_because: p.noneBecause } : {}),
    })),
    total_prompts: total,
    truncated,
    outreach_list: view.saved.map((x) => ({ url: x.url, prompt_id: x.promptId, prompt: x.prompt, status: x.status, saved: runDay(x.savedAt.toISOString()) })),
  };
}

// ---------------------------------------------------------------------------
// Backlinks and keyword lists
// ---------------------------------------------------------------------------

export async function backlinksData(ws: WorkspaceScope, args: { project?: string | number }) {
  const project = await resolveProject(ws, args.project);
  const snaps = await listSnapshots(projectScope(project), 12);
  if (!snaps.length) return { project: projectInfo(project), snapshots: [], message: "No backlink snapshots yet. They're taken weekly once the Backlinks page has been opened." };
  return {
    project: projectInfo(project),
    snapshots: snaps.map((s) => ({
      date: s.date,
      target: s.target,
      backlinks: s.backlinks,
      referring_domains: s.referringDomains,
      domain_rank: s.rank,
      spam_score: s.spamScore,
      dofollow_share: round(s.dofollowShare, 3),
      broken_backlinks: s.brokenBacklinks,
    })),
  };
}

export async function keywordListsData(ws: WorkspaceScope, args: { project?: string | number; list?: string | number; limit?: number }) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const summaries = await listSummaries(scope);
  if (args.list == null || String(args.list).trim() === "") {
    return { project: projectInfo(project), lists: summaries.map((l) => ({ id: l.id, name: l.name, keywords: l.keywords, volume: l.volume, avg_kd: l.avgKd, updated: l.updatedAt })) };
  }
  const ref = String(args.list).trim();
  const match = summaries.find((l) => String(l.id) === ref) ?? summaries.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  const list = match ? await getList(scope, match.id) : null;
  if (!list) throw new ToolError(`No keyword list “${ref}” in this project. Call get_keyword_lists without \`list\` to see them.`);
  const items = (await listItems(list)).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  const { rows, total, truncated } = capped(items, args.limit);
  return {
    project: projectInfo(project),
    list: { id: list.id, name: list.name },
    keywords: rows.map((k) => ({ keyword: k.keyword, market: locationName(k.locationCode), volume: k.volume, kd: k.kd, cpc: k.cpc, intent: k.intent })),
    total,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Content briefs
// ---------------------------------------------------------------------------

export async function alertsData(ws: WorkspaceScope, args: { project?: string | number; status?: AlertStatus; limit?: number }) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const status = args.status ?? "all";
  const [rules, rows] = await Promise.all([ruleStates(scope), listAlerts(scope, { status, limit: limitOf(args.limit) + 1 })]);
  const { rows: shown, truncated } = capped(rows, args.limit);
  const base = `${emailOrigin()}/projects/${project.id}/alerts`;
  return {
    project: projectInfo(project),
    note: "Rules run where the data arrives: page-broken and bot-blocked when a site audit crawl finishes, left-top-10 when a rank check finishes. One thing alerts once while it stays broken, and an alert closes when a later check finds it fixed. Alert emails go to people who get the weekly recap: at most one a day per project, and an urgent one at once for page-broken and bot-blocked.",
    rules: rules.map((r) => ({ rule: r.rule, label: RULES[r.rule].label, checks: RULES[r.rule].description, urgent: RULES[r.rule].urgent, enabled: r.enabled })),
    showing: status,
    alerts: shown.map((a) => ({
      id: a.id,
      rule: a.rule,
      urgent: a.urgent,
      title: a.title,
      detail: a.detail,
      source: a.source,
      detected_at: a.detectedAt.toISOString(),
      resolved_at: a.resolvedAt?.toISOString() ?? null,
      emailed_at: a.emailedAt?.toISOString() ?? null,
      link: `${base}/${a.id}`,
    })),
    truncated,
    ...(shown.length ? {} : { message: status === "open" ? "No open alerts." : "No alerts yet. They come from site audit crawls and rank checks." }),
  };
}

export async function contentBriefsData(ws: WorkspaceScope, args: { project?: string | number; limit?: number }) {
  const project = await resolveProject(ws, args.project);
  const briefs = await listBriefs(projectScope(project));
  const { rows, total, truncated } = capped(briefs, args.limit);
  return {
    project: projectInfo(project),
    briefs: rows.map((b) => ({
      id: b.id,
      keyword: b.keyword,
      page_type: PAGE_TYPE_LABEL[b.pageType] ?? b.pageType,
      volume: b.brief.target.volume,
      to_fill: toFill(b.brief, b.fill).length,
      credits_spent: b.creditsSpent,
      created: b.createdAt.toISOString(),
    })),
    total,
    truncated,
    ...(briefs.length ? {} : { message: "No briefs yet. create_content_brief makes one, or Keyword research → Briefs in SEOpen." }),
  };
}

export async function contentBriefData(ws: WorkspaceScope, args: { project?: string | number; brief: number }) {
  const project = await resolveProject(ws, args.project);
  const view = await getBrief(projectScope(project), args.brief);
  if (!view) throw new ToolError(`No brief ${args.brief} in this project. Call list_content_briefs to see them.`);
  const timeZone = await workspaceTimeZone(project);
  return {
    project: projectInfo(project),
    id: view.id,
    keyword: view.keyword,
    page_type: PAGE_TYPE_LABEL[view.pageType] ?? view.pageType,
    credits_spent: view.creditsSpent,
    created: view.createdAt.toISOString(),
    to_fill: toFill(view.brief, view.fill),
    note: "A brief, never the article. Every figure carries its source and date; repeat them when you use one. Items under To fill are for the site owner: ask them rather than guessing, and never make up prices, test results or numbers.",
    markdown: exportMarkdown(view, (iso) => formatDate(iso, timeZone)),
  };
}

// ---------------------------------------------------------------------------
// Local SEO
// ---------------------------------------------------------------------------

/** One keyword's latest grid result, and the change since the check before that searched it. */
function localStats(s: KeywordStats, prev: KeywordStats | null) {
  return {
    avg_rank: round(avgRank(s)),
    top3_pct: round(top3Share(s) == null ? null : top3Share(s)! * 100),
    found_pct: round(foundShare(s) == null ? null : foundShare(s)! * 100),
    points_answered: s.answered,
    points_failed: s.failed,
    avg_rank_change: round(rankChange(s, prev)),
  };
}

export async function localData(ws: WorkspaceScope, args: { project?: string | number }) {
  const project = await resolveProject(ws, args.project);
  const scope = projectScope(project);
  const businesses = await listBusinesses(scope);
  if (!businesses.length) return { project: projectInfo(project), businesses: [], note: "No Local SEO listings yet. Add one with find_local_listing and add_local_business, or on Local SEO in SEOpen." };
  const ids = businesses.map((b) => b.id);
  const [keywords, checks] = await Promise.all([listKeywords(scope, ids), listChecks(scope, ids, 200)]);
  const stats = await checkStats(
    scope,
    checks.map((c) => c.id),
  );
  return {
    project: projectInfo(project),
    note: "Avg rank is the listing's mean Google Maps position over the grid points where it appears (lower is better); found is the share of answered points where it appears at all, top 3 the share where it's in the map pack. Avg rank change compares with the previous check of the same keyword; negative is better.",
    businesses: businesses.map((b) => {
      const { latest } = latestPair(checks, b.id);
      const running = checks.find((c) => c.businessId === b.id && (c.status === "posting" || c.status === "pending") && c.id !== latest?.id);
      return {
        id: b.id,
        title: b.title,
        address: b.address,
        category: b.category,
        grid: gridLabel(b.gridSize, b.radiusMiles),
        weekly: b.scheduled,
        latest_check: latest ? (latest.finishedAt ?? latest.createdAt).toISOString().slice(0, 10) : null,
        check_running: !!running,
        keywords: keywords
          .filter((k) => k.businessId === b.id)
          .map((k) => {
            const cur = latest ? stats.get(`${latest.id}:${k.id}`) : undefined;
            if (!latest || !cur?.answered) return { keyword: k.keyword, checked: false };
            const prevCheck = previousFor(checks, latest, k.id, stats);
            return { keyword: k.keyword, checked: true, ...localStats(cur, prevCheck ? (stats.get(`${prevCheck.id}:${k.id}`) ?? null) : null) };
          }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** The key's name, or the connected app's, as the MCP page shows it. */
export async function connectionName(principal: Principal): Promise<string | null> {
  const { via } = principal;
  if (via.kind === "app") return via.name;
  const [key] = await db.select({ name: apiKeys.name }).from(apiKeys).where(and(eq(apiKeys.id, via.keyId), eq(apiKeys.workspaceId, principal.workspaceId)));
  return key?.name ?? null;
}

/** The connection itself: whose key (or connected app) this is and what it may do. */
export async function whoamiData(principal: Principal) {
  const [name, [workspace], list] = await Promise.all([
    connectionName(principal),
    db
      .select({ name: workspaces.name, plan: workspaces.plan, grantedAt: workspaces.grantedAt, grantEndsAt: workspaces.grantEndsAt })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId)),
    listProjectsData({ workspaceId: principal.workspaceId }),
  ]);
  return {
    workspace: workspace?.name ?? null,
    plan: workspace ? withEndedGrant(workspace).plan : null,
    key: { name, can_make_changes: canWrite(principal), can_spend_research_credits: canResearch(principal) },
    signed_in_with: principal.via.kind === "key" ? "api_key" : "oauth",
    projects: list.projects.length,
  };
}

export async function usageData(ws: WorkspaceScope) {
  const [u, block] = await Promise.all([usageSummary(ws.workspaceId), spendBlock(ws.workspaceId, { research: true })]);
  const plan = u.state.workspace.plan;
  const creditsLeft = u.creditsTotal == null ? null : Math.max(0, u.creditsTotal - u.creditsUsed);
  return {
    plan,
    research_credits: { used: u.creditsUsed, total: u.creditsTotal, left: creditsLeft, note: `1 credit = $0.01 of data. Research lookups show their price in ${rules.hasPlans ? "credits" : "dollars, and in credits for max_credits,"} before they run. That price is the most a lookup can cost: it's charged its real cost up to that price, so \`used\` can move by less than the prices add up to.` },
    // Dollar figures only for the owner's workspace, as in the app.
    ...(isInternal(u.state.workspace)
      ? { spend_usd: { this_month: round(u.spentUsd, 2), note: `Everything this workspace cost this month: research lookups plus ${rules.hasPlans ? "the work the plan covers" : "the checks it runs"}, such as rank checks, site audits, backlink snapshots and the Monday AI run.`, ceiling: Number.isFinite(u.ceilingUsd) ? u.ceilingUsd : null, ceiling_credits: Number.isFinite(u.ceilingUsd) ? creditsFor(u.ceilingUsd) : null } }
      : {}),
    paid_lookups: block ? { allowed: false, reason: plainRefusal(block.message) } : { allowed: true },
  };
}

