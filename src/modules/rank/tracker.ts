// Rank checks on the DataForSEO Standard queue: post tasks, poll tasks_ready, store results.
// Runs in the worker (jobs.ts) only. Pages read the tables through queries.ts.
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/db";
import { projects } from "@/db/schema/core";
import {
  ONE_ACTIVE_RUN_INDEX,
  rankKeywords,
  rankResults,
  rankRuns,
  rankSettings,
  rankTasks,
} from "@/db/schema/rank";
import { ledgerSource, withBillingContext } from "@/lib/billing/context";
import { POSTING_NEVER_FINISHED, STALE_POSTING_MS } from "@/lib/check-failure";
import { dfsGet, dfsPost, taskResults, TTL, type DfsTask } from "@/lib/dataforseo/client";
import { RESOLVE_POISONED } from "@/lib/dataforseo/poisoned";
import { trackedLocation } from "@/lib/dataforseo/locations";
import { adsAccepts } from "@/lib/dataforseo/place-names";
import { activeProjects, type ProjectScope } from "@/lib/workspace";
import { alertsFromRun } from "@/modules/alerts/record";
import { hasSearchOperators } from "@/modules/keywords/lookup-quote";
import { knownKd } from "@/modules/keywords/transform";
import { labsCost } from "@/modules/keywords/requests";
import { isUniqueViolation } from "./db-errors";
import { estimateCheckCost } from "./metrics";
import { makeTag, parseSerp, parseTag, type ParsedSerp } from "./parse";
import { baselineFrom, MAX_MISS_DAYS, missDays, nextStep, searchConsoleHint } from "./recheck";
import { searchConsoleAverages } from "./search-console";
import type { AdsVolumeResult, KeywordOverviewResult, SerpAdvancedResult, TasksReadyResult } from "./types";

export type RankSettings = typeof rankSettings.$inferSelect;
export type RankRun = typeof rankRuns.$inferSelect;
export type RunKind = RankRun["kind"];

export const DEFAULT_SETTINGS = { dailyDepth: 20, sweepDepth: 100, sweepWeekday: 0, enabled: true } as const;

/** Today's date in UTC, "2026-10-29". */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function getSettings(scope: ProjectScope): Promise<RankSettings> {
  const [row] = await db
    .select()
    .from(rankSettings)
    .where(and(eq(rankSettings.workspaceId, scope.workspaceId), eq(rankSettings.projectId, scope.projectId)));
  return row ?? { ...scope, ...DEFAULT_SETTINGS, updatedAt: new Date(0) };
}

/** A run of the scope's project, or null (also for another workspace's run id). */
export async function getRun(scope: ProjectScope, runId: number): Promise<RankRun | null> {
  if (!Number.isInteger(runId)) return null;
  const [run] = await db
    .select()
    .from(rankRuns)
    .where(and(eq(rankRuns.id, runId), eq(rankRuns.workspaceId, scope.workspaceId), eq(rankRuns.projectId, scope.projectId)));
  return run ?? null;
}

/**
 * Creates a run row (status "posting"). The rank.check job posts it.
 *
 * Returns null when the project already has a run in flight: a partial unique
 * index allows one "posting"/"pending" run per project, so a double click or a
 * scheduled check racing "Check now" can't pay twice.
 */
export async function createRun(
  scope: ProjectScope,
  kind: RunKind,
  opts: { depth: number; aiOverview: boolean; date?: string },
): Promise<RankRun | null> {
  // A stuck "posting" run would otherwise block every later check for the project.
  await db
    .update(rankRuns)
    .set({ status: "failed", error: POSTING_NEVER_FINISHED, finishedAt: new Date() })
    .where(
      and(
        eq(rankRuns.workspaceId, scope.workspaceId),
        eq(rankRuns.projectId, scope.projectId),
        eq(rankRuns.status, "posting"),
        lt(rankRuns.createdAt, new Date(Date.now() - STALE_POSTING_MS)),
      ),
    );
  try {
    const [run] = await db
      .insert(rankRuns)
      .values({ ...scope, kind, date: opts.date ?? utcToday(), depth: opts.depth, aiOverview: opts.aiOverview, source: ledgerSource() })
      .returning();
    return run;
  } catch (e) {
    if (isUniqueViolation(e, ONE_ACTIVE_RUN_INDEX)) return null;
    throw e;
  }
}

/**
 * Ends the posting of the runs `which` picks. What was posted goes on to be polled, and `refreshRun`
 * closes the run. A run with nothing posted has failed, for `reason`.
 */
async function stopPosting(which: SQL | undefined, reason: string): Promise<void> {
  const posted = sql<number>`(select count(*)::int from ${rankTasks} where ${rankTasks.runId} = ${rankRuns.id})`;
  const stopped = await db
    .update(rankRuns)
    .set({
      status: sql<"pending" | "failed">`case when ${posted} > 0 then 'pending' else 'failed' end`,
      tasksTotal: posted,
      error: sql<string | null>`case when ${posted} > 0 then null else ${reason}::text end`,
      finishedAt: sql<Date | null>`case when ${posted} > 0 then null else now() end`,
    })
    .where(and(eq(rankRuns.status, "posting"), which))
    .returning({ id: rankRuns.id });
  // Tasks that finished while it was still posting: no later poll would come back to this run.
  for (const { id } of stopped) await refreshRun(id);
}

/**
 * The rank.check job was refused, so nothing else will post this run. Without this it reads as
 * running, and blocks the project's next check and the workspace's delete. A resumed job then finds
 * it closed and does nothing, as it does for a run the client refused partway through posting.
 */
export async function closeRefusedRun({ workspaceId, projectId, runId }: { workspaceId?: number; projectId?: number; runId: number }, reason: string): Promise<void> {
  if (!Number.isInteger(workspaceId) || !Number.isInteger(projectId) || !Number.isInteger(runId)) return;
  await stopPosting(and(eq(rankRuns.id, runId), eq(rankRuns.workspaceId, workspaceId!), eq(rankRuns.projectId, projectId!)), reason);
}

const POST_BATCH = 100;

/**
 * Posts one task per active keyword for a run of the scope's project. Safe to retry: keywords
 * that already have a task for this run are skipped. A run id from another project does nothing.
 */
export async function postRun(scope: ProjectScope, runId: number): Promise<void> {
  const run = await getRun(scope, runId);
  if (!run || run.status !== "posting") return;
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) return;

  // Every task of a run searches from one place, also when a retry comes after the project moved.
  const locationCode = run.locationCode ?? trackedLocation(project);
  if (run.locationCode == null) {
    await db.update(rankRuns).set({ locationCode }).where(and(eq(rankRuns.id, runId), eq(rankRuns.workspaceId, scope.workspaceId)));
  }

  const keywords = await db
    .select()
    .from(rankKeywords)
    .where(and(eq(rankKeywords.workspaceId, scope.workspaceId), eq(rankKeywords.projectId, scope.projectId), eq(rankKeywords.active, true)));
  const posted = new Set(
    (
      await db
        .select({ k: rankTasks.keywordId })
        .from(rankTasks)
        .where(and(eq(rankTasks.workspaceId, scope.workspaceId), eq(rankTasks.runId, runId)))
    ).map((r) => r.k),
  );
  const todo = keywords.filter((k) => !posted.has(k.id));

  let cost = 0;
  let failed = 0;
  let answered = 0;
  let error: string | null = null;
  try {
    for (let i = 0; i < todo.length; i += POST_BATCH) {
      const batch = todo.slice(i, i + POST_BATCH);
      const res = await dfsPost<null>(
        "serp/google/organic/task_post",
        batch.map((k) => ({
          keyword: k.keyword,
          location_code: locationCode,
          language_code: project.languageCode,
          device: k.device,
          depth: run.depth,
          priority: 1,
          ...RESOLVE_POISONED,
          tag: makeTag(run.id, k.id),
          ...(run.aiOverview ? { load_async_ai_overview: true } : {}),
        })),
        {
          workspaceId: scope.workspaceId,
          module: "rank",
          projectId: run.projectId,
          ttlSeconds: 0,
          // Refused up front when this batch would push the month past the cap.
          estimateUsd: estimateCheckCost(batch.length, run.depth, run.aiOverview, batch.filter((k) => hasSearchOperators(k.keyword)).length),
        },
      );
      cost += res.cost ?? 0;
      answered += batch.length;
      const rows = [];
      for (const task of res.tasks ?? []) {
        const ids = parseTag(String(task.data?.tag ?? ""));
        if (task.status_code === 20100 && ids) rows.push({ id: task.id, workspaceId: scope.workspaceId, runId: run.id, keywordId: ids.keywordId });
        else {
          failed++;
          error = `${task.status_code} ${task.status_message}`;
        }
      }
      if (rows.length) await db.insert(rankTasks).values(rows).onConflictDoNothing();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rankTasks)
    .where(and(eq(rankTasks.workspaceId, scope.workspaceId), eq(rankTasks.runId, runId)));
  await db
    .update(rankRuns)
    .set({
      status: n > 0 ? "pending" : "failed",
      tasksTotal: n,
      // A batch that threw (the month's cap, a network error) left its keywords and every later one
      // unposted. They count as failed, or the run would read as a full check of fewer keywords.
      tasksFailed: failed + (todo.length - answered),
      costUsd: sql`${rankRuns.costUsd} + ${cost}`,
      error,
      finishedAt: n > 0 ? null : new Date(),
    })
    .where(and(eq(rankRuns.id, runId), eq(rankRuns.workspaceId, scope.workspaceId)));
  if (n === 0 && error) throw new Error(`rank run ${runId}: ${error}`);
}

/**
 * Upserts a day's result. A deeper check (the weekly sweep) wins over a shallower one on the same
 * day, but "not found" never replaces a position found that day: both looks are real, and it's the
 * miss that Google's incomplete pages produce. Any real result replaces a not-checked row, and a
 * result from another place replaces whatever is there: the project has moved, so the rules for
 * comparing two looks at one SERP don't apply.
 * The workspace and project come from the task's run, so a result lands where its task was posted.
 */
export async function storeResult(
  task: { workspaceId: number; projectId: number; keywordId: number; runId: number; date: string; depth: number; locationCode?: number },
  parsed: ParsedSerp,
) {
  const { workspaceId, projectId, keywordId, runId, date, depth, locationCode } = task;
  await db
    .insert(rankResults)
    .values({ workspaceId, projectId, keywordId, runId, date, depth, locationCode, ...parsed })
    .onConflictDoUpdate({
      target: [rankResults.keywordId, rankResults.date],
      set: { ...parsed, runId: task.runId, depth: task.depth, locationCode, notChecked: false },
      setWhere: sql`${rankResults.notChecked} or ${rankResults.locationCode} is distinct from excluded.location_code or (${rankResults.depth} <= excluded.depth and (excluded.position is not null or ${rankResults.position} is null))`,
    });
}

type TaskKey = { workspaceId: number; keywordId: number; runId: number; date: string; locationCode: number };

/**
 * Files the keyword's latest result again under today, marked not checked: its position, URL and
 * SERP are what the earlier check saw, and `checkedAt` still says when. A result already there
 * today stays, since it's a real one. A result from another place says nothing about this one,
 * so it isn't repeated.
 */
async function storeNotChecked(task: TaskKey) {
  const [prev] = await db
    .select()
    .from(rankResults)
    .where(and(eq(rankResults.workspaceId, task.workspaceId), eq(rankResults.keywordId, task.keywordId), lte(rankResults.date, task.date)))
    .orderBy(desc(rankResults.date))
    .limit(1);
  if (!prev || prev.date === task.date || (prev.locationCode != null && prev.locationCode !== task.locationCode)) return;
  await db
    .insert(rankResults)
    .values({ ...prev, id: undefined, date: task.date, runId: task.runId, notChecked: true })
    .onConflictDoNothing();
}

const EMPTY_SERP: ParsedSerp = {
  position: null,
  rankAbsolute: null,
  url: null,
  ownUrls: [],
  serpFeatures: [],
  ownedFeatures: [],
  aiOverview: false,
  aiOverviewCited: false,
  domains: {},
  top: [],
  seResultsCount: 0,
  checkedAt: new Date(),
};

/** Statuses that mean "not ready yet, ask again later". */
const NOT_READY = new Set([40601, 40602]);
/** Statuses that carry a result. 40106 is a partial one, which is still worth keeping. */
const HAS_RESULT = new Set([20000, 40106]);
/** Statuses where waiting won't bring a result: the task is gone (40401, 40403) or failed (40101, or 40106 with nothing in it). */
const NO_RESULT = new Set([40101, 40106, 40401, 40403]);
/** Tasks without a result after this long are given up on (tasks_ready only covers 3 days). */
const GIVE_UP_MS = 3 * 86_400_000;
/** Tasks not listed in tasks_ready after this long are fetched directly, in case another poller consumed the listing. */
const DIRECT_FETCH_AFTER_MS = 20 * 60_000;

export interface PollStats {
  pending: number;
  fetched: number;
  stored: number;
  failed: number;
  /** Looks posted because the one just fetched couldn't be believed. */
  rechecks: number;
}

/** How far back a keyword's rows are read for its baseline (recheck.ts); more than the recent window. */
const HISTORY_ROWS = 30;

/** A task being polled, with what it takes to post another look at its keyword. */
type PolledTask = TaskKey & {
  id: string;
  attempt: number;
  postedAt: Date;
  projectId: number;
  depth: number;
  aiOverview: boolean;
  source: "app" | "mcp";
  domain: string;
  keyword: string;
  device: "desktop" | "mobile";
  locationCode: number;
  languageCode: string;
};

/** A look as `rank_tasks.look` holds it: JSON, so `checkedAt` comes back a string. */
const reviveLook = (look: unknown): ParsedSerp => {
  const l = look as ParsedSerp;
  return { ...l, checkedAt: new Date(l.checkedAt) };
};

/** The keyword's average position in Search Console over the recent window. Null with no data. */
async function searchConsoleAverage(t: PolledTask): Promise<number | null> {
  const averages = await searchConsoleAverages({ workspaceId: t.workspaceId, projectId: t.projectId }, [t.keyword], t.date);
  return averages.get(t.keyword.toLowerCase()) ?? null;
}

/**
 * Stores what the looks so far add up to, or returns false when `seen` needs another look.
 * With no `seen`, the latest look failed: what the earlier ones saw has to do.
 */
async function settleKeyword(t: PolledTask, seen: ParsedSerp | null, canRecheck: boolean): Promise<boolean> {
  const earlier = await db
    .select({ look: rankTasks.look })
    .from(rankTasks)
    .where(and(eq(rankTasks.workspaceId, t.workspaceId), eq(rankTasks.runId, t.runId), eq(rankTasks.keywordId, t.keywordId), isNotNull(rankTasks.look)))
    .orderBy(rankTasks.attempt);
  const looks = [...earlier.map((r) => reviveLook(r.look)), ...(seen ? [seen] : [])];
  if (!looks.length) return true;
  const history = await db
    .select({ date: rankResults.date, position: rankResults.position, notChecked: rankResults.notChecked, locationCode: rankResults.locationCode })
    .from(rankResults)
    // Only this place's history: a position from elsewhere doesn't make today's one suspect.
    .where(
      and(
        eq(rankResults.workspaceId, t.workspaceId),
        eq(rankResults.keywordId, t.keywordId),
        lte(rankResults.date, t.date),
        or(eq(rankResults.locationCode, t.locationCode), isNull(rankResults.locationCode)),
      ),
    )
    .orderBy(desc(rankResults.date))
    .limit(HISTORY_ROWS);
  // Only a keyword every look has missed needs Search Console's opinion.
  const average = looks.every((l) => l.position == null) ? await searchConsoleAverage(t) : null;
  const baseline = {
    ...baselineFrom(history, t.date),
    searchConsole: searchConsoleHint(average, history, t.date, t.locationCode),
    earlyMiss: missDays(history, t.date, t.locationCode) < MAX_MISS_DAYS,
  };
  const step = nextStep(looks, baseline, { depth: t.depth, canRecheck });
  if (step.kind === "recheck") return false;
  if (step.kind === "store") await storeResult(t, step.look);
  else await storeNotChecked(t);
  await db
    .update(rankTasks)
    .set({ look: null })
    .where(and(eq(rankTasks.workspaceId, t.workspaceId), eq(rankTasks.runId, t.runId), eq(rankTasks.keywordId, t.keywordId), isNotNull(rankTasks.look)));
  return true;
}

/**
 * Posts another look at each keyword, one batch per run. A task stays pending until its recheck is
 * on record, so a crash in between only means fetching it again. A look that can't be posted (the
 * spending limit, an API error) settles the keyword on what has been seen.
 */
async function postRechecks(items: { t: PolledTask; seen: ParsedSerp }[]): Promise<number> {
  const byRun = new Map<number, typeof items>();
  for (const item of items) byRun.set(item.t.runId, [...(byRun.get(item.t.runId) ?? []), item]);
  let posted = 0;
  for (const [runId, list] of byRun) {
    for (let i = 0; i < list.length; i += POST_BATCH) {
      const batch = list.slice(i, i + POST_BATCH);
      const { workspaceId, projectId, depth, aiOverview, source } = batch[0].t;
      const unposted = new Map(batch.map((item) => [item.t.keywordId, item]));
      try {
        // Posted long after the job that started the run, so the run says who started it.
        const res = await withBillingContext(source === "mcp" ? { source } : {}, () =>
          dfsPost<null>(
            "serp/google/organic/task_post",
            batch.map(({ t }) => ({
              keyword: t.keyword,
              location_code: t.locationCode,
              language_code: t.languageCode,
              device: t.device,
              depth,
              priority: 1,
              ...RESOLVE_POISONED,
              tag: makeTag(runId, t.keywordId),
              ...(aiOverview ? { load_async_ai_overview: true } : {}),
            })),
            {
              workspaceId,
              module: "rank",
              projectId,
              ttlSeconds: 0,
              estimateUsd: estimateCheckCost(batch.length, depth, aiOverview, batch.filter(({ t }) => hasSearchOperators(t.keyword)).length),
            },
          ),
        );
        await db
          .update(rankRuns)
          .set({ costUsd: sql`${rankRuns.costUsd} + ${res.cost ?? 0}` })
          .where(and(eq(rankRuns.id, runId), eq(rankRuns.workspaceId, workspaceId)));
        for (const task of res.tasks ?? []) {
          const ids = parseTag(String(task.data?.tag ?? ""));
          const item = ids && unposted.get(ids.keywordId);
          if (!item || task.status_code !== 20100) continue;
          unposted.delete(item.t.keywordId);
          await db.transaction(async (tx) => {
            await tx
              .insert(rankTasks)
              .values({ id: task.id, workspaceId, runId, keywordId: item.t.keywordId, attempt: item.t.attempt + 1 })
              .onConflictDoNothing();
            await tx.update(rankTasks).set({ status: "done", error: null, fetchedAt: new Date(), look: item.seen }).where(eq(rankTasks.id, item.t.id));
          });
          posted++;
        }
      } catch (e) {
        console.error(`[rank.poll] recheck for run ${runId}`, e);
      }
      for (const { t, seen } of unposted.values()) {
        try {
          await settleKeyword(t, seen, false);
          await markTask(t.id, "done");
        } catch (e) {
          // Stays pending; a later pass fetches it again.
          console.error(`[rank.poll] settling ${t.id}`, e);
        }
      }
    }
  }
  return posted;
}

/**
 * One polling pass: one tasks_ready call (free, 20/min limit), then task_get
 * (free) for each of our ready tasks. Makes no API call when nothing is pending.
 * Global across workspaces (tasks_ready lists every task on the DataForSEO account); each task's
 * run row says which workspace and project its result belongs to.
 *
 * A look that can't be believed (recheck.ts) isn't stored yet: another look is posted, at the same
 * price as the first (the ledger records it), and the keyword's result waits for the best of them.
 */
export async function pollOnce(): Promise<PollStats> {
  // Runs that lost their rank.check job. This job isn't gated by plan, so it also reaches a workspace that can't start another check.
  await stopPosting(lt(rankRuns.createdAt, new Date(Date.now() - STALE_POSTING_MS)), POSTING_NEVER_FINISHED);
  const pending = await db
    .select({
      id: rankTasks.id,
      runId: rankTasks.runId,
      keywordId: rankTasks.keywordId,
      attempt: rankTasks.attempt,
      postedAt: rankTasks.postedAt,
      workspaceId: rankRuns.workspaceId,
      projectId: rankRuns.projectId,
      date: rankRuns.date,
      depth: rankRuns.depth,
      aiOverview: rankRuns.aiOverview,
      source: rankRuns.source,
      domain: projects.domain,
      locationCode: sql<number>`coalesce(${rankRuns.locationCode}, ${projects.locationCode})`,
      languageCode: projects.languageCode,
      keyword: rankKeywords.keyword,
      device: rankKeywords.device,
    })
    .from(rankTasks)
    .innerJoin(rankRuns, and(eq(rankRuns.id, rankTasks.runId), eq(rankRuns.workspaceId, rankTasks.workspaceId)))
    .innerJoin(projects, and(eq(projects.id, rankRuns.projectId), eq(projects.workspaceId, rankRuns.workspaceId)))
    .innerJoin(rankKeywords, eq(rankKeywords.id, rankTasks.keywordId))
    .where(eq(rankTasks.status, "pending"));
  const stats: PollStats = { pending: pending.length, fetched: 0, stored: 0, failed: 0, rechecks: 0 };
  if (!pending.length) return stats;

  const ready = await dfsGet<TasksReadyResult>("serp/google/organic/tasks_ready", { module: "rank", free: true });
  const readyIds = new Set((ready.tasks?.[0]?.result ?? []).map((r) => r.id));
  const now = Date.now();
  const due = pending.filter(
    (t) => readyIds.has(t.id) || now - t.postedAt.getTime() > DIRECT_FETCH_AFTER_MS,
  );

  const limit = pLimit(5);
  const touchedRuns = new Set<number>();
  const rechecks: { t: PolledTask; seen: ParsedSerp }[] = [];
  await Promise.all(
    due.slice(0, 200).map((t) =>
      limit(async () => {
        let task: DfsTask<SerpAdvancedResult> | undefined;
        try {
          const res = await dfsGet<SerpAdvancedResult>(`serp/google/organic/task_get/advanced/${t.id}`, {
            workspaceId: t.workspaceId,
            module: "rank",
            projectId: t.projectId,
            free: true,
          });
          task = res.tasks?.[0];
        } catch (e) {
          console.error(`[rank.poll] task_get ${t.id}`, e);
          return;
        }
        stats.fetched++;
        const code = task?.status_code ?? 0;
        const result = task?.result?.[0];
        try {
          if ((HAS_RESULT.has(code) && result) || code === 40102) {
            const seen = result && code !== 40102 ? parseSerp(result, t.domain) : { ...EMPTY_SERP, checkedAt: new Date() };
            if (await settleKeyword(t, seen, true)) {
              await markTask(t.id, "done");
              stats.stored++;
            } else {
              rechecks.push({ t, seen });
              return;
            }
          } else if (NO_RESULT.has(code) || (!NOT_READY.has(code) && now - t.postedAt.getTime() > 6 * 3_600_000)) {
            await settleKeyword(t, null, false);
            await markTask(t.id, "failed", `${code} ${task?.status_message ?? ""}`.trim());
            stats.failed++;
          } else return;
        } catch (e) {
          // Leave the task pending; the direct-fetch fallback retries it on a later pass.
          console.error(`[rank.poll] storing ${t.id}`, e);
          return;
        }
        touchedRuns.add(t.runId);
      }),
    ),
  );

  stats.rechecks = await postRechecks(rechecks);
  for (const { t } of rechecks) touchedRuns.add(t.runId);

  // Give up on tasks DataForSEO never finished. A recheck that never came leaves the earlier looks.
  const stale = await db
    .update(rankTasks)
    .set({ status: "failed", error: "No result after 3 days", fetchedAt: new Date() })
    .where(and(eq(rankTasks.status, "pending"), lt(rankTasks.postedAt, new Date(now - GIVE_UP_MS))))
    .returning({ id: rankTasks.id, runId: rankTasks.runId });
  for (const s of stale) {
    touchedRuns.add(s.runId);
    const t = pending.find((p) => p.id === s.id);
    if (t) await settleKeyword(t, null, false).catch((e) => console.error(`[rank.poll] settling ${t.id}`, e));
  }

  for (const runId of touchedRuns) await refreshRun(runId);
  return stats;
}

async function markTask(id: string, status: "done" | "failed", error?: string) {
  await db
    .update(rankTasks)
    .set({ status, error: error ?? null, fetchedAt: new Date() })
    .where(eq(rankTasks.id, id));
}

/**
 * Recounts a run's tasks and closes it when nothing is pending, rechecks included. Done and failed
 * count keywords, so only first looks: "12 of 12 checked" while the last rechecks are out.
 */
export async function refreshRun(runId: number) {
  const counts = await db
    .select({
      status: rankTasks.status,
      n: sql<number>`count(*)::int`,
      first: sql<number>`(count(*) filter (where ${rankTasks.attempt} = 1))::int`,
    })
    .from(rankTasks)
    .where(eq(rankTasks.runId, runId))
    .groupBy(rankTasks.status);
  const get = (s: string) => counts.find((c) => c.status === s);
  const [run] = await db.select({ tasksFailed: rankRuns.tasksFailed }).from(rankRuns).where(eq(rankRuns.id, runId));
  const pending = get("pending")?.n ?? 0;
  const done = get("done")?.first ?? 0;
  const all = counts.reduce((sum, c) => sum + c.n, 0);
  const first = counts.reduce((sum, c) => sum + c.first, 0);
  const notChecked = await db.$count(rankResults, and(eq(rankResults.runId, runId), eq(rankResults.notChecked, true)));
  const [closed] = await db
    .update(rankRuns)
    .set({
      tasksDone: done,
      tasksFailed: Math.max(get("failed")?.first ?? 0, run?.tasksFailed ?? 0),
      rechecks: all - first,
      notChecked,
      ...(pending === 0 ? { status: done > 0 ? "done" : "failed", finishedAt: new Date() } : {}),
    })
    .where(and(eq(rankRuns.id, runId), eq(rankRuns.status, "pending")))
    .returning({ status: rankRuns.status });
  // A check that just closed: tracked keywords out of the top 10 wait for the day's alert email. Never fails the poll.
  if (closed?.status === "done") await alertsFromRun(runId).catch((err) => console.error("[alerts]", err));
}

/** Active projects (in active workspaces) with at least one active keyword: the daily fan-out. */
export async function projectsToCheck(): Promise<ProjectScope[]> {
  return activeProjects(
    inArray(
      projects.id,
      db.selectDistinct({ id: rankKeywords.projectId }).from(rankKeywords).where(eq(rankKeywords.active, true)),
    ),
  );
}

/**
 * Creates today's scheduled check for one project, unless its tracker is off or today's check
 * already exists. Returns the run to post, or null. Idempotent per project and day.
 */
export async function scheduleProject(scope: ProjectScope, now = new Date()): Promise<RankRun | null> {
  const date = utcToday(now);
  const s = await getSettings(scope);
  if (!s.enabled) return null;
  const [existing] = await db
    .select({ id: rankRuns.id })
    .from(rankRuns)
    .where(
      and(
        eq(rankRuns.workspaceId, scope.workspaceId),
        eq(rankRuns.projectId, scope.projectId),
        eq(rankRuns.date, date),
        inArray(rankRuns.kind, ["daily", "sweep"]),
        inArray(rankRuns.status, ["posting", "pending", "done"]),
      ),
    );
  if (existing) return null;
  const sweep = now.getUTCDay() === s.sweepWeekday;
  const run = await createRun(scope, sweep ? "sweep" : "daily", {
    depth: sweep ? s.sweepDepth : s.dailyDepth,
    aiOverview: sweep,
    date,
  });
  // Null: another run (usually a manual "Check now") is still in flight. Skip rather than pay twice.
  if (!run) console.log(`[rank.schedule] project ${scope.projectId}: a check is already running, skipped`);
  return run;
}

const VOLUME_BATCH = 700;
/** Keywords written per statement once their volumes are in. */
const VOLUME_WRITE_CHUNK = 500;
/** One Live task of keywords_data/google_ads/search_volume, up to 1,000 keywords. */
const ADS_LIVE_USD = 0.09;

/** Google Ads volumes for a batch, for a project tracking a city: Labs only knows countries. Costs one task whatever the batch size. */
async function cityVolumes(scope: ProjectScope, keywords: string[], cityCode: number, languageCode: string): Promise<Map<string, number | null>> {
  const accepted = keywords.filter(adsAccepts);
  if (!accepted.length) return new Map();
  const res = await dfsPost<AdsVolumeResult>(
    "keywords_data/google_ads/search_volume/live",
    [{ keywords: accepted, location_code: cityCode, language_code: languageCode }],
    { workspaceId: scope.workspaceId, module: "rank", projectId: scope.projectId, ttlSeconds: TTL.month, estimateUsd: ADS_LIVE_USD },
  );
  return new Map(taskResults(res).map((r) => [r.keyword.toLowerCase(), r.search_volume ?? null]));
}

/**
 * Fills search volume for keywords that lack one (or have one older than 30 days) from Labs
 * keyword_overview. A project tracking a city gets its volume from Google Ads for that city, since
 * a nationwide volume would overstate its estimated traffic; CPC and difficulty stay national.
 * Cached 30 days, so repeats are free.
 */
export async function fetchVolumes(scope: ProjectScope): Promise<number> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) return 0;
  const stale = await db
    .select({ id: rankKeywords.id, keyword: rankKeywords.keyword })
    .from(rankKeywords)
    .where(
      and(
        eq(rankKeywords.workspaceId, scope.workspaceId),
        eq(rankKeywords.projectId, scope.projectId),
        eq(rankKeywords.active, true),
        or(isNull(rankKeywords.volumeUpdatedAt), lt(rankKeywords.volumeUpdatedAt, new Date(Date.now() - TTL.month * 1000))),
      ),
    );
  const words = [...new Set(stale.map((k) => k.keyword))].sort();
  for (let i = 0; i < words.length; i += VOLUME_BATCH) {
    const batch = words.slice(i, i + VOLUME_BATCH);
    const res = await dfsPost<KeywordOverviewResult>(
      "dataforseo_labs/google/keyword_overview/live",
      [{ keywords: batch, location_code: project.locationCode, language_code: project.languageCode }],
      // Billed per keyword that has data, so a full batch is the most it can cost.
      { workspaceId: scope.workspaceId, module: "rank", projectId: scope.projectId, ttlSeconds: TTL.month, estimateUsd: labsCost(batch.length) },
    );
    const items = res.tasks?.[0]?.result?.[0]?.items ?? [];
    const byKeyword = new Map(items.map((it) => [it.keyword.toLowerCase(), it]));
    const local = project.cityCode ? await cityVolumes(scope, batch, project.cityCode, project.languageCode) : null;
    const values = stale
      .filter((s) => batch.includes(s.keyword))
      .map((k) => {
        const it = byKeyword.get(k.keyword);
        return {
          id: k.id,
          search_volume: local ? (local.get(k.keyword) ?? null) : (it?.keyword_info?.search_volume ?? null),
          cpc: it?.keyword_info?.cpc ?? null,
          // Labs sends 0 for a keyword it hasn't scored, so a 0 is stored as unknown (docs/dataforseo.md, gotcha 13).
          difficulty: knownKd(it?.keyword_properties?.keyword_difficulty),
        };
      });
    // One statement per chunk of keywords, each set to its own values. The rows travel as one JSON parameter.
    for (let j = 0; j < values.length; j += VOLUME_WRITE_CHUNK) {
      const v = sql`jsonb_to_recordset(${JSON.stringify(values.slice(j, j + VOLUME_WRITE_CHUNK))}::jsonb) as v(id integer, search_volume integer, cpc real, difficulty smallint)`;
      await db
        .update(rankKeywords)
        .set({ searchVolume: sql`v.search_volume`, cpc: sql`v.cpc`, difficulty: sql`v.difficulty`, volumeUpdatedAt: new Date() })
        .from(v)
        .where(and(eq(rankKeywords.id, sql`v.id`), eq(rankKeywords.workspaceId, scope.workspaceId)));
    }
  }
  return words.length;
}
