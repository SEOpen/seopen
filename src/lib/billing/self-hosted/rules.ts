import { BudgetExceededError, type Refusal } from "../errors";
import { UNLIMITED } from "../limits";
import type { PlanRules } from "../policy";

/**
 * A copy without plans (`@/plan-policy/rules`, policy.ts): no limits, prices in dollars, nothing for
 * sale. What stops spending is the cap: each workspace's own, or DATAFORSEO_MONTHLY_CAP_USD, and the
 * platform cap above them all (spend.ts).
 *
 * Only a workspace the operator made runs paid checks: those start on the internal plan (hooks.ts).
 * One a stranger made by signing up, when older versions had public sign-up, can't spend the
 * operator's DataForSEO money, nor can any workspace whose stored plan is something else.
 */

const OK = { ok: true } as const;

/** One cent at least, so a cheap lookup never reads as free. */
const dollars = (usd: number) => `$${Math.max(0.01, usd).toFixed(2)}`;

/** A workspace that may not spend: one made by signing up. */
const PAID_OFF: Refusal = {
  code: "no_plan",
  upgradable: false,
  message: "Paid checks are off for this workspace. Ask whoever runs this copy of SEOpen to make your account for you.",
};

const operatorMade = (ws: { plan: string }) => ws.plan === "internal";

export const rules: PlanRules = {
  hasPlans: false,
  plansHref: null,
  newAccountLine: () => null,
  planLabel: (plan) => (operatorMade({ plan }) ? "Made by an admin" : "Signed up, no paid checks"),
  planPhrase: (plan) => (operatorMade({ plan }) ? "made by an admin" : "one that signed itself up, which runs no paid checks,"),

  withEndedGrant: (ws) => ws,
  limitsFor: () => UNLIMITED,
  isTrial: () => false,
  isFree: () => false,
  isInternal: (ws) => operatorMade(ws),
  paymentProblem: () => null,
  canSeeFixReports: () => true,
  showsDollarCosts: () => true,
  upgradeRaises: () => false,

  canCreateProject: () => OK,
  canTrackKeywords: () => OK,
  canChangeDepth: () => OK,
  canAddPrompts: () => OK,
  canStartManualAiRun: () => OK,
  auditPageLimit: (_ws, requested) => Math.max(1, requested),
  auditJavascript: (_ws, requested) => requested,
  gscRowsPerDay: () => null,
  ceilingUsd: (_ws, ownCapUsd, fallbackCapUsd) => (ownCapUsd !== null && Number.isFinite(ownCapUsd) && ownCapUsd > 0 ? ownCapUsd : fallbackCapUsd),
  lockedProjectIds: () => new Set(),

  creditUsd: 0.01,
  creditsFor: (usd) => (usd > 0 ? Math.max(1, Math.ceil(usd / 0.01 - 1e-9)) : 0),
  creditsUsed: (researchUsd) => Math.round(Math.max(0, researchUsd) / 0.01),
  costLabel: (usd) => (usd <= 0 ? "cached, free" : `≈ ${dollars(usd)}`),
  // A credit is a cent here, so a count of them reads as the dollars it is.
  creditsText: (credits) => `$${(Math.max(0, credits) * 0.01).toFixed(2)}`,
  researchNoun: "DataForSEO spend",
  researchScope: "Can run research lookups",
  creditUnit: "cents",

  stateRefusal: (ws) => (operatorMade(ws) ? null : PAID_OFF),
  needsVerifiedOwner: () => false,
  paidWorkRefusal: (ws) => (operatorMade(ws) ? null : PAID_OFF),
  notCoveredRefusal: PAID_OFF,
  quietRefusalCodes: new Set(),
  lockedRefusal: { code: "locked", upgradable: false, message: "This project is read-only." },
  lighthouseRefusal: () => null,
  ceilingRefusal: (_ws, ceilingUsd) => ({
    code: "ceiling",
    upgradable: false,
    message: `This month's DataForSEO cap of ${dollars(ceilingUsd)} is reached. Raise it in Admin → Spend to continue.`,
  }),
  ceilingExceeded: (_ws, spentUsd, ceilingUsd, estimateUsd) => new BudgetExceededError(spentUsd, ceilingUsd, estimateUsd),
  creditsRefusal: () => ({ code: "credits", upgradable: false, message: "This month's research budget is used. It resets on the 1st." }),
  manualRunCreditsRefusal: (_ws, estimateUsd) => ({
    code: "credits",
    upgradable: false,
    message: `This run needs about ${dollars(estimateUsd)}, more than this month's research budget has left. The Monday run still asks every prompt.`,
  }),

  planIncludes: () => true,
  planFeature: () => null,
  notIncludedLabel: "",
};
