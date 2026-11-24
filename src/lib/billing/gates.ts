import { rules } from "@/plan-policy/rules";

/**
 * Every limit check in the app goes through here. The answers are the plan policy's
 * (`@/plan-policy/rules`, policy.ts): a hosted service's plans, or no limits at all on a self-hosted
 * copy. Pure, so client components can use it.
 */

export type { BillingWorkspace, GateResult, PlanLimits } from "./limits";
export { keywordUnits } from "./limits";

export const {
  withEndedGrant,
  limitsFor,
  isTrial,
  isFree,
  isInternal,
  paymentProblem,
  canSeeFixReports,
  showsDollarCosts,
  upgradeRaises,
  canCreateProject,
  canTrackKeywords,
  canChangeDepth,
  canAddPrompts,
  canStartManualAiRun,
  auditPageLimit,
  auditJavascript,
  gscRowsPerDay,
  ceilingUsd,
  lockedProjectIds,
  creditsFor,
  creditsUsed,
  costLabel,
} = rules;
