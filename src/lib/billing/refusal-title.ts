import { rules } from "@/plan-policy/rules";
import { REFUSAL_TITLES, type RefusalCode } from "./errors";

/**
 * On a copy without plans two codes mean something else (self-hosted/rules.ts): `no_plan` is a
 * workspace that signed itself up, which runs no paid checks, and `credits` is the month's research budget.
 */
const WITHOUT_PLANS: Partial<Record<RefusalCode, string>> = {
  no_plan: "Paid checks are off",
  credits: "Research budget used",
};

/** A refusal's short title, for callouts and the paused-job banner. `fallback` for a code with none. */
export function refusalTitle(code: string, fallback = "Paused"): string {
  const own = rules.hasPlans ? undefined : WITHOUT_PLANS[code as RefusalCode];
  return own ?? REFUSAL_TITLES[code as RefusalCode] ?? fallback;
}
