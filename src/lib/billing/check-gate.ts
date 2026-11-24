import { cache } from "react";
import { rules } from "@/plan-policy/rules";
import type { Refusal } from "./errors";
import { FREE_PLAN_REFUSAL, spendBlock } from "./spend";
import { auditRefusal, LOCKED_REFUSAL, loadBillingWorkspace, lockedProjects } from "./workspace";

/** The modules whose checks spend, so a plan or a spend limit can refuse them. Searched by dashboard module id. */
const PAID_CHECKS: ReadonlySet<string> = new Set(["rank", "local", "ai", "audit"]);

export interface CheckGateState {
  free: boolean;
  locked: Set<number>;
  /** Why the workspace can't spend, for a check and for one that uses research credits, which Local does. */
  spend: Refusal | null;
  research: Refusal | null;
  /** Why an audit can't start beyond spend, such as a plan's audits used up. */
  audit: Refusal | null;
}

/** Why a module's check on this project would be refused now, or null. Same order as the buttons (`projectActionRefusal`). Pure. */
export function checkRefusal(state: CheckGateState, moduleId: string, projectId: number): Refusal | null {
  if (state.locked.has(projectId)) return LOCKED_REFUSAL;
  if (!PAID_CHECKS.has(moduleId)) return null;
  if (state.free && moduleId !== "audit") return FREE_PLAN_REFUSAL;
  return (moduleId === "local" ? state.research : state.spend) ?? (moduleId === "audit" ? state.audit : null);
}

export type CheckGate = (moduleId: string, projectId: number) => Refusal | null;

/**
 * Reads what `checkRefusal` needs once for a workspace, however many projects it then answers for, so
 * All projects doesn't get slower per project. Sends no email: only a refused action does. Cached per request.
 */
export const checkGate = cache(async (workspaceId: number): Promise<CheckGate> => {
  const ws = await loadBillingWorkspace(workspaceId);
  const [locked, spend, research, audit] = await Promise.all([lockedProjects(ws), spendBlock(workspaceId), spendBlock(workspaceId, { research: true }), auditRefusal(ws)]);
  const state: CheckGateState = { free: rules.isFree(ws), locked, spend, research, audit };
  return (moduleId, projectId) => checkRefusal(state, moduleId, projectId);
});
