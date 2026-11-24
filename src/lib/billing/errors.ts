/**
 * Errors for a paid call that may not run. Kept in their own file so the DataForSEO client and the
 * billing code can both import them without a cycle; the client re-exports them.
 */

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
    readonly estimateUsd = 0,
    message?: string,
  ) {
    super(
      message ??
        (spentUsd < capUsd
          ? `This would cost about $${estimateUsd.toFixed(2)}, which would pass the DataForSEO monthly cap ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent). Raise the cap in Admin → Spend to continue.`
          : `DataForSEO monthly cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent. Raise the cap in Admin → Spend to continue.`),
    );
    this.name = "BudgetExceededError";
  }
}

/** Why a workspace's paid call (or paid job) was refused. */
export type RefusalCode =
  | "suspended"
  | "no_plan"
  | "unverified"
  | "trial_blocked"
  | "ceiling"
  | "credits"
  | "platform"
  | "trial_audit"
  | "trial_lighthouse"
  | "free_plan"
  | "free_audit"
  | "ai_manual_runs"
  | "free_site"
  | "locked";

export interface Refusal {
  code: RefusalCode;
  message: string;
  /** A trial limit: the page offers Upgrade now. */
  upgradable: boolean;
}

/**
 * A paid call refused by billing: the workspace's plan, a limit or the platform cap. A subclass of
 * BudgetExceededError, so everything that already handles the cap (ApiError, the jobs) handles it.
 */
export class SpendRefusedError extends BudgetExceededError {
  readonly code: RefusalCode;
  readonly upgradable: boolean;
  constructor(
    readonly workspaceId: number,
    refusal: Refusal,
    usage: { spentUsd?: number; capUsd?: number; estimateUsd?: number } = {},
  ) {
    super(usage.spentUsd ?? 0, usage.capUsd ?? 0, usage.estimateUsd ?? 0, refusal.message);
    this.name = "SpendRefusedError";
    this.code = refusal.code;
    this.upgradable = refusal.upgradable;
  }

  get refusal(): Refusal {
    return { code: this.code, message: this.message, upgradable: this.upgradable };
  }
}

/** Short titles for a refusal, for callouts and the paused-job banner. */
export const REFUSAL_TITLES: Record<RefusalCode, string> = {
  suspended: "Workspace suspended",
  no_plan: "No active plan",
  unverified: "Confirm your email first",
  trial_blocked: "Trial ended",
  ceiling: "Monthly limit reached",
  credits: "Research credits used up",
  platform: "Paid checks paused",
  trial_audit: "Trial audit used",
  trial_lighthouse: "Not in the trial",
  free_plan: "Not on the Free plan",
  free_audit: "This week's audit used",
  ai_manual_runs: "This week's run used",
  free_site: "Site on another Free workspace",
  locked: "Project is read-only",
};
