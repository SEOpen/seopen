/**
 * What a workspace may hold and spend, as core reads it. Core never knows plan names: it asks the
 * plan rules (`@/plan-policy/rules`, policy.ts) for a workspace's limits and checks against them.
 * A self-hosted copy has none of these limits; only the spend caps hold (spend.ts).
 */

/** A workspace as the plan rules read it: its stored plan, any limits set by hand, and a grant's end. */
export type BillingWorkspace = { plan: string; limits?: Record<string, number> | null; grantEndsAt?: Date | null };

export interface PlanLimits {
  /** Active projects. Extra ones after a downgrade are read-only. */
  projects: number;
  /** Tracked keywords across the workspace, in keyword units (see `keywordUnits`). */
  keywords: number;
  /** Pages per audit crawl. */
  auditPages: number;
  /** Active AI prompts across the workspace. */
  prompts: number;
  /**
   * Runs a project may start by hand each calendar week, Monday to Sunday, on top of the Monday
   * run. A run asks every active prompt again, so this keeps a rerun from costing a second week.
   */
  manualAiRunsPerWeek: number;
  /** Search Console query-by-page rows stored per day per project (the top rows by clicks). */
  gscRowsPerDay: number;
  /** Research credits per month. 1 credit = $0.01 of DataForSEO list price. */
  researchCredits: number;
  /** Hard monthly dollar ceiling on DataForSEO spend. */
  ceilingUsd: number;
  /** Site audits a workspace may start in all (Infinity for no such limit). */
  trialAudits: number;
  /** Site audits per calendar week, Monday to Sunday. */
  auditsPerWeek: number;
  /** Whether audits may render JavaScript, which costs over three times as much per page. */
  javascript: boolean;
  /** Lighthouse runs allowed. */
  lighthouse: boolean;
}

/** No limit on anything: a self-hosted workspace. Its spend still stops at its cap. */
export const UNLIMITED: PlanLimits = {
  projects: Infinity,
  keywords: Infinity,
  auditPages: Infinity,
  prompts: Infinity,
  manualAiRunsPerWeek: Infinity,
  gscRowsPerDay: Infinity,
  researchCredits: Infinity,
  ceilingUsd: Infinity,
  trialAudits: Infinity,
  auditsPerWeek: Infinity,
  javascript: true,
  lighthouse: true,
};

/** The limits counted when something is added, as opposed to the two switches. */
export type CountedLimit = Exclude<keyof PlanLimits, "lighthouse" | "javascript">;

/** A refused add: what the limit is and how many more fit (0 or more). */
export type GateResult = { ok: true } | { ok: false; limit: number; room: number; message: string };

/** A project as the downgrade check orders them. */
export type ProjectRef = { id: number; createdAt: Date | string };

/**
 * Keyword units a keyword costs at a daily check depth: one per 10 results checked, so the
 * default depth 10 counts once and depth 20 counts double.
 */
export function keywordUnits(depth: number): number {
  return Math.max(1, Math.ceil((Number.isFinite(depth) ? depth : 10) / 10));
}
