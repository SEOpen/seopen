import { and, eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { settings, users, workspaceMembers, workspaces, workspaceSettings } from "@/db/schema";
import { contactEmail } from "@/lib/instance";
import { hooks } from "@/plan-policy/hooks";
import { rules } from "@/plan-policy/rules";
import { SpendRefusedError, type Refusal } from "./errors";
import type { BillingWorkspace } from "./limits";
import { monthUsage, platformMonthUsage, reserve, type Reservation } from "./usage";

/**
 * Whether a workspace may spend, and the numbers its reservations are checked against. The
 * DataForSEO client asks here before every paid call; jobs ask before paid work so a blocked
 * workspace's scheduled jobs pause instead of failing.
 */

/** Platform backstop in `settings`: stops every workspace's paid calls once DataForSEO's bill this month reaches it. */
export const PLATFORM_CAP_SETTING_KEY = "platform.monthly_cap_usd";

/** DATAFORSEO_MONTHLY_CAP_USD (default 75): the owner's cap when it set none. Read alone, so billing needs no other env. */
function defaultCapUsd(): number {
  const v = Number(process.env.DATAFORSEO_MONTHLY_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 75;
}

export type SpendWorkspace = BillingWorkspace & {
  id: number;
  status: string;
  trialBlockedReason: string | null;
  /** Null until the workspace's first checkout: a new workspace, not one whose plan lapsed. */
  stripeCustomerId?: string | null;
  /** Why the last charge failed, in the customer's words. */
  billingError?: string | null;
};

export interface SpendState {
  workspace: SpendWorkspace;
  /** Hard monthly ceiling in dollars (Infinity for none). */
  ceilingUsd: number;
  /** Research credits in dollars (Infinity for unlimited). */
  creditsUsd: number;
  platformCapUsd: number | null;
  /** A refusal that holds whatever the call costs: plan, status, email, abuse. */
  refusal: Refusal | null;
}

/** What migration 0007 seeds `platform.monthly_cap_usd` with, and what holds when the row is missing or unreadable. */
export const DEFAULT_PLATFORM_CAP_USD = 100;

/** The platform cap. It fails closed: a missing or invalid setting caps at the default, never at nothing. */
export async function platformCapUsd(): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PLATFORM_CAP_SETTING_KEY));
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PLATFORM_CAP_USD;
}

/** Whether the workspace's owner has confirmed their email. */
async function ownerVerified(workspaceId: number): Promise<boolean> {
  const rows = await db
    .select({ verified: users.emailVerified })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
  return rows.some((r) => r.verified);
}

/**
 * Refusals that don't depend on the amount: a suspended workspace, then whatever the plan policy
 * refuses (no plan, an unconfirmed email). Pure, so the order of the checks is tested.
 */
export function stateRefusal(ws: SpendWorkspace, verified: boolean): Refusal | null {
  if (ws.status !== "active") {
    return { code: "suspended", upgradable: false, message: `This workspace is suspended, so paid checks are off. Cached results still load.${contactEmail() ? ` Questions: ${contactEmail()}.` : ""}` };
  }
  return rules.stateRefusal(ws, verified);
}

/** Paid work the workspace's plan doesn't cover, as the plan policy words it. */
export const FREE_PLAN_REFUSAL: Refusal = rules.notCoveredRefusal;

/** At the monthly ceiling. */
export const ceilingRefusal = (ws: BillingWorkspace, ceiling: number): Refusal => rules.ceilingRefusal(ws, ceiling);

/** The error for paid work whose estimate would pass the workspace's monthly ceiling. */
export const ceilingExceeded = (ws: BillingWorkspace & { id: number }, spentUsd: number, ceiling: number, estimateUsd: number) => rules.ceilingExceeded(ws, spentUsd, ceiling, estimateUsd);

export const creditsRefusal = (ws: BillingWorkspace, creditsUsd: number): Refusal => rules.creditsRefusal(ws, creditsUsd);

/** An AI run started by hand that needs more research credits than are left. */
export const manualRunCreditsRefusal = (ws: BillingWorkspace, estimateUsd: number, leftUsd: number): Refusal => rules.manualRunCreditsRefusal(ws, estimateUsd, leftUsd);

/**
 * What a paused check says now. A ceiling's text is written again from the workspace's plan and cap,
 * because a pause stored before 2026-11-07 can still give the owner's cap in dollars, and a weekly job
 * won't rewrite it until it runs. Other reasons say what they said.
 */
export function pauseMessage(pause: { reason: string; message: string }, state: Pick<SpendState, "workspace" | "ceilingUsd">): string {
  return pause.reason === "ceiling" ? ceilingRefusal(state.workspace, state.ceilingUsd).message : pause.message;
}

export const PLATFORM_REFUSAL: Refusal = {
  code: "platform",
  upgradable: false,
  message: "SEOpen has paused new paid checks for the rest of the month. Cached results still load, and nothing is lost.",
};

/** Reads the spend state now. Spending itself reads this way, so a reservation never runs on an earlier read. */
async function readSpendState(workspaceId: number): Promise<SpendState> {
  const [[row], platformCap] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        plan: workspaces.plan,
        status: workspaces.status,
        limits: workspaces.limits,
        trialBlockedReason: workspaces.trialBlockedReason,
        stripeCustomerId: workspaces.stripeCustomerId,
        billingError: workspaces.billingError,
        grantedAt: workspaces.grantedAt,
        grantEndsAt: workspaces.grantEndsAt,
        ownCap: workspaceSettings.monthlyCapUsd,
      })
      .from(workspaces)
      .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
      .where(eq(workspaces.id, workspaceId)),
    platformCapUsd(),
  ]);
  if (!row) throw new Error(`Workspace ${workspaceId} doesn't exist`);
  const { ownCap, ...stored } = row;
  const ws = rules.withEndedGrant(stored);
  const verified = rules.needsVerifiedOwner(ws) ? await ownerVerified(workspaceId) : true;
  const limits = rules.limitsFor(ws);
  const allowance = await hooks.allowance(ws, {
    ceilingUsd: rules.ceilingUsd(ws, ownCap === null ? null : Number(ownCap), defaultCapUsd()),
    creditsUsd: Number.isFinite(limits.researchCredits) ? limits.researchCredits * rules.creditUsd : Infinity,
  });
  return {
    workspace: ws,
    ceilingUsd: allowance.ceilingUsd,
    creditsUsd: allowance.creditsUsd,
    platformCapUsd: platformCap,
    refusal: stateRefusal(ws, verified),
  };
}

/**
 * The spend state, read once per request for each workspace, like `checkGate()`. React keys it by
 * the workspace id and keeps it for one render only. Server actions, routes and jobs aren't a
 * render, so there it reads fresh every call. Callers share the value: don't change it.
 */
export const spendState = cache(readSpendState);

const finite = (n: number) => (Number.isFinite(n) ? n : null);

/**
 * Reserves a paid call's estimate for the workspace, or throws SpendRefusedError. The caller must
 * `settle` (or `release`) the reservation once the call is done. `researchEstimateUsd` holds less than
 * the estimate against research credits for a research call (see `reserve`).
 */
export async function reserveSpend(workspaceId: number, estimateUsd: number, research: boolean, module?: string, researchEstimateUsd?: number): Promise<Reservation> {
  // Read now, not from the request's cache: a paid call checks the state as it is.
  const state = await readSpendState(workspaceId);
  if (state.refusal) throw new SpendRefusedError(workspaceId, state.refusal, { estimateUsd });
  const notCovered = rules.paidWorkRefusal(state.workspace, module);
  if (notCovered) throw new SpendRefusedError(workspaceId, notCovered, { estimateUsd });
  try {
    return await reserve({
      workspaceId,
      estimateUsd,
      research,
      researchEstimateUsd,
      ceilingUsd: finite(state.ceilingUsd),
      creditsUsd: finite(state.creditsUsd),
      platformCapUsd: state.platformCapUsd,
      refusals: { ceiling: ceilingRefusal(state.workspace, state.ceilingUsd), credits: creditsRefusal(state.workspace, state.creditsUsd), platform: PLATFORM_REFUSAL },
    });
  } catch (err) {
    // The reservation's transaction has already rolled back here.
    if (err instanceof SpendRefusedError) hooks.refused(workspaceId, err.refusal);
    throw err;
  }
}

/**
 * Why paid work for this workspace can't start now (for jobs and Run buttons), or null. Not a
 * reservation: the call itself still reserves atomically.
 */
export async function spendBlock(workspaceId: number, opts: { research?: boolean } = {}): Promise<Refusal | null> {
  const state = await spendState(workspaceId);
  if (state.refusal) return state.refusal;
  const [usage, platform] = await Promise.all([monthUsage(workspaceId), state.platformCapUsd === null ? null : platformMonthUsage()]);
  if (usage.spentUsd + usage.reservedUsd >= state.ceilingUsd) return ceilingRefusal(state.workspace, state.ceilingUsd);
  if (opts.research && usage.researchUsd + usage.researchReservedUsd >= state.creditsUsd) return creditsRefusal(state.workspace, state.creditsUsd);
  if (platform && state.platformCapUsd !== null && platform.spentUsd + platform.reservedUsd >= state.platformCapUsd) return PLATFORM_REFUSAL;
  return null;
}

/** Everything the billing page and the spend pill show about this month. */
export async function usageSummary(workspaceId: number) {
  const [state, usage] = await Promise.all([spendState(workspaceId), monthUsage(workspaceId)]);
  const creditsTotal = Number.isFinite(state.creditsUsd) ? rules.creditsUsed(state.creditsUsd) : null;
  return {
    state,
    spentUsd: usage.spentUsd,
    ceilingUsd: state.ceilingUsd,
    creditsUsed: rules.creditsUsed(usage.researchUsd),
    creditsTotal,
  };
}
