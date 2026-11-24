import type { PlanUi } from "../policy";

/** A copy without plans (`@/plan-policy/ui`, policy.ts): nothing to upgrade to, so nothing renders. */
export const ui: PlanUi = {
  UpgradeNow: () => null,
};
