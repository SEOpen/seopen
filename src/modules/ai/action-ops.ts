import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiActions } from "@/db/schema/ai";
import { projects } from "@/db/schema/core";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { OpError, plural, refused, type OpOptions } from "@/lib/ops";
import type { ProjectScope } from "@/lib/workspace";
import { ACTION_KINDS, ACTION_STATUSES, actionKey, type Action, type ActionKind, type ActionStatus } from "./action-list";
import { getAiActions } from "./data";

/**
 * Changes to AI visibility → Actions, shared by the Actions tab and the MCP server (see `src/lib/ops`).
 * They record what someone decided; nothing is posted or sent anywhere.
 */

export const MAX_ACTION_CHANGES = 50;

/** One action, as the Actions tab and `get_ai_actions` name it. */
export interface ActionRef {
  promptId: number;
  kind: ActionKind;
  /** The cited page; empty or left out for "write". */
  url?: string | null;
}

export interface StatusOutcome {
  dryRun: boolean;
  status: ActionStatus;
  changed: ActionRef[];
  skipped: (ActionRef & { why: string })[];
  message: string;
}

async function projectOf(scope: ProjectScope) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) throw new OpError("There's no such project in this workspace.");
  return project;
}

/** The project's current actions by key, as the Actions tab shows them. */
async function currentActions(scope: ProjectScope): Promise<Map<string, Action>> {
  const { prompts } = await getAiActions(await projectOf(scope));
  return new Map(prompts.flatMap((p) => p.actions.map((a) => [actionKey({ promptId: p.promptId, kind: a.kind, url: a.url }), a] as const)));
}

const refOf = (r: ActionRef): ActionRef & { url: string } => ({ promptId: r.promptId, kind: r.kind, url: r.kind === "write" ? "" : (r.url ?? "").trim() });

function checkRefs(refs: ActionRef[]) {
  if (!refs.length || refs.length > MAX_ACTION_CHANGES) throw new OpError(`Give between 1 and ${MAX_ACTION_CHANGES} actions.`);
  for (const r of refs) {
    if (!Number.isInteger(r.promptId) || !(ACTION_KINDS as readonly string[]).includes(r.kind)) throw new OpError(`Each action needs a prompt id and a kind: ${ACTION_KINDS.join(", ")}.`);
  }
}

/**
 * Marks actions open, done or dismissed. Only actions on the Actions tab now can change: a prompt the
 * latest run names has none, and a page no answer cites any more isn't one.
 */
export async function setActionStatusOp(scope: ProjectScope, refs: ActionRef[], status: ActionStatus, opts: OpOptions = {}): Promise<StatusOutcome> {
  if (!(ACTION_STATUSES as readonly string[]).includes(status)) throw new OpError(`Status is one of ${ACTION_STATUSES.join(", ")}.`);
  checkRefs(refs);
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const current = await currentActions(scope);
  const changed: (ActionRef & { url: string })[] = [];
  const skipped: StatusOutcome["skipped"] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = refOf(raw);
    const key = actionKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const action = current.get(key);
    if (!action) skipped.push({ ...ref, why: "It isn't on the Actions list now: the latest run names the site for this prompt, or no answer cites that page." });
    else if (action.status === status) skipped.push({ ...ref, why: `It's already ${status}.` });
    else changed.push(ref);
  }
  const what = `${plural(changed.length, "action")} as ${status}`;
  if (opts.dryRun) return { dryRun: true, status, changed, skipped, message: `Would mark ${what}.` };
  if (changed.length) {
    const now = new Date();
    await db
      .insert(aiActions)
      .values(changed.map((r) => ({ workspaceId: scope.workspaceId, projectId: scope.projectId, promptId: r.promptId, kind: r.kind, url: r.url, status, updatedAt: now })))
      .onConflictDoUpdate({ target: [aiActions.projectId, aiActions.promptId, aiActions.kind, aiActions.url], set: { status, updatedAt: now } });
  }
  return { dryRun: false, status, changed, skipped, message: `Marked ${what}.` };
}

/** Saves a cited page from a Get featured action to the outreach list, or takes it off. */
export async function saveToListOp(scope: ProjectScope, ref: ActionRef, saved: boolean): Promise<void> {
  if (ref.kind !== "featured") throw new OpError("Only a Get featured page can go on the outreach list.");
  checkRefs([ref]);
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const r = refOf(ref);
  const now = new Date();
  if (saved) {
    if (!(await currentActions(scope)).has(actionKey(r))) throw new OpError("That page isn't on the Actions list now.");
    await db
      .insert(aiActions)
      .values({ workspaceId: scope.workspaceId, projectId: scope.projectId, promptId: r.promptId, kind: r.kind, url: r.url, savedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [aiActions.projectId, aiActions.promptId, aiActions.kind, aiActions.url], set: { savedAt: sql`coalesce(${aiActions.savedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now } });
  } else {
    // Taking a page off the list works even after no answer cites it any more.
    await db
      .update(aiActions)
      .set({ savedAt: null, updatedAt: now })
      .where(and(eq(aiActions.workspaceId, scope.workspaceId), eq(aiActions.projectId, scope.projectId), eq(aiActions.promptId, r.promptId), eq(aiActions.kind, r.kind), eq(aiActions.url, r.url)));
  }
}
