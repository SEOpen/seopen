import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { aiPrompts, aiRuns } from "@/db/schema/ai";
import { projects } from "@/db/schema/core";
import { analyticsEnabled, track } from "@/lib/analytics/server";
import { creditsFor, isInternal } from "@/lib/billing/gates";
import { loadBillingWorkspace, manualAiRunRefusal, projectActionRefusal, promptGate } from "@/lib/billing/workspace";
import { BudgetExceededError, SpendRefusedError } from "@/lib/dataforseo/client";
import { OpError, plural, refused, type Actor, type OpOptions } from "@/lib/ops";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { rules } from "@/plan-policy/rules";
import { PLATFORM_KEYS } from "./platforms";
import { canonicalTopic, monthlyCost, promptToKeyword, roundUsd } from "./prompts";
import { namesBrand } from "./detect";
import { beginRun, costRates, estimateRun, loadBrands, ManualRunLimitError } from "./run";

/** AI visibility changes shared by the Server Actions and the MCP server (see `src/lib/ops`). */

export const platformsSchema = z.array(z.enum(PLATFORM_KEYS as [string, ...string[]])).min(1);
export const promptsSchema = z
  .array(
    z.object({
      prompt: z.string().trim().min(3).max(500),
      keyword: z.string().trim().max(200).nullish(),
      source: z.enum(["manual", "suggested"]).default("manual"),
      topic: z.string().max(200).nullish(),
    }),
  )
  .min(1)
  .max(100);

export type PromptItem = z.input<typeof promptsSchema>[number];

/** Topics already used on the project, so a new one reuses their spelling. */
export async function projectTopics(s: ProjectScope): Promise<string[]> {
  const rows = await db.selectDistinct({ topic: aiPrompts.topic }).from(aiPrompts).where(and(inScope(aiPrompts, s), isNotNull(aiPrompts.topic)));
  return rows.map((r) => r.topic!).filter(Boolean);
}

export interface AddedPrompts {
  dryRun: boolean;
  added: number;
  already: number;
  /** The prompts sent that the project already tracks. */
  alreadyPrompts: string[];
  /** The prompts sent that name the site's brand, which visibility leaves out unless the project counts them. */
  branded: string[];
  /** The project counts branded prompts in visibility. */
  includesBranded: boolean;
  platforms: string[];
  /** What these prompts add to the monthly bill at the weekly schedule, only for workspaces that see dollar costs. */
  monthlyUsd: number | null;
  message: string;
}

/**
 * Adds prompts (deduped per project) asked on `platforms` every week. A prompt's keyword drives
 * the AI Overview check; left out, it comes from the prompt, and an explicit empty one skips it.
 */
export async function addPromptsOp(scope: ProjectScope, actor: Actor, items: PromptItem[], platforms: string[], opts: OpOptions = {}): Promise<AddedPrompts> {
  const list = promptsSchema.safeParse(items);
  if (!list.success) throw new OpError("Give between 1 and 100 prompts of 3 to 500 characters each.");
  const pl = platformsSchema.safeParse(platforms);
  if (!pl.success) throw new OpError(`Pick at least one platform: ${PLATFORM_KEYS.join(", ")}.`);
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const topics = await projectTopics(scope);
  const rows = list.data.map((i) => ({
    ...scope,
    prompt: i.prompt,
    // An explicit empty keyword means "skip the AI Overview check".
    keyword: i.keyword === undefined || i.keyword === null ? promptToKeyword(i.prompt) || null : i.keyword || null,
    platforms: pl.data,
    source: i.source,
    topic: canonicalTopic(i.topic, topics),
  }));
  const existing = new Set(
    (
      await db
        .select({ prompt: aiPrompts.prompt })
        .from(aiPrompts)
        .where(
          and(
            inScope(aiPrompts, scope),
            inArray(
              aiPrompts.prompt,
              rows.map((r) => r.prompt),
            ),
          ),
        )
    ).map((r) => r.prompt),
  );
  const fresh = [...new Map(rows.filter((r) => !existing.has(r.prompt)).map((r) => [r.prompt, r])).values()];
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  const own = (await loadBrands(project))[0];
  const branded = [...new Set(rows.map((r) => r.prompt).filter((p) => namesBrand(p, own)))];
  // Only new prompts count against the plan: sending ones the project already tracks adds nothing.
  const gate = await promptGate(ws, fresh.length);
  if (!gate.ok) throw new OpError(gate.message);
  const monthlyUsd = isInternal(ws) ? roundUsd(monthlyCost(fresh, await costRates(scope.workspaceId))) : null;
  let added = fresh.length;
  if (!opts.dryRun) {
    const inserted = await db.insert(aiPrompts).values(rows).onConflictDoNothing().returning({ id: aiPrompts.id });
    added = inserted.length;
    // Only these prompts are on the project: AI visibility tracking was just set up.
    if (added && analyticsEnabled() && (await db.$count(aiPrompts, inScope(aiPrompts, scope))) === added) {
      track(actor.userId, "module_activated", { module: "ai", project_id: scope.projectId, prompts: added, platforms: pl.data.length }, { workspaceId: scope.workspaceId });
    }
  }
  const already = rows.length - added;
  const parts = [`${opts.dryRun ? "Would add" : "Added"} ${plural(added, "prompt")}, asked weekly on ${plural(pl.data.length, "platform")}`];
  if (already) parts.push(`${already} already tracked`);
  return {
    dryRun: !!opts.dryRun,
    added,
    already,
    alreadyPrompts: [...existing],
    branded,
    includesBranded: project.aiIncludeBranded,
    platforms: pl.data,
    monthlyUsd,
    message: `${parts.join(" · ")}.`,
  };
}

export interface StartedRun {
  dryRun: boolean;
  /** Null on a dry run. */
  runId: number | null;
  answers: number;
  aioChecks: number;
  /** What it costs in research credits, quoted before it runs. */
  price: { credits: number };
  estimateUsd: number | null;
  message: string;
}

const RUN_IN_PROGRESS = "A run is already in progress for this project. Its answers arrive over the next few minutes.";

/** Asks every active prompt now, on research credits. One run at a time per project. */
export async function startAiRunOp(scope: ProjectScope, opts: OpOptions = {}): Promise<StartedRun> {
  const refusal = await projectActionRefusal(scope, { paid: true, research: true, quiet: opts.dryRun });
  if (refusal) throw new OpError(`Not started. ${refusal.message}`, refusal);
  const busy = await db.$count(aiRuns, and(inScope(aiRuns, scope), inArray(aiRuns.status, ["queued", "running"])));
  if (busy) throw new OpError(RUN_IN_PROGRESS);
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  const est = await estimateRun(project);
  if (!est.answers) throw new OpError("No active prompts to run. Add prompts first.");
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const weekly = await manualAiRunRefusal(ws, scope.projectId);
  if (weekly) throw new OpError(`Not started. ${weekly.message}`, weekly);
  const estimateUsd = isInternal(ws) ? roundUsd(est.usd) : null;
  const price = { credits: creditsFor(est.usd) };
  const what = `${plural(est.answers, "answer")}${est.aioChecks ? ` and ${plural(est.aioChecks, "AI Overview check")}` : ""}`;
  if (opts.dryRun) return { dryRun: true, runId: null, answers: est.answers, aioChecks: est.aioChecks, price, estimateUsd, message: `Would ask for ${what}, about ${rules.creditsText(price.credits)}.` };
  let started: { id: number; created: boolean } | null;
  try {
    started = await beginRun(scope, "manual");
  } catch (err) {
    // Another start used the week's last run between the check above and this one.
    if (err instanceof ManualRunLimitError) throw new OpError(`Not started. ${err.message}`, err.refusal);
    if (err instanceof SpendRefusedError) throw new OpError(`Not started. ${err.message}`, err.refusal);
    // Only the internal workspace gets a bare BudgetExceededError, with its dollar figures.
    if (err instanceof BudgetExceededError) throw new OpError(`Not started: this run would pass the monthly cap. ${err.message}`);
    throw err;
  }
  if (!started) throw new OpError("No active prompts to run. Add prompts first.");
  // Another start made the run first: this one started nothing.
  if (!started.created) throw new OpError(RUN_IN_PROGRESS);
  return { dryRun: false, runId: started.id, answers: est.answers, aioChecks: est.aioChecks, price, estimateUsd, message: `Run queued: ${what}, about ${rules.creditsText(price.credits)}. Answers arrive over the next few minutes.` };
}
