import type { PlanHooks } from "../policy";

/**
 * A copy without plans (`@/plan-policy/hooks`, policy.ts): nothing is counted against a plan, so
 * there's nothing to claim, refuse or email. A workspace the operator makes (an invite, an admin,
 * `pnpm owner:create --customer`) starts on the internal plan and may spend up to its cap; one made by
 * signing up starts on Free, the column's default, which spends nothing here (rules.ts).
 */
export const hooks: PlanHooks = {
  siteRefusal: async () => null,
  sitesChanged: async () => {},
  connected: async () => {},
  refused: () => {},
  auditRefusal: async () => null,
  allowance: async (_ws, allowance) => allowance,
  newWorkspacePlan: (by) => (by === "operator" ? "internal" : "free"),
};
