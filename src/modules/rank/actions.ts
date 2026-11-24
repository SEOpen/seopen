"use server";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { keywordsListItems, keywordsLists } from "@/db/schema/keywords";
import { rankKeywords, rankSettings } from "@/db/schema/rank";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { depthGate, gateRefusal, keywordGate, loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { OpError } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import type { ProjectScope } from "@/lib/workspace";
import { trackKeywordsOp, startRankCheckOp } from "./ops";
import { normalizeKeywords, parseKeywordList, parseTags } from "./parse";
import { requireSession } from "@/lib/auth/session";

/** Result of a form action, shown under the form. */
export interface ActionState {
  ok?: string;
  error?: string;
  /** What was pasted, so an error doesn't wipe it. */
  keywords?: string;
  tags?: string;
  /** When the paste is over the plan's limit: how many of it fit. */
  room?: number;
}


/** The scope's keywords with these ids (ids of another project or workspace match nothing). */
const keywordsIn = (s: ProjectScope, ids: number[]) =>
  and(eq(rankKeywords.workspaceId, s.workspaceId), eq(rankKeywords.projectId, s.projectId), inArray(rankKeywords.id, ids));

/**
 * Adds keywords with optional tags, from the pasted text or (when the submit
 * button sends source=list) from a saved keyword list. Both go through the same
 * path: lowercased and deduped, and keywords already tracked get the tags merged.
 */
export async function addKeywords(projectId: number, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const locked = await projectActionRefusal(scope);
  if (locked) return { error: locked.message };
  const tags = parseTags(String(formData.get("tags") ?? ""));
  const device: "desktop" | "mobile" = formData.get("device") === "mobile" ? "mobile" : "desktop";

  let raw: string[];
  let from = "";
  if (formData.get("source") === "list") {
    const listId = Number(formData.get("listId"));
    if (!Number.isInteger(listId) || listId <= 0) return { error: "Pick a saved list first." };
    const [list] = await db
      .select({ name: keywordsLists.name })
      .from(keywordsLists)
      .where(and(eq(keywordsLists.id, listId), eq(keywordsLists.workspaceId, scope.workspaceId), eq(keywordsLists.projectId, scope.projectId)));
    if (!list) return { error: "That list no longer exists." };
    const items = await db
      .select({ keyword: keywordsListItems.keyword })
      .from(keywordsListItems)
      .where(and(eq(keywordsListItems.workspaceId, scope.workspaceId), eq(keywordsListItems.listId, listId)))
      .orderBy(asc(keywordsListItems.createdAt), asc(keywordsListItems.id));
    raw = items.map((i) => i.keyword);
    from = ` from “${list.name}”`;
    if (!raw.length) return { error: `“${list.name}” has no keywords yet.` };
  } else {
    const pasted = String(formData.get("keywords") ?? "");
    const kept = { keywords: pasted, tags: String(formData.get("tags") ?? "") };
    raw = parseKeywordList(pasted);
    if (!raw.length) return { error: "Paste at least one keyword.", ...kept };
    let all = normalizeKeywords(raw);
    // "Add the first N" after an over-limit paste.
    const fit = Number(formData.get("fit"));
    if (Number.isInteger(fit) && fit > 0) all = all.slice(0, fit);
    const res = await trackKeywords(scope, all, tags, device, from);
    if (!res.error) return res;
    const gate = await keywordGate(await loadBillingWorkspace(scope.workspaceId), scope.projectId, all.length);
    return { ...res, ...kept, room: gate.ok || !gate.room ? undefined : gate.room };
  }
  return trackKeywords(scope, normalizeKeywords(raw), tags, device, from);
}

async function trackKeywords(
  scope: ProjectScope,
  all: string[],
  tags: string[],
  device: "desktop" | "mobile",
  from: string,
): Promise<ActionState> {
  const user = await requireSession();
  try {
    const res = await trackKeywordsOp(scope, { userId: user.id, source: "app" }, { keywords: all, tags, device, from });
    refresh();
    return { ok: res.message };
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
}

/** Deletes keywords and their history. */
export async function removeKeywords(projectId: number, ids: number[]): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  if (!ids.length) return;
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  await db.delete(rankKeywords).where(keywordsIn(scope, ids));
  refresh();
}

export async function removeKeywordAndReturn(projectId: number, id: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  await db.delete(rankKeywords).where(keywordsIn(scope, [id]));
  redirect("/rank");
}

/** Adds (or with `remove`, strips) tags on several keywords. */
export async function tagKeywords(projectId: number, ids: number[], tagText: string, remove = false): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const tags = parseTags(tagText);
  if (!ids.length || !tags.length) return;
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  const tagArray = sql`${`{${tags.map((t) => `"${t.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`;
  await db
    .update(rankKeywords)
    .set({
      tags: remove
        ? sql`array(select t from unnest(${rankKeywords.tags}) t where t <> all(${tagArray}) order by 1)`
        : sql`array(select distinct unnest(${rankKeywords.tags} || ${tagArray}) order by 1)`,
    })
    .where(keywordsIn(scope, ids));
  refresh();
}

/** Replaces one keyword's tags (keyword detail page). */
export async function setKeywordTags(projectId: number, id: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  const tags = parseTags(String(formData.get("tags") ?? ""));
  await db.update(rankKeywords).set({ tags }).where(keywordsIn(scope, [id]));
  refresh();
}

export async function setKeywordsActive(projectId: number, ids: number[], active: boolean): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  if (!ids.length) return;
  if (active) {
    const refusal = await projectActionRefusal(scope);
    if (refusal) return refusalResult(refusal);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rankKeywords)
      .where(and(keywordsIn(scope, ids), eq(rankKeywords.active, false)));
    const ws = await loadBillingWorkspace(scope.workspaceId);
    const gate = await keywordGate(ws, scope.projectId, n);
    if (!gate.ok) return gateRefusal(ws, gate.message, "keywords");
  }
  await db.update(rankKeywords).set({ active }).where(keywordsIn(scope, ids));
  refresh();
}

/**
 * "Check now": posts a run for all active keywords. The "deep" button
 * (mode=deep) uses the sweep depth and loads AI Overviews.
 */
export async function checkNow(projectId: number, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const deep = formData.get("mode") === "deep";
  try {
    await startRankCheckOp(scope, { deep });
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    refresh();
    return { error: e.message };
  }
  refresh();
  return { ok: deep ? "Deep check started." : "Check started." };
}

const settingsInput = z.object({
  dailyDepth: z.coerce.number().int().min(10).max(100),
  sweepDepth: z.coerce.number().int().min(10).max(200),
  sweepWeekday: z.coerce.number().int().min(-1).max(6),
  enabled: z.preprocess((v) => v === "on", z.boolean()),
});

export async function updateSettings(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const input = settingsInput.parse({
    dailyDepth: formData.get("dailyDepth"),
    sweepDepth: formData.get("sweepDepth"),
    sweepWeekday: formData.get("sweepWeekday"),
    enabled: formData.get("enabled"),
  });
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const gate = await depthGate(ws, scope.projectId, input.dailyDepth);
  if (!gate.ok) return gateRefusal(ws, gate.message, "keywords");
  await db
    .insert(rankSettings)
    .values({ ...scope, ...input })
    .onConflictDoUpdate({ target: rankSettings.projectId, set: { ...input, updatedAt: new Date() } });
  refresh();
}
