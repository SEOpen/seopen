/** Read-side queries for the ai pages and dashboard card. Only stored data; no paid calls. */
import { and, asc, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import { db } from "@/db";
import { aiActions, aiLlmMentions, aiOverviews, aiPrompts, aiResults, aiRuns } from "@/db/schema/ai";
import { callFailed, lastCalls, type LastCall } from "@/lib/dataforseo/client";
import { formatTimestamp } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { inScope, projectScope, workspaceTimeZone, type ProjectScope } from "@/lib/workspace";
import { buildPromptActions, type PromptActions } from "./action-list";
import { hostOf, namesBrand, type Brand } from "./detect";
import { LLM_MENTIONS_ENDPOINTS } from "./dfs";
import { answeredPerPair, citedByRun, failedPerPlatform, shareOfVoice, visibility, visibilityByPlatform, withoutFailedRuns, type AnswerRow } from "./metrics";
import { PLATFORM_KEYS } from "./platforms";
import { loadBrands } from "./run";
import { citedSources, suggestCompetitors } from "./sources";

export type Prompt = typeof aiPrompts.$inferSelect;
export type Result = typeof aiResults.$inferSelect;
export type Run = typeof aiRuns.$inferSelect;

export async function listPrompts(scope: ProjectScope): Promise<Prompt[]> {
  return db.select().from(aiPrompts).where(inScope(aiPrompts, scope)).orderBy(asc(aiPrompts.createdAt), asc(aiPrompts.id));
}

/** Topics in use on the project, alphabetically. */
export async function listTopics(scope: ProjectScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ topic: aiPrompts.topic })
    .from(aiPrompts)
    .where(and(inScope(aiPrompts, scope), isNotNull(aiPrompts.topic)))
    .orderBy(asc(aiPrompts.topic));
  return rows.map((r) => r.topic!);
}

export async function listRuns(scope: ProjectScope, limit = 30): Promise<Run[]> {
  return db.select().from(aiRuns).where(inScope(aiRuns, scope)).orderBy(desc(aiRuns.startedAt)).limit(limit);
}

/** When the newest answers still counted are from: the start of the newest run with a finished answer to an active prompt, whatever became of that run. */
export async function latestAnswerAt(scope: ProjectScope): Promise<Date | null> {
  const [row] = await db
    .select({ at: aiRuns.startedAt })
    .from(aiResults)
    .innerJoin(aiRuns, and(eq(aiRuns.id, aiResults.runId), eq(aiRuns.workspaceId, aiResults.workspaceId)))
    .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiResults.promptId), eq(aiPrompts.workspaceId, aiResults.workspaceId)))
    .where(and(inScope(aiResults, scope), eq(aiResults.status, "done"), eq(aiPrompts.active, true)))
    .orderBy(desc(aiRuns.startedAt))
    .limit(1);
  return row?.at ?? null;
}

/** Each project's newest run, for All projects, with one query however many projects there are. Only projects with a prompt to ask. */
export async function newestRuns(workspaceId: number, projectIds: number[]) {
  if (!projectIds.length) return [];
  const [runs, tracking] = await Promise.all([
    db
      .selectDistinctOn([aiRuns.projectId], { projectId: aiRuns.projectId, status: aiRuns.status, error: aiRuns.error, createdAt: aiRuns.startedAt })
      .from(aiRuns)
      .where(and(eq(aiRuns.workspaceId, workspaceId), inArray(aiRuns.projectId, projectIds)))
      .orderBy(aiRuns.projectId, desc(aiRuns.startedAt), desc(aiRuns.id)),
    db
      .selectDistinct({ projectId: aiPrompts.projectId })
      .from(aiPrompts)
      .where(and(eq(aiPrompts.workspaceId, workspaceId), inArray(aiPrompts.projectId, projectIds), eq(aiPrompts.active, true))),
  ]);
  const live = new Set(tracking.map((p) => p.projectId));
  return runs.filter((r) => live.has(r.projectId));
}

/** The run in progress, if any. */
export async function activeRun(scope: ProjectScope): Promise<Run | null> {
  const [r] = await db
    .select()
    .from(aiRuns)
    .where(and(inScope(aiRuns, scope), inArray(aiRuns.status, ["queued", "running"])))
    .orderBy(desc(aiRuns.startedAt))
    .limit(1);
  return r ?? null;
}

type FinishedRow = AnswerRow & { runId: number; prompt: string; citations: Result["citations"]; failed: boolean; /** The prompt is still asked on this platform. */ asked: boolean };

/**
 * Every answer that finished for the project's active prompts, the failed ones too, oldest run first.
 * The numbers count them through `answeredPerPair`, so a failed answer leaves its pair out instead of
 * letting an older answer stand in.
 */
async function finishedAnswers(scope: ProjectScope): Promise<FinishedRow[]> {
  const rows = await db
    .select({
      runId: aiResults.runId,
      promptId: aiResults.promptId,
      platform: aiResults.platform,
      status: aiResults.status,
      mentioned: aiResults.mentioned,
      cited: aiResults.cited,
      position: aiResults.position,
      mentions: aiResults.mentions,
      citations: aiResults.citations,
      prompt: aiPrompts.prompt,
      platforms: aiPrompts.platforms,
      startedAt: aiRuns.startedAt,
    })
    .from(aiResults)
    .innerJoin(aiRuns, and(eq(aiRuns.id, aiResults.runId), eq(aiRuns.workspaceId, aiResults.workspaceId)))
    .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiResults.promptId), eq(aiPrompts.workspaceId, aiResults.workspaceId)))
    .where(and(inScope(aiResults, scope), inArray(aiResults.status, ["done", "failed"]), eq(aiPrompts.active, true)))
    .orderBy(asc(aiRuns.startedAt));
  // Sortable "at": ISO run start plus run id, so two runs on the same second still order.
  return rows.map(({ status, platforms, ...r }) => ({
    ...r,
    failed: status === "failed",
    asked: platforms.includes(r.platform),
    at: `${r.startedAt.toISOString()}#${String(r.runId).padStart(8, "0")}`,
  }));
}

/** The project's newest run that has finished, whatever became of it. One still running isn't one. */
async function newestClosedRun(scope: ProjectScope) {
  const [run] = await db
    .select({ id: aiRuns.id, startedAt: aiRuns.startedAt })
    .from(aiRuns)
    .where(and(inScope(aiRuns, scope), inArray(aiRuns.status, ["done", "failed"])))
    .orderBy(desc(aiRuns.startedAt), desc(aiRuns.id))
    .limit(1);
  return run ?? null;
}

export interface Overview {
  brands: Brand[];
  /** Active prompts with answers that name our brand in the question, and those that don't. */
  promptCounts: { branded: number; nonBranded: number };
  /** Whether branded prompts are counted in these numbers. */
  includesBranded: boolean;
  /**
   * Branded prompts and generic ones (the question doesn't name us) counted apart, from the same latest
   * answers, whatever the project's setting: branded prompts can hide weak generic visibility.
   */
  groups: { branded: ReturnType<typeof visibility>; generic: ReturnType<typeof visibility> };
  current: ReturnType<typeof visibility>;
  previous: ReturnType<typeof visibility> | null;
  byPlatform: ReturnType<typeof visibilityByPlatform>;
  previousByPlatform: ReturnType<typeof visibilityByPlatform>;
  /** Prompt × platform pairs whose newest answer failed. Every number here leaves them out, as unknown. */
  failed: number;
  failedByPlatform: Record<string, number>;
  sov: ReturnType<typeof shareOfVoice>;
  previousSov: ReturnType<typeof shareOfVoice> | null;
  /**
   * One point per run that got answers: overall visibility and each brand's mention rate (0–100), counted as
   * the headline counts them after that run, so the last point is `current`.
   */
  trend: Record<string, string | number | null>[];
  lastRunAt: Date | null;
  /**
   * When the newest run got no answer back, its start in the workspace's zone, as the trend's dates read.
   * The numbers are then the run before's, and there's no `previous`: comparing two older runs would read as this week's change.
   */
  failedRun: string | null;
}

/**
 * The answers the visibility numbers count: branded prompts (the question names `own`) are
 * dropped unless `includeBranded` (the project's setting), or unless every prompt is branded,
 * so the numbers aren't empty.
 */
function countedAnswers<R extends { promptId: number; prompt: string }>(all: R[], own: Brand, includeBranded: boolean) {
  const texts = new Map(all.map((r) => [r.promptId, r.prompt]));
  const branded = new Set([...texts].filter(([, text]) => namesBrand(text, own)).map(([id]) => id));
  const promptCounts = { branded: branded.size, nonBranded: texts.size - branded.size };
  const includesBranded = includeBranded || promptCounts.nonBranded === 0;
  return { rows: includesBranded ? all : all.filter((r) => !branded.has(r.promptId)), promptCounts, includesBranded, branded };
}

const totalFailed = (failedByPlatform: Record<string, number>) => Object.values(failedByPlatform).reduce((sum, n) => sum + n, 0);

/**
 * The answers every AI number counts, shared by /ai, the dashboard card and MCP: branded prompts as the
 * project counts them, runs that got nothing back left out. `failedByPlatform` counts the pairs whose
 * newest answer failed, on platforms the prompt is still asked on, so a branded prompt left out of the
 * numbers is left out there too. `failedRun` is the newest run when it got no answer back.
 */
async function countedState(project: Project) {
  const scope = projectScope(project);
  const [brands, finished, closed] = await Promise.all([loadBrands(project), finishedAnswers(scope), newestClosedRun(scope)]);
  const { rows: counted, promptCounts, includesBranded, branded } = countedAnswers(finished, brands[0], project.aiIncludeBranded);
  const rows = withoutFailedRuns(counted);
  const failedRun = closed && !finished.some((r) => r.runId === closed.id && !r.failed) ? closed.startedAt : null;
  // Every prompt's latest answers, branded or not, for counting the two groups apart.
  const everyLatest = answeredPerPair(withoutFailedRuns(finished));
  const groups = { branded: visibility(everyLatest.filter((r) => branded.has(r.promptId))), generic: visibility(everyLatest.filter((r) => !branded.has(r.promptId))) };
  return { brands, rows, promptCounts, includesBranded, groups, failedByPlatform: failedPerPlatform(rows.filter((r) => r.asked)), failedRun };
}

/** The answers as they stood after the latest run, and after the one before it. Nothing before when the newest run got no answer back. */
function latestAndBefore(rows: FinishedRow[], failedRun: Date | null) {
  const lastRun = rows.at(-1)?.runId;
  const before = lastRun == null || failedRun ? [] : answeredPerPair(rows.filter((r) => r.runId !== lastRun));
  return { latest: answeredPerPair(rows), before };
}

/**
 * KPIs from the latest answer per prompt × platform, compared with the same view as of the
 * run before the latest one. Branded prompts (the question names us) are left out unless the
 * project counts them (`aiIncludeBranded`), since an answer to "Is Alphanote any good?" names us almost by definition.
 * When every prompt is branded they are counted anyway, so the page isn't empty.
 */
export async function getOverview(project: Project): Promise<Overview> {
  const [{ brands, rows, promptCounts, includesBranded, groups, failedByPlatform, failedRun }, timeZone] = await Promise.all([countedState(project), workspaceTimeZone(project)]);
  const tracked = brands.map((b) => ({ domain: b.domain, own: b.own }));
  const runIds = [...new Set(rows.map((r) => r.runId))];
  const { latest, before } = latestAndBefore(rows, failedRun);

  const trend = runIds.map((id) => {
    const at = rows.find((r) => r.runId === id)!.at;
    // As the headline counts them after this run, so the last point and the headline can't disagree.
    const counted = answeredPerPair(rows.filter((r) => r.at <= at));
    const v = visibility(counted);
    const point: Record<string, string | number | null> = {
      // The run's start in the workspace's zone, with the time so two runs on one day stay apart on the axis.
      date: formatTimestamp(at.split("#")[0], timeZone),
      visibility: v.score == null ? null : Math.round(v.score * 1000) / 10,
    };
    for (const s of shareOfVoice(counted, tracked)) point[s.domain] = s.rate == null ? null : Math.round(s.rate * 1000) / 10;
    return point;
  });

  return {
    brands,
    promptCounts,
    includesBranded,
    groups,
    current: visibility(latest),
    previous: before.length ? visibility(before) : null,
    byPlatform: visibilityByPlatform(latest, PLATFORM_KEYS),
    previousByPlatform: visibilityByPlatform(before, PLATFORM_KEYS),
    failed: totalFailed(failedByPlatform),
    failedByPlatform,
    sov: shareOfVoice(latest, tracked),
    previousSov: before.length ? shareOfVoice(before, tracked) : null,
    trend,
    lastRunAt: rows.length ? new Date(rows[rows.length - 1].at.split("#")[0]) : null,
    failedRun: failedRun && formatTimestamp(failedRun, timeZone),
  };
}

/** Compact numbers for the dashboard card, counting prompts the way Overview does. */
export async function getSummary(project: Project) {
  const { rows, promptCounts, includesBranded, failedByPlatform, failedRun } = await countedState(project);
  if (!rows.length) return null;
  const { latest, before } = latestAndBefore(rows, failedRun);
  return {
    current: visibility(latest),
    previous: before.length ? visibility(before) : null,
    /** Prompt × platform pairs whose newest answer failed, as on /ai. `current` leaves them out. */
    failed: totalFailed(failedByPlatform),
    /** The newest run got no answer back, so there's no `previous` to compare with. */
    failedRun: !!failedRun,
    /** How many engines answered in the latest answers. */
    engines: new Set(latest.map((r) => r.platform)).size,
    trend: citedByRun(rows),
    lastRunAt: new Date(rows[rows.length - 1].at.split("#")[0]),
    /** Whether the numbers leave branded prompts out or count them; null when there are none. */
    branded: !promptCounts.branded ? null : includesBranded ? ("counted" as const) : ("left out" as const),
  };
}

export interface PromptRow {
  prompt: Prompt;
  /** Latest finished (or pending/failed) result per platform. */
  results: Partial<Record<string, Pick<Result, "status" | "mentioned" | "cited" | "position" | "completedAt" | "error">>>;
  aio: Pick<typeof aiOverviews.$inferSelect, "status" | "present" | "cited" | "createdAt"> | null;
}

/** Prompts with their latest result per platform and latest AI Overview check. */
export async function getPromptTable(scope: ProjectScope): Promise<PromptRow[]> {
  const [prompts, results, aio] = await Promise.all([
    listPrompts(scope),
    db
      .select({
        id: aiResults.id,
        promptId: aiResults.promptId,
        platform: aiResults.platform,
        status: aiResults.status,
        mentioned: aiResults.mentioned,
        cited: aiResults.cited,
        position: aiResults.position,
        completedAt: aiResults.completedAt,
        error: aiResults.error,
      })
      .from(aiResults)
      .where(inScope(aiResults, scope))
      .orderBy(asc(aiResults.id)),
    db
      .select({ promptId: aiOverviews.promptId, status: aiOverviews.status, present: aiOverviews.present, cited: aiOverviews.cited, createdAt: aiOverviews.createdAt })
      .from(aiOverviews)
      .where(inScope(aiOverviews, scope))
      .orderBy(asc(aiOverviews.id)),
  ]);
  return prompts.map((p) => {
    const res: PromptRow["results"] = {};
    // Ascending ids: a finished answer is replaced only by a newer finished one, so an
    // in-flight run doesn't blank out last week's result.
    for (const r of results) {
      if (r.promptId !== p.id) continue;
      const cur = res[r.platform];
      if (!cur || r.status !== "pending" || cur.status === "pending") res[r.platform] = r;
    }
    const a = aio.filter((x) => x.promptId === p.id && x.status === "done").at(-1) ?? null;
    return { prompt: p, results: res, aio: a };
  });
}

/** Everything for one prompt: latest answer per platform, history, AI Overview checks. */
export async function getPromptDetail(scope: ProjectScope, promptId: number) {
  if (!Number.isInteger(promptId)) return null;
  const [prompt] = await db.select().from(aiPrompts).where(and(eq(aiPrompts.id, promptId), inScope(aiPrompts, scope)));
  if (!prompt) return null;
  const [results, overviews] = await Promise.all([
    db
      .select({ result: aiResults, startedAt: aiRuns.startedAt })
      .from(aiResults)
      .innerJoin(aiRuns, and(eq(aiRuns.id, aiResults.runId), eq(aiRuns.workspaceId, aiResults.workspaceId)))
      .where(and(eq(aiResults.workspaceId, scope.workspaceId), eq(aiResults.promptId, prompt.id)))
      .orderBy(desc(aiRuns.startedAt), desc(aiResults.id)),
    db.select().from(aiOverviews).where(and(eq(aiOverviews.workspaceId, scope.workspaceId), eq(aiOverviews.promptId, prompt.id))).orderBy(desc(aiOverviews.createdAt)),
  ]);
  const latest = new Map<string, Result>();
  for (const { result } of results) if (result.status === "done" && !latest.has(result.platform)) latest.set(result.platform, result);
  return {
    prompt,
    latest,
    history: results.map((r) => ({ ...r.result, startedAt: r.startedAt })),
    aio: overviews,
  };
}

/** Most-cited domains and URLs across the answers counted, as /ai counts them (`answeredPerPair`). */
export async function getSources(project: Project) {
  const [brands, rows] = await Promise.all([loadBrands(project), finishedAnswers(projectScope(project))]);
  const latest = answeredPerPair(withoutFailedRuns(rows));
  return { answers: latest.length, ...citedSources(latest, brands) };
}

/** Latest LLM Mentions fetch for the project, one row per domain × platform. */
export async function getLlmMentions(scope: ProjectScope) {
  const [last] = await db
    .select({ at: aiLlmMentions.fetchedAt })
    .from(aiLlmMentions)
    .where(inScope(aiLlmMentions, scope))
    .orderBy(desc(aiLlmMentions.fetchedAt))
    .limit(1);
  if (!last) return null;
  const rows = await db
    .select()
    .from(aiLlmMentions)
    .where(and(inScope(aiLlmMentions, scope), eq(aiLlmMentions.fetchedAt, last.at)))
    .orderBy(desc(aiLlmMentions.own), asc(aiLlmMentions.domain));
  return { fetchedAt: last.at, rows };
}

/**
 * The newest Mentions refresh, when it failed after the stored numbers were fetched. A failed refresh doesn't
 * stop the run, so only the ledger, which keeps every call with its status, records it.
 */
export async function mentionsFailure(scope: ProjectScope): Promise<LastCall | null> {
  const [calls, [stored]] = await Promise.all([
    lastCalls(scope.workspaceId, [scope.projectId], "ai", LLM_MENTIONS_ENDPOINTS),
    db.select({ at: max(aiLlmMentions.fetchedAt) }).from(aiLlmMentions).where(inScope(aiLlmMentions, scope)),
  ]);
  const call = calls.get(scope.projectId);
  if (!callFailed(call) || (stored?.at && stored.at >= call.at)) return null;
  return call;
}

/** What an AI Overview row stores when its run stopped before posting it. The run's own error says why. */
const UNPOSTED = "Run stopped before this task was posted";

/** Latest AI Overview check per prompt, and whether the newest check failed. */
export async function getAioSummary(scope: ProjectScope) {
  const rows = await db
    .select({ promptId: aiOverviews.promptId, present: aiOverviews.present, cited: aiOverviews.cited, mentioned: aiOverviews.mentioned, createdAt: aiOverviews.createdAt })
    .from(aiOverviews)
    .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiOverviews.promptId), eq(aiPrompts.workspaceId, aiOverviews.workspaceId)))
    .where(and(inScope(aiOverviews, scope), eq(aiOverviews.status, "done"), eq(aiPrompts.active, true)))
    .orderBy(asc(aiOverviews.createdAt));
  const latest = new Map<number, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.promptId, r);
  const list = [...latest.values()];
  return {
    checked: list.length,
    present: list.filter((r) => r.present).length,
    cited: list.filter((r) => r.cited).length,
    mentioned: list.filter((r) => r.mentioned).length,
    lastAt: list.length ? list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt : null,
    failed: await failedAioCheck(scope),
  };
}

/**
 * The newest run's AI Overview check, when none of it came back: every keyword failed, or its run closed
 * before posting them. A check still waiting on its tasks is in flight. `stored` is the row's error, or the
 * run's when the row only says the run stopped.
 */
async function failedAioCheck(scope: ProjectScope): Promise<{ at: Date; stored: string | null } | null> {
  const [newest] = await db
    .select({ runId: aiOverviews.runId })
    .from(aiOverviews)
    .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiOverviews.promptId), eq(aiPrompts.workspaceId, aiOverviews.workspaceId)))
    .where(and(inScope(aiOverviews, scope), eq(aiPrompts.active, true)))
    .orderBy(desc(aiOverviews.createdAt), desc(aiOverviews.id))
    .limit(1);
  if (!newest) return null;
  const attempt = await db
    .select({ status: aiOverviews.status, taskId: aiOverviews.taskId, error: aiOverviews.error, createdAt: aiOverviews.createdAt, runStatus: aiRuns.status, runError: aiRuns.error })
    .from(aiOverviews)
    .innerJoin(aiRuns, eq(aiRuns.id, aiOverviews.runId))
    .where(and(inScope(aiOverviews, scope), eq(aiOverviews.runId, newest.runId)));
  const runOpen = (r: (typeof attempt)[number]) => r.runStatus === "queued" || r.runStatus === "running";
  if (!attempt.length || attempt.some((r) => r.status === "done" || (r.status === "pending" && (r.taskId || runOpen(r))))) return null;
  const error = attempt.find((r) => r.status === "failed")?.error ?? null;
  return { at: attempt[0].createdAt, stored: !error || error === UNPOSTED ? (attempt[0].runError ?? error) : error };
}

/** Cited sites that look like untracked competitors, over the answers counted, as /ai counts them. */
export async function getSuggestedCompetitors(project: Project, brands?: Brand[]) {
  const [list, rows] = await Promise.all([brands ?? loadBrands(project), finishedAnswers(projectScope(project))]);
  const latest = answeredPerPair(withoutFailedRuns(rows));
  return { answers: latest.length, suggestions: suggestCompetitors(latest, list) };
}

/** A cited page saved to the outreach list from an action, with the prompt it came from. */
export interface SavedPage {
  promptId: number;
  prompt: string;
  url: string;
  domain: string;
  status: string;
  savedAt: Date;
}

export interface AiActionsView {
  brands: Brand[];
  /** Every prompt with an answer, with its state and, when the site isn't named, its actions. */
  prompts: PromptActions[];
  /** Pages saved to the outreach list, newest first. */
  saved: SavedPage[];
}

/**
 * AI visibility → Actions: each active prompt's latest answers on the platforms it's still asked on,
 * turned into actions, with the statuses saved in `ai_actions`. Stored data only.
 */
export async function getAiActions(project: Project): Promise<AiActionsView> {
  const scope = projectScope(project);
  const [brands, finished, stored] = await Promise.all([
    loadBrands(project),
    finishedAnswers(scope),
    db
      .select({ promptId: aiActions.promptId, kind: aiActions.kind, url: aiActions.url, status: aiActions.status, savedAt: aiActions.savedAt, prompt: aiPrompts.prompt })
      .from(aiActions)
      .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiActions.promptId), eq(aiPrompts.workspaceId, aiActions.workspaceId)))
      .where(inScope(aiActions, scope)),
  ]);
  const prompts = buildPromptActions(finished.filter((r) => r.asked), brands, stored);
  const saved = stored
    .filter((s): s is typeof s & { savedAt: Date } => s.kind === "featured" && !!s.savedAt)
    .map((s) => ({ promptId: s.promptId, prompt: s.prompt, url: s.url, domain: hostOf(s.url), status: s.status, savedAt: s.savedAt }))
    .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime() || a.url.localeCompare(b.url));
  return { brands, prompts, saved };
}
