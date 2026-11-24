"use server";

import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/action-result";
import { OpError, type Actor } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { dismissFixes, markFixesApplied, recordChanges, reopenFix, verifyFixes } from "./ops";

const fixId = (form: FormData) => {
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) throw new Error("That isn't a fix.");
  return id;
};

/** A refusal comes back to the row in plain words; anything else is a real failure. */
async function act(projectId: number, run: (scope: ReturnType<typeof projectScope>, actor: Actor) => Promise<unknown>): Promise<ActionResult> {
  const user = await requireSession();
  const { project } = await requireProject(projectId);
  try {
    await run(projectScope(project), { userId: user.id, source: "app" });
  } catch (err) {
    if (err instanceof OpError) return { error: err.message };
    throw err;
  }
  refresh();
}

export async function markAppliedAction(projectId: number, form: FormData): Promise<ActionResult> {
  return act(projectId, (scope, actor) => markFixesApplied(scope, actor, { ids: [fixId(form)] }));
}

export interface CheckNowState {
  error?: string;
  /** What the check found and what comes next, since the row itself can look the same afterwards. */
  ok?: string;
}

/** A fix row's Check now: the same op as MCP's verify_fix, with its answer kept for the row. */
export async function verifyAction(projectId: number, _prev: CheckNowState, form: FormData): Promise<CheckNowState> {
  let ok = "";
  const refused = await act(projectId, async (scope) => {
    const { fixes, skipped } = await verifyFixes(scope, [fixId(form)], { again: "use Check now again" });
    if (skipped.length) throw new OpError(skipped[0].why);
    ok = fixes[0] ? `Checked just now. ${fixes[0].next_step}` : "";
  });
  return refused ?? { ok };
}

export async function dismissAction(projectId: number, form: FormData): Promise<ActionResult> {
  return act(projectId, (scope, actor) => dismissFixes(scope, actor, { ids: [fixId(form)] }));
}

export async function reopenAction(projectId: number, form: FormData): Promise<ActionResult> {
  return act(projectId, (scope) => reopenFix(scope, fixId(form)));
}

export interface LogChangeState {
  error?: string;
  /** What was logged, and why any page wasn't. */
  ok?: string;
  skipped?: { url: string; why: string }[];
  /** The fields as sent, so a refusal keeps what was typed. */
  fields?: { urls: string; note: string; expect: string; commit: string };
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** The Fixes page's "Log a change": the same op as MCP's record_change. */
export async function logChangeAction(projectId: number, _prev: LogChangeState, form: FormData): Promise<LogChangeState> {
  const user = await requireSession();
  const { project } = await requireProject(projectId);
  const fields = { urls: field(form, "urls"), note: field(form, "note"), expect: field(form, "expect"), commit: field(form, "commit") };
  const urls = fields.urls.split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return { error: "Add at least one page, as a path such as /pricing or a full URL.", fields };
  if (!fields.note) return { error: "Say what changed, in a line.", fields };
  try {
    const res = await recordChanges(projectScope(project), { userId: user.id, source: "app" }, { urls, note: fields.note, expect: fields.expect || null, commit: fields.commit || null });
    refresh();
    const n = res.recorded.length;
    if (!n) return { error: "Nothing was logged.", skipped: res.skipped, fields };
    return { ok: `Logged a change on ${n.toLocaleString("en-US")} ${n === 1 ? "page" : "pages"}. SEOpen checks the live ${n === 1 ? "page" : "pages"} each day, or use Check now once it's deployed.`, skipped: res.skipped };
  } catch (err) {
    if (err instanceof OpError) return { error: err.message, fields };
    throw err;
  }
}
