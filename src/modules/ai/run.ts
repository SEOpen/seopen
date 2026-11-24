/** Running tracked prompts: create a run, post tasks, poll, and store answers with detection. Used by jobs and actions. */
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/db";
import { aiBrandAliases, aiLlmMentions, aiOverviews, aiPrompts, aiResults, aiRuns } from "@/db/schema/ai";
import { competitors, projects } from "@/db/schema/core";
import { SpendRefusedError } from "@/lib/billing/errors";
import { ceilingExceeded, manualRunCreditsRefusal, spendState } from "@/lib/billing/spend";
import { monthUsage } from "@/lib/billing/usage";
import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { BudgetExceededError, monthToDateSpendUsd, recordLedgerAdjustment } from "@/lib/dataforseo/client";
import { aiRunFailure } from "@/lib/dataforseo/failure-copy";
import { enqueue } from "@/lib/jobs/boss";
import { activeProjects, inScope, projectScope, type ProjectScope } from "@/lib/workspace";
import { detect, extractCitations, makeBrand, ownBrand, type Brand } from "./detect";
import { geminiLinks, type GeminiLinks } from "./gemini-links";
import { answerFrom } from "./parse";
import {
  aiOverviewFrom,
  fetchLlmMentions,
  getAioTask,
  getLlmTask,
  liveLlm,
  postAioTasks,
  postLlmTasks,
  type DfsCtx,
} from "./dfs";
import { LLM_MENTIONS_COST_USD, platformDef, PLATFORM_KEYS, type PlatformKey } from "./platforms";
import { ratesFrom, runCost, type CostRates } from "./prompts";
import { hooks } from "@/plan-policy/hooks";

const DAY = 86_400_000;
/** AI Overview and LLM Mentions refresh at most this often, even on manual runs. */
const WEEKLY_MS = 6 * DAY;
/** Standard tasks can take up to 72 h; after that DataForSEO fails them. */
const GIVE_UP_MS = 73 * 3600_000;
/** A queued run's job waits behind other runs, which can take an hour each. Past a day it was lost. */
const STALE_QUEUED_MS = DAY;
/** Prepay DataForSEO takes per Standard llm_responses task, for rows posted before it was stored. */
const STANDARD_PREPAY_USD = 0.0102;
/**
 * Live answers asked at once. DataForSEO allows 30 simultaneous requests per account, and only
 * one ai.run works at a time, so this leaves room for the other modules' calls.
 */
const LIVE_CONCURRENCY = 10;

type Project = typeof projects.$inferSelect;

/**
 * The project's brand (domain, project name and aliases) plus each competitor (domain and
 * aliases; competitors have no name column, so their names come from the domain).
 */
export async function loadBrands(project: Project): Promise<Brand[]> {
  const scope = projectScope(project);
  const [comps, aliases] = await Promise.all([
    db.select({ domain: competitors.domain }).from(competitors).where(inScope(competitors, scope)).orderBy(asc(competitors.domain)),
    db.select().from(aiBrandAliases).where(inScope(aiBrandAliases, scope)).orderBy(asc(aiBrandAliases.id)),
  ]);
  const aliasFor = (d: string) => aliases.filter((a) => a.domain === d).map((a) => a.alias);
  return [ownBrand(project, aliasFor(project.domain)), ...comps.map((c) => makeBrand(c.domain, false, aliasFor(c.domain)))];
}

/** Average observed cost per answer by platform, over the workspace's last 30 days of finished answers. */
export async function costRates(workspaceId: number): Promise<CostRates> {
  const rows = await db
    .select({ platform: aiResults.platform, avg: sql<number | null>`avg(${aiResults.costUsd})::float` })
    .from(aiResults)
    .where(
      and(
        eq(aiResults.workspaceId, workspaceId),
        eq(aiResults.status, "done"),
        gte(aiResults.createdAt, new Date(Date.now() - 30 * DAY)),
        sql`${aiResults.costUsd} > 0`,
      ),
    )
    .groupBy(aiResults.platform);
  return ratesFrom(Object.fromEntries(rows.map((r) => [r.platform, r.avg])));
}

async function lastFetched(scope: ProjectScope, table: "mentions" | "aio"): Promise<Date | null> {
  if (table === "mentions") {
    const [r] = await db.select({ at: sql<Date | null>`max(${aiLlmMentions.fetchedAt})` }).from(aiLlmMentions).where(inScope(aiLlmMentions, scope));
    return r?.at ? new Date(r.at) : null;
  }
  const [r] = await db
    .select({ at: sql<Date | null>`max(${aiOverviews.createdAt})` })
    .from(aiOverviews)
    .where(and(inScope(aiOverviews, scope), eq(aiOverviews.status, "done")));
  return r?.at ? new Date(r.at) : null;
}

const stale = (at: Date | null) => !at || Date.now() - at.getTime() > WEEKLY_MS;

export interface RunEstimate {
  answers: number;
  aioChecks: number;
  mentionsRefresh: boolean;
  usd: number;
}

/** What "Run now" would ask and roughly what it costs. */
export async function estimateRun(project: Project): Promise<RunEstimate> {
  const scope = projectScope(project);
  const [prompts, rates, aioAt, mentionsAt] = await Promise.all([
    db.select().from(aiPrompts).where(and(inScope(aiPrompts, scope), eq(aiPrompts.active, true))),
    costRates(scope.workspaceId),
    lastFetched(scope, "aio"),
    lastFetched(scope, "mentions"),
  ]);
  const withAio = stale(aioAt);
  const mentionsRefresh = stale(mentionsAt) && prompts.length > 0;
  const shaped = prompts.map((p) => ({ platforms: p.platforms, keyword: withAio ? p.keyword : null }));
  const mentionsCost = mentionsRefresh ? LLM_MENTIONS_COST_USD : 0;
  return {
    answers: prompts.reduce((n, p) => n + p.platforms.length, 0),
    aioChecks: withAio ? prompts.filter((p) => p.keyword).length : 0,
    mentionsRefresh,
    usd: runCost(shaped, rates) + mentionsCost,
  };
}

const projectRow = (s: ProjectScope) => and(eq(projects.workspaceId, s.workspaceId), eq(projects.id, s.projectId));
/** A run of the scope, so a job or form can't name another workspace's run. */
const runIn = (s: ProjectScope, runId: number) => and(eq(aiRuns.id, runId), inScope(aiRuns, s));

/** Create a queued run row and hand it to the worker. Returns the run id, or null when there is nothing to run. */
export async function startRun(scope: ProjectScope, trigger: "manual" | "cron"): Promise<number | null> {
  const [project] = await db.select().from(projects).where(projectRow(scope));
  if (!project) return null;
  const busy = await db
    .select({ id: aiRuns.id })
    .from(aiRuns)
    .where(and(inScope(aiRuns, scope), inArray(aiRuns.status, ["queued", "running"])));
  if (busy.length) return busy[0].id;
  const est = await estimateRun(project);
  if (!est.answers) return null;
  // Refuse a run that would cross the workspace's monthly cap before creating it.
  const [spent, state] = await Promise.all([monthToDateSpendUsd(scope.workspaceId), spendState(scope.workspaceId)]);
  if (spent + est.usd > state.ceilingUsd) {
    const refused = ceilingExceeded(state.workspace, spent, state.ceilingUsd, est.usd);
    if (refused instanceof SpendRefusedError) hooks.refused(refused.workspaceId, refused.refusal);
    throw refused;
  }
  // A run started by hand spends research credits, so it must fit what's left of them.
  if (trigger === "manual" && Number.isFinite(state.creditsUsd)) {
    const usage = await monthUsage(scope.workspaceId);
    const leftUsd = state.creditsUsd - usage.researchUsd - usage.researchReservedUsd;
    if (est.usd > leftUsd) throw new SpendRefusedError(scope.workspaceId, manualRunCreditsRefusal(state.workspace, est.usd, leftUsd), { estimateUsd: est.usd });
  }
  const [run] = await db.insert(aiRuns).values({ ...scope, trigger, estimatedCostUsd: est.usd }).returning({ id: aiRuns.id });
  if (trigger === "manual") await enqueue("ai.run", { ...scope, runId: run.id }, { singletonKey: `run-${run.id}` });
  return run.id;
}

/**
 * The ai.run job was refused, so nothing else will post this run. Without this it reads as running,
 * and blocks the project's next run and the workspace's delete. Answers already posted are still
 * polled, and that closes the run. A resumed job finds a closed run and does nothing, as it does
 * for a run the client refused partway through.
 */
export async function closeRefusedRun({ workspaceId, projectId, runId }: { workspaceId?: number; projectId?: number; runId?: number }, reason: string): Promise<void> {
  if (!Number.isInteger(workspaceId) || !Number.isInteger(projectId) || !Number.isInteger(runId)) return;
  const scope = { workspaceId: workspaceId!, projectId: projectId! };
  await closeUnposted(scope, runId!);
  const waiting =
    (await db.$count(aiResults, and(inScope(aiResults, scope), eq(aiResults.runId, runId!), eq(aiResults.status, "pending")))) +
    (await db.$count(aiOverviews, and(inScope(aiOverviews, scope), eq(aiOverviews.runId, runId!), eq(aiOverviews.status, "pending"))));
  if (waiting) return;
  await db.update(aiRuns).set({ status: "failed", error: reason, finishedAt: new Date() }).where(and(runIn(scope, runId!), inArray(aiRuns.status, ["queued", "running"])));
}

/** A run's answers and AI Overview checks that were never sent: nothing will come back for them. Posted ones are left for the poll. */
async function closeUnposted(scope: ProjectScope, runId: number): Promise<void> {
  const unposted = { status: "failed", error: "Run stopped before this task was posted", completedAt: new Date() };
  await db.update(aiResults).set(unposted).where(and(inScope(aiResults, scope), eq(aiResults.runId, runId), eq(aiResults.status, "pending"), isNull(aiResults.taskId)));
  await db.update(aiOverviews).set(unposted).where(and(inScope(aiOverviews, scope), eq(aiOverviews.runId, runId), eq(aiOverviews.status, "pending"), isNull(aiOverviews.taskId)));
}

/** Runs whose ai.run job never started. This job isn't gated by plan, so it also reaches a workspace that can't start another run. */
export async function closeStaleQueuedRuns(): Promise<void> {
  await db
    .update(aiRuns)
    .set({ status: "failed", error: POSTING_NEVER_FINISHED, finishedAt: new Date() })
    .where(and(eq(aiRuns.status, "queued"), lt(aiRuns.startedAt, new Date(Date.now() - STALE_QUEUED_MS))));
}

/**
 * Post every task for a run of `scope`. Idempotent: rows and task ids already created are reused,
 * so a second call asks only what is still pending.
 *
 * A throw partway keeps whatever came back or was posted, since it's paid for. When the job will be
 * retried (`final: false`) and the throw isn't a billing refusal, the rest stays pending and the
 * error is rethrown, so the retry resumes this run. Otherwise what was never sent fails, and the run
 * closes on what came back, or stays open for its poll while posted AI Overview checks are read.
 */
export async function executeRun(scope: ProjectScope, runId: number, { final = true }: { final?: boolean } = {}): Promise<void> {
  const [run] = await db.select().from(aiRuns).where(runIn(scope, runId));
  if (!run || run.status === "done" || run.status === "failed") return;
  const [project] = await db.select().from(projects).where(projectRow(scope));
  if (!project) return;
  await db.update(aiRuns).set({ status: "running" }).where(runIn(scope, runId));

  const ctx = { ...scope, locationCode: project.locationCode, languageCode: project.languageCode };
  /** A result or overview row of this workspace, by an id parsed from a task tag. */
  const resultRow = (id: number) => and(eq(aiResults.id, id), eq(aiResults.workspaceId, scope.workspaceId));
  const overviewRow = (id: number) => and(eq(aiOverviews.id, id), eq(aiOverviews.workspaceId, scope.workspaceId));
  // The first paid call carries the whole run's estimate, so the client refuses a run that would
  // cross the cap before anything is posted. Every call also reserves its own tasks' price, so
  // answers asked at once each hold theirs while they're in flight. A resumed run carries only
  // what it hasn't spent yet.
  let estimate = Math.max(0, run.estimatedCostUsd - run.costUsd);
  const paid = (perTaskUsd: number) => {
    const estimateUsd = estimate;
    estimate = 0;
    return { ...ctx, estimateUsd, perTaskUsd };
  };
  const rates = await costRates(scope.workspaceId);
  const perAnswer = (platform: string) => rates.perAnswer[platform] ?? 0.01;
  const prompts = await db.select().from(aiPrompts).where(and(inScope(aiPrompts, scope), eq(aiPrompts.active, true)));
  const brands = await loadBrands(project);
  const links = geminiLinks();

  let thrown: unknown = null;
  try {
    // 1. One result row per prompt × platform.
    const rows = prompts.flatMap((p) =>
      p.platforms.filter((pl) => PLATFORM_KEYS.includes(pl as PlatformKey)).map((platform) => ({ ...scope, runId, promptId: p.id, platform })),
    );
    if (rows.length) await db.insert(aiResults).values(rows).onConflictDoNothing();

    // 2. Weekly AI Overview check of each prompt's keyword form.
    if (stale(await lastFetched(scope, "aio"))) {
      const aio = prompts.filter((p) => p.keyword).map((p) => ({ ...scope, runId, promptId: p.id, keyword: p.keyword! }));
      if (aio.length) await db.insert(aiOverviews).values(aio).onConflictDoNothing();
    }

    const pending = await db
      .select({ id: aiResults.id, platform: aiResults.platform, prompt: aiPrompts.prompt })
      .from(aiResults)
      .innerJoin(aiPrompts, and(eq(aiPrompts.id, aiResults.promptId), eq(aiPrompts.workspaceId, aiResults.workspaceId)))
      .where(and(inScope(aiResults, scope), eq(aiResults.runId, runId), eq(aiResults.status, "pending"), isNull(aiResults.taskId)));

    // 3. Standard-queue platforms: post in batches, keep the task ids.
    for (const platform of PLATFORM_KEYS.filter((k) => platformDef(k)!.mode === "standard")) {
      const items = pending.filter((r) => r.platform === platform);
      if (!items.length) continue;
      const tasks = await postLlmTasks(platform, items.map((r) => ({ prompt: r.prompt, tag: `ai-result-${r.id}` })), paid(perAnswer(platform)));
      for (const t of tasks) {
        const id = Number(String(t.data?.tag ?? "").replace("ai-result-", ""));
        if (!id) continue;
        // costUsd holds the prepay charged at task_post until the answer arrives (see storeAnswer).
        if (t.status_code === 20100) await db.update(aiResults).set({ taskId: t.id, costUsd: t.cost }).where(resultRow(id));
        else await db.update(aiResults).set({ status: "failed", error: `${t.status_code} ${t.status_message}`, completedAt: new Date() }).where(resultRow(id));
      }
    }

    // 4. AI Overview SERP tasks.
    const aioPending = await db
      .select({ id: aiOverviews.id, keyword: aiOverviews.keyword })
      .from(aiOverviews)
      .where(and(inScope(aiOverviews, scope), eq(aiOverviews.runId, runId), eq(aiOverviews.status, "pending"), isNull(aiOverviews.taskId)));
    if (aioPending.length) {
      const tasks = await postAioTasks(aioPending.map((a) => ({ keyword: a.keyword, tag: `ai-aio-${a.id}` })), paid(rates.aio));
      for (const t of tasks) {
        const id = Number(String(t.data?.tag ?? "").replace("ai-aio-", ""));
        if (!id) continue;
        if (t.status_code === 20100) await db.update(aiOverviews).set({ taskId: t.id }).where(overviewRow(id));
        else await db.update(aiOverviews).set({ status: "failed", error: `${t.status_code} ${t.status_message}`, completedAt: new Date() }).where(overviewRow(id));
      }
    }

    // 5. Live platforms: ask now, several at a time. Progress is counted as answers land, so the
    // page shows them coming in; the run itself only finishes below. Once one ask throws (the cap,
    // most often) no new one starts, but those already in flight are waited for: their answers
    // come back paid for, and they must land before unsent rows are closed.
    let stopped = false;
    const ask = async (r: (typeof pending)[number]) => {
      if (stopped) return;
      try {
        const out = await liveLlm(r.platform as PlatformKey, r.prompt, paid(perAnswer(r.platform)));
        await storeAnswer(r.id, out, brands, links);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        await db.update(aiResults).set({ status: "failed", error: errorText(err), completedAt: new Date() }).where(resultRow(r.id));
      }
      await updateRunProgress(runId, { finish: false });
    };
    const live = pending.filter((r) => platformDef(r.platform)?.mode === "live");
    // A call carrying the run's estimate is asked alone: beside it, the others' own prices would count twice.
    if (estimate > 0 && live.length) await ask(live.shift()!);
    const limit = pLimit(LIVE_CONCURRENCY);
    const asked = await Promise.allSettled(
      live.map((r) =>
        limit(() =>
          ask(r).catch((err: unknown) => {
            stopped = true;
            throw err;
          }),
        ),
      ),
    );
    const stop = asked.find((a): a is PromiseRejectedResult => a.status === "rejected");
    if (stop) throw stop.reason;

    // 6. Weekly domain-level LLM Mentions for us and competitors.
    if (stale(await lastFetched(scope, "mentions"))) {
      try {
        const { estimateUsd, perTaskUsd } = paid(LLM_MENTIONS_COST_USD);
        await refreshLlmMentions(project, brands, { estimateUsd, perTaskUsd });
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        console.error("[ai] LLM mentions refresh failed", err);
      }
    }
  } catch (err) {
    thrown = err;
  }

  const refused = thrown instanceof BudgetExceededError;
  if (thrown) {
    // The run keeps why it stopped, whether it closes on what came back or a retry resumes it.
    await db.update(aiRuns).set({ error: errorText(thrown) }).where(runIn(scope, runId));
    // A retry can't help a billing refusal. Anything else: leave the rest pending for the retry.
    if (!final && !refused) throw thrown;
    await closeUnposted(scope, runId);
  }

  await updateRunProgress(runId);
  const [after] = await db.select({ status: aiRuns.status }).from(aiRuns).where(runIn(scope, runId));
  // Nothing came back: the throw says why better than the unsent rows do.
  if (thrown && after?.status === "failed") await db.update(aiRuns).set({ error: errorText(thrown) }).where(runIn(scope, runId));
  if (after?.status === "running") await enqueue("ai.poll", { ...scope, runId }, { startAfter: 30, singletonKey: `poll-${runId}` });
  if (thrown && !refused) throw thrown;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type LlmOutcome = Awaited<ReturnType<typeof getLlmTask>>;

/**
 * Store an answer with its detection results, or the failure. With `links`, Gemini's redirect links are
 * first followed to the pages they cite (`gemini-links.ts`), so the pages, sources and actions show real
 * addresses; one that can't be followed is kept as it came.
 */
async function storeAnswer(resultId: number, out: LlmOutcome, brands: Brand[], links?: GeminiLinks) {
  if (out.state === "pending") return;
  if (out.state === "failed") {
    await db.update(aiResults).set({ status: "failed", error: `${out.code} ${out.error}`, completedAt: new Date() }).where(eq(aiResults.id, resultId));
    return;
  }
  const { text, annotations, model } = answerFrom(out.result);
  // Live tasks report their full cost. Standard task_get reports 0: only the prepay was charged at
  // task_post, and the real cost is base price + the model's token and web-search cost.
  const [row] = await db
    .select({ platform: aiResults.platform, workspaceId: aiResults.workspaceId, projectId: aiResults.projectId, prepaid: aiResults.costUsd, taskId: aiResults.taskId })
    .from(aiResults)
    .where(eq(aiResults.id, resultId));
  if (!row) return;
  // Only Standard tasks have a task id. Keyed on the row, not the platform's current mode, so a
  // run posted to the queue before a platform moved to Live still gets its real cost recorded.
  const standard = row.taskId != null;
  const cost = out.cost > 0 ? out.cost : (standard ? 0.0002 : 0.0006) + (out.result?.money_spent ?? 0);
  const extracted = extractCitations(text, annotations);
  const citations = links ? await links.resolve(extracted) : extracted;
  const d = detect(text, citations, brands);
  // Only the pending → done transition records the ledger difference, so a repeated poll can't double it.
  const updated = await db
    .update(aiResults)
    .set({
      status: "done",
      model,
      answer: text,
      citations,
      mentions: d.mentions,
      mentioned: d.mentioned,
      cited: d.cited,
      position: d.position,
      costUsd: cost,
      completedAt: new Date(),
    })
    .where(and(eq(aiResults.id, resultId), eq(aiResults.status, "pending")))
    .returning({ id: aiResults.id });
  if (updated.length && standard && out.cost === 0) {
    await recordLedgerAdjustment({
      workspaceId: row.workspaceId,
      endpoint: `ai_optimization/${row.platform}/llm_responses/task_post`,
      module: "ai",
      projectId: row.projectId,
      deltaUsd: cost - (row.prepaid ?? STANDARD_PREPAY_USD),
    });
  }
}

/**
 * Poll a run's outstanding Standard tasks (free) and finish it when nothing is left. With a scope
 * (a run's own poll job) the run must belong to it; the safety-net sweep passes none and each
 * run's own workspace is used from its row.
 */
export async function pollRun(runId: number, scope?: ProjectScope): Promise<"done" | "pending"> {
  const [run] = await db
    .select()
    .from(aiRuns)
    .where(scope ? runIn(scope, runId) : eq(aiRuns.id, runId));
  if (!run || run.status !== "running") return "done";
  const own = projectScope({ id: run.projectId, workspaceId: run.workspaceId });
  const [project] = await db.select().from(projects).where(projectRow(own));
  if (!project) return "done";
  const brands = await loadBrands(project);
  const links = geminiLinks();
  const tooOld = Date.now() - run.startedAt.getTime() > GIVE_UP_MS;
  const limit = pLimit(5);

  const results = await db
    .select({ id: aiResults.id, platform: aiResults.platform, taskId: aiResults.taskId })
    .from(aiResults)
    .where(and(eq(aiResults.runId, runId), eq(aiResults.status, "pending")));
  await Promise.all(
    results.map((r) =>
      limit(async () => {
        if (!r.taskId) {
          // A Live answer or a post that a crashed run never finished: nothing is coming for it.
          if (tooOld) await storeAnswer(r.id, { state: "failed", error: "Timed out after 72 h", code: 0 }, brands);
          return;
        }
        try {
          const out = await getLlmTask(r.platform as PlatformKey, r.taskId, own);
          if (out.state === "pending" && tooOld) {
            await storeAnswer(r.id, { state: "failed", error: "Timed out after 72 h", code: 0 }, brands);
          } else await storeAnswer(r.id, out, brands, links);
        } catch (err) {
          console.error(`[ai] poll result ${r.id}`, err);
        }
      }),
    ),
  );

  const aio = await db
    .select({ id: aiOverviews.id, taskId: aiOverviews.taskId })
    .from(aiOverviews)
    .where(and(eq(aiOverviews.runId, runId), eq(aiOverviews.status, "pending")));
  await Promise.all(
    aio.map((a) =>
      limit(async () => {
        if (!a.taskId) {
          if (tooOld) await db.update(aiOverviews).set({ status: "failed", error: "Timed out", completedAt: new Date() }).where(eq(aiOverviews.id, a.id));
          return;
        }
        try {
          const out = await getAioTask(a.taskId, own);
          if (out.state === "pending") {
            if (tooOld) await db.update(aiOverviews).set({ status: "failed", error: "Timed out", completedAt: new Date() }).where(eq(aiOverviews.id, a.id));
            return;
          }
          if (out.state === "failed") {
            await db.update(aiOverviews).set({ status: "failed", error: `${out.code} ${out.error}`, completedAt: new Date() }).where(eq(aiOverviews.id, a.id));
            return;
          }
          const o = aiOverviewFrom(out.result);
          const references = extractCitations("", o.references);
          const d = detect(o.text, references, brands);
          await db
            .update(aiOverviews)
            .set({ status: "done", present: o.present, cited: d.cited, mentioned: d.mentioned, text: o.text || null, references, costUsd: out.cost, completedAt: new Date() })
            .where(eq(aiOverviews.id, a.id));
        } catch (err) {
          console.error(`[ai] poll aio ${a.id}`, err);
        }
      }),
    ),
  );

  return updateRunProgress(runId);
}

/** Recount a run's tasks; close it when none are pending, unless `finish` is false (mid-run). */
async function updateRunProgress(runId: number, { finish = true }: { finish?: boolean } = {}): Promise<"done" | "pending"> {
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${aiResults.status} = 'pending')::int`,
      done: sql<number>`count(*) filter (where ${aiResults.status} = 'done')::int`,
      cost: sql<number>`coalesce(sum(${aiResults.costUsd}), 0)::float`,
    })
    .from(aiResults)
    .where(eq(aiResults.runId, runId));
  const [o] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${aiOverviews.status} = 'pending')::int`,
      done: sql<number>`count(*) filter (where ${aiOverviews.status} = 'done')::int`,
      cost: sql<number>`coalesce(sum(${aiOverviews.costUsd}), 0)::float`,
    })
    .from(aiOverviews)
    .where(eq(aiOverviews.runId, runId));
  const total = r.total + o.total;
  const open = r.open + o.open;
  const done = finish && open === 0;
  // As rank and Local close a check: nothing came back means it failed. Answers are what the run is for, so an AI Overview alone doesn't save it.
  const nothingBack = done && total > 0 && (r.total ? r.done : o.done) === 0;
  const closing = !done
    ? {}
    : nothingBack
      ? { status: "failed" as const, error: aiRunFailure((await db.selectDistinct({ error: aiResults.error }).from(aiResults).where(and(eq(aiResults.runId, runId), eq(aiResults.status, "failed")))).map((a) => a.error)), finishedAt: new Date() }
      : { status: "done" as const, finishedAt: new Date() };
  await db
    .update(aiRuns)
    .set({ tasksTotal: total, tasksDone: total - open, costUsd: r.cost + o.cost, ...closing })
    .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, "running")));
  return done ? "done" : "pending";
}

/** Fetch and store domain-level LLM Mentions for the project and its competitors. */
export async function refreshLlmMentions(project: Project, brands?: Brand[], cost: Pick<DfsCtx, "estimateUsd" | "perTaskUsd"> = {}) {
  const scope = projectScope(project);
  const list = brands ?? (await loadBrands(project));
  const rows = await fetchLlmMentions(list, { ...scope, locationCode: project.locationCode, languageCode: project.languageCode, ...cost });
  if (!rows.length) return;
  const fetchedAt = new Date();
  await db.insert(aiLlmMentions).values(
    rows.map((r) => ({
      ...scope,
      platform: r.platform,
      domain: r.domain,
      own: r.domain === list[0].domain,
      mentions: r.mentions,
      aiSearchVolume: r.aiSearchVolume,
      topSources: r.topSources,
      fetchedAt,
    })),
  );
}

/** Rows written per statement when detection runs again. */
const REDETECT_CHUNK = 500;

/** Re-run detection on every stored answer of a project, e.g. after brand aliases change. No API calls. */
export async function redetectProject(scope: ProjectScope) {
  const [project] = await db.select().from(projects).where(projectRow(scope));
  if (!project) return;
  const brands = await loadBrands(project);
  const rows = await db
    .select({ id: aiResults.id, answer: aiResults.answer, citations: aiResults.citations })
    .from(aiResults)
    .where(and(inScope(aiResults, scope), eq(aiResults.status, "done")));
  const found = rows.map((r) => ({ id: r.id, ...detect(r.answer ?? "", r.citations ?? [], brands) }));
  // One statement per chunk of rows, each row set to its own values. The rows travel as one JSON parameter.
  for (let i = 0; i < found.length; i += REDETECT_CHUNK) {
    const v = sql`jsonb_to_recordset(${JSON.stringify(found.slice(i, i + REDETECT_CHUNK))}::jsonb) as v(id integer, mentions jsonb, mentioned boolean, cited boolean, position integer)`;
    await db
      .update(aiResults)
      .set({ mentions: sql`v.mentions`, mentioned: sql`v.mentioned`, cited: sql`v.cited`, position: sql`v.position` })
      .from(v)
      .where(and(eq(aiResults.id, sql`v.id`), inScope(aiResults, scope)));
  }
  const aio = await db
    .select({ id: aiOverviews.id, text: aiOverviews.text, references: aiOverviews.references })
    .from(aiOverviews)
    .where(and(inScope(aiOverviews, scope), eq(aiOverviews.status, "done")));
  const foundAio = aio.map((a) => {
    const d = detect(a.text ?? "", a.references ?? [], brands);
    return { id: a.id, mentioned: d.mentioned, cited: d.cited };
  });
  for (let i = 0; i < foundAio.length; i += REDETECT_CHUNK) {
    const v = sql`jsonb_to_recordset(${JSON.stringify(foundAio.slice(i, i + REDETECT_CHUNK))}::jsonb) as v(id integer, mentioned boolean, cited boolean)`;
    await db
      .update(aiOverviews)
      .set({ mentioned: sql`v.mentioned`, cited: sql`v.cited` })
      .from(v)
      .where(and(eq(aiOverviews.id, sql`v.id`), inScope(aiOverviews, scope)));
  }
}

/** Projects in active workspaces that have at least one active prompt (the weekly cron fans out over these). */
export async function projectsWithPrompts(): Promise<ProjectScope[]> {
  return activeProjects(
    sql`exists (select 1 from ${aiPrompts} where ${aiPrompts.workspaceId} = ${projects.workspaceId} and ${aiPrompts.projectId} = ${projects.id} and ${aiPrompts.active})`,
  );
}

/** Runs still waiting on tasks (for the safety-net poll; global, each run carries its workspace). */
export async function runningRuns(): Promise<number[]> {
  const rows = await db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.status, "running"));
  return rows.map((r) => r.id);
}
