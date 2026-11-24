import { isInternal, type BillingWorkspace } from "@/lib/billing/gates";
import type { WallClock } from "@/lib/schedule";

/** When the recap goes out on Mondays, on the schedule's clock (src/lib/schedule.ts). */
export const RECAP_AT: WallClock = "10:00";

/** The plans whose workspaces get the weekly recap. Free doesn't: it runs only the audit, so most weeks there'd be little to say. */
const RECAP_PLANS: ReadonlySet<string> = new Set(["starter", "pro", "trial", "internal"]);

export const onRecapPlan = (ws: BillingWorkspace) => RECAP_PLANS.has(ws.plan);

/**
 * The rollout gate: the owner's workspace only for now (the internal plan, like `claudeSetupOpen`).
 * Widening the recap to every plan above means changing this one function to return true.
 */
export const recapRolledOut = (ws: BillingWorkspace) => isInternal(ws);

/** Whether a workspace's members can turn the recap on and get it. Read the plan through `withEndedGrant` first. */
export const recapOpen = (ws: BillingWorkspace) => onRecapPlan(ws) && recapRolledOut(ws);
