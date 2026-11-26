import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiPrompts, aiRuns, projects, rankKeywords, rankSettings, workspaces } from "@/db/schema";
import type { ActionRefusal } from "@/lib/action-result";
import { hooks } from "@/plan-policy/hooks";
import { rules } from "@/plan-policy/rules";
import type { Refusal } from "./errors";
import { keywordUnits, type BillingWorkspace, type GateResult } from "./limits";
import { spendBlock } from "./spend";

/**
 * The database side of the structural limits: counts what a workspace uses and asks the plan rules.
 * Server Actions call these when something is added; jobs call `projectLocked` so a read-only
 * project's scheduled checks stop.
 */

/** The rank module's depth when a project has no settings row (rank_settings.daily_depth's default). */
const DEFAULT_DAILY_DEPTH = 20;
/** Daily depth for new projects outside the internal plan. */
export const SAAS_DAILY_DEPTH = 10;

export type GateWorkspace = BillingWorkspace & { id: number; trialEndsAt?: Date | null; createdAt?: Date; stripePriceId?: string | null; grantedAt?: Date | null };

export async function loadBillingWorkspace(workspaceId: number): Promise<GateWorkspace> {
  const [ws] = await db
    .select({
      id: workspaces.id,
      plan: workspaces.plan,
      limits: workspaces.limits,
      trialEndsAt: workspaces.trialEndsAt,
      createdAt: workspaces.createdAt,
      stripePriceId: workspaces.stripePriceId,
      grantedAt: workspaces.grantedAt,
      grantEndsAt: workspaces.grantEndsAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error(`Workspace ${workspaceId} doesn't exist`);
  return rules.withEndedGrant(ws);
}

async function activeProjectRefs(workspaceId: number) {
  return db
    .select({ id: projects.id, createdAt: projects.createdAt })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.archived, false)))
    .orderBy(asc(projects.createdAt), asc(projects.id));
}

/** Projects past the plan's limit after a downgrade: their data stays, but they're read-only. */
export async function lockedProjects(ws: GateWorkspace): Promise<Set<number>> {
  return rules.lockedProjectIds(ws, await activeProjectRefs(ws.id));
}

export async function projectLocked(ws: GateWorkspace, projectId: number): Promise<boolean> {
  return (await lockedProjects(ws)).has(projectId);
}

/** A project past the plan's limit after a downgrade. */
export const LOCKED_REFUSAL: Refusal = rules.lockedRefusal;

export async function projectGate(ws: GateWorkspace): Promise<GateResult> {
  return rules.canCreateProject(ws, (await activeProjectRefs(ws.id)).length);
}

/** Every active keyword of the workspace's active projects, weighted by its project's daily depth. */
export async function keywordUnitsInUse(workspaceId: number, exceptProjectId?: number): Promise<number> {
  const rows = await db
    .select({ projectId: rankKeywords.projectId, n: count(), depth: rankSettings.dailyDepth })
    .from(rankKeywords)
    .innerJoin(projects, and(eq(projects.id, rankKeywords.projectId), eq(projects.archived, false)))
    .leftJoin(rankSettings, eq(rankSettings.projectId, rankKeywords.projectId))
    .where(and(eq(rankKeywords.workspaceId, workspaceId), eq(rankKeywords.active, true)))
    .groupBy(rankKeywords.projectId, rankSettings.dailyDepth);
  return rows.filter((r) => r.projectId !== exceptProjectId).reduce((n, r) => n + r.n * keywordUnits(r.depth ?? DEFAULT_DAILY_DEPTH), 0);
}

async function dailyDepth(workspaceId: number, projectId: number): Promise<number> {
  const [row] = await db
    .select({ depth: rankSettings.dailyDepth })
    .from(rankSettings)
    .where(and(eq(rankSettings.workspaceId, workspaceId), eq(rankSettings.projectId, projectId)));
  return row?.depth ?? DEFAULT_DAILY_DEPTH;
}

/** Whether `adding` more keywords fit, at the project's daily depth. */
export async function keywordGate(ws: GateWorkspace, projectId: number, adding: number): Promise<GateResult> {
  if (adding <= 0) return { ok: true };
  const [units, depth] = await Promise.all([keywordUnitsInUse(ws.id), dailyDepth(ws.id, projectId)]);
  return rules.canTrackKeywords(ws, units, adding, depth);
}

/** Whether the project's keywords still fit at a new daily depth. */
export async function depthGate(ws: GateWorkspace, projectId: number, depth: number): Promise<GateResult> {
  const [others, [own]] = await Promise.all([
    keywordUnitsInUse(ws.id, projectId),
    db
      .select({ n: count() })
      .from(rankKeywords)
      .where(and(eq(rankKeywords.workspaceId, ws.id), eq(rankKeywords.projectId, projectId), eq(rankKeywords.active, true))),
  ]);
  return rules.canChangeDepth(ws, others, own?.n ?? 0, depth);
}

export async function activePromptCount(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(aiPrompts)
    .innerJoin(projects, and(eq(projects.id, aiPrompts.projectId), eq(projects.archived, false)))
    .where(and(eq(aiPrompts.workspaceId, workspaceId), eq(aiPrompts.active, true)));
  return row?.n ?? 0;
}

export async function promptGate(ws: GateWorkspace, adding: number): Promise<GateResult> {
  if (adding <= 0) return { ok: true };
  return rules.canAddPrompts(ws, await activePromptCount(ws.id), adding);
}

/** Why a site audit can't start now beyond spend, such as a plan's audits used up, or null (the plan policy's hooks). */
export const auditRefusal = (ws: GateWorkspace, projectId?: number): Promise<Refusal | null> => hooks.auditRefusal(ws, projectId);

/**
 * The project's AI visibility runs started by hand this week, or null when another may start. The
 * Monday run is the cron's and doesn't count, nor does a run that failed. Weeks start on Monday in
 * the database's time zone, as `auditsThisWeek` does. `tx` is the transaction that starts the run
 * (src/modules/ai/run.ts), which holds the project's lock so the count and the new run are one step.
 */
export async function manualAiRunRefusal(ws: GateWorkspace, projectId: number, tx: Pick<typeof db, "select"> = db): Promise<Refusal | null> {
  if (!Number.isFinite(rules.limitsFor(ws).manualAiRunsPerWeek)) return null;
  const [row] = await tx
    .select({ n: count() })
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, ws.id), eq(aiRuns.projectId, projectId), eq(aiRuns.trigger, "manual"), gte(aiRuns.startedAt, sql`date_trunc('week', now())`), inArray(aiRuns.status, ["queued", "running", "done"])));
  const gate = rules.canStartManualAiRun(ws, row?.n ?? 0);
  return gate.ok ? null : { code: "ai_manual_runs", upgradable: false, message: gate.message };
}

export const lighthouseRefusal = (ws: GateWorkspace): Refusal | null => rules.lighthouseRefusal(ws);

/**
 * Why a Server Action may not change or run paid work on this project now: a read-only project
 * after a downgrade, or (with `paid`) a workspace that can't spend. Null when it may. A plan that
 * covers no paid work refuses it unless the caller says that plan covers it (`onFree`). A refusal at the
 * ceiling tells the plan policy (a hosted plan emails the customer), except when `quiet`: a dry run
 * (an MCP tool without confirm) only asks what would happen, so it must never send anything.
 */
export async function projectActionRefusal(scope: { workspaceId: number; projectId: number }, opts: { paid?: boolean; research?: boolean; onFree?: boolean; quiet?: boolean } = {}): Promise<Refusal | null> {
  const ws = await loadBillingWorkspace(scope.workspaceId);
  if (await projectLocked(ws, scope.projectId)) return LOCKED_REFUSAL;
  if (!opts.paid) return null;
  if (!opts.onFree && rules.isFree(ws)) return rules.notCoveredRefusal;
  const block = await spendBlock(scope.workspaceId, { research: opts.research });
  if (block && !opts.quiet) hooks.refused(scope.workspaceId, block);
  return block;
}

/** A plan limit's refusal as a form's action returns it. Upgrade now shows only when it would raise that limit. */
export function gateRefusal(ws: GateWorkspace, message: string, limit: "keywords" | "prompts"): ActionRefusal {
  return { error: message, upgradable: rules.upgradeRaises(ws, limit) };
}
