"use server";

import { and, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addCompetitor } from "@/app/actions/projects";
import { db } from "@/db";
import { aiBrandAliases, aiPrompts } from "@/db/schema/ai";
import { projects } from "@/db/schema/core";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { gateRefusal, loadBillingWorkspace, projectActionRefusal, promptGate } from "@/lib/billing/workspace";
import { BudgetExceededError, DataForSEOError } from "@/lib/dataforseo/client";
import { plainActionFailure } from "@/lib/dataforseo/failure-copy";
import { OpError } from "@/lib/ops";
import { normalizeDomain, requireProject } from "@/lib/projects";
import { inScope, type ProjectScope } from "@/lib/workspace";
import type { ActionStatus } from "./action-list";
import { saveToListOp, setActionStatusOp, type ActionRef } from "./action-ops";
import { fetchProjectKeywords } from "./dfs";
import { addPromptsOp, platformsSchema, projectTopics, startAiRunOp } from "./ops";
import { canonicalTopic, keywordToPrompt, projectPlaces, suggestTopics } from "./prompts";
import { loadBrands, redetectProject } from "./run";
import { requireSession } from "@/lib/auth/session";

/** A prompt of the scope, by id: another project's or workspace's id matches nothing. */
const promptIn = (s: ProjectScope, promptId: number) => and(eq(aiPrompts.id, promptId), inScope(aiPrompts, s));

/** Add prompts (deduped per project). The client shows the monthly cost before calling this. */
export async function addPrompts(
  projectId: number,
  items: { prompt: string; keyword?: string | null; source?: "manual" | "suggested"; topic?: string | null }[],
  platforms: string[],
): Promise<ActionResult> {
  const user = await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await addPromptsOp(scope, { userId: user.id, source: "app" }, items, platforms);
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  refresh();
}

export async function setPromptActive(projectId: number, promptId: number, active: boolean): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  if (active) {
    const refusal = await projectActionRefusal(scope);
    if (refusal) return refusalResult(refusal);
    const [row] = await db.select({ active: aiPrompts.active }).from(aiPrompts).where(promptIn(scope, promptId));
    const ws = await loadBillingWorkspace(scope.workspaceId);
    const gate = await promptGate(ws, row && !row.active ? 1 : 0);
    if (!gate.ok) return gateRefusal(ws, gate.message, "prompts");
  }
  await db.update(aiPrompts).set({ active }).where(promptIn(scope, promptId));
  refresh();
}

export async function updatePrompt(projectId: number, promptId: number, input: { keyword: string | null; platforms: string[]; topic?: string | null }) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const pl = platformsSchema.parse(input.platforms);
  const keyword = z.string().trim().max(200).nullable().parse(input.keyword) || null;
  const topic = input.topic === undefined ? undefined : canonicalTopic(z.string().max(200).nullable().parse(input.topic), await projectTopics(scope));
  await db.update(aiPrompts).set({ keyword, platforms: pl, topic }).where(promptIn(scope, promptId));
  refresh();
}

/** Put several prompts under one topic, or none (null). */
export async function setPromptsTopic(projectId: number, promptIds: number[], topic: string | null) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const ids = z.array(z.number().int()).min(1).max(500).parse(promptIds);
  const value = canonicalTopic(z.string().max(200).nullable().parse(topic), await projectTopics(scope));
  await db.update(aiPrompts).set({ topic: value }).where(and(inScope(aiPrompts, scope), inArray(aiPrompts.id, ids)));
  refresh();
}

export async function deletePrompt(projectId: number, promptId: number) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  await db.delete(aiPrompts).where(promptIn(scope, promptId));
  redirect("/ai/prompts");
}

/** Delete prompts from the table, with their stored answers, and stay on the page. */
export async function deletePrompts(projectId: number, promptIds: number[]) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const ids = z.array(z.number().int()).min(1).max(500).parse(promptIds);
  await db.delete(aiPrompts).where(and(inScope(aiPrompts, scope), inArray(aiPrompts.id, ids)));
  refresh();
}

/** Queue a run of every active prompt now. */
export async function runNow(projectId: number): Promise<{ ok: boolean; message: string; upgradable?: boolean }> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await startAiRunOp(scope);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, message: e.message, upgradable: e.refusal?.upgradable };
    throw e;
  }
  refresh();
  return { ok: true, message: "Run queued. Answers arrive over the next few minutes." };
}

export interface Suggestion {
  keyword: string;
  volume: number;
  prompt: string;
  promptKeyword: string;
  /** A topic shared with other suggestions (or one already in use), or null. */
  topic: string | null;
}

/**
 * Question-style prompts from the project's keywords, for research credits (at most SUGGEST_MAX_USD,
 * cached for a week).
 * Branded keywords and prompts already tracked are left out.
 */
export async function suggestPrompts(projectId: number, fromDomain?: string): Promise<{ suggestions: Suggestion[]; error?: string }> {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  // Any of our own domains (the project's, or an alias domain on the Brands tab).
  const own = (await loadBrands(project))[0];
  const domain = fromDomain && own.domains.includes(fromDomain) ? fromDomain : project.domain;
  try {
    const keywords = await fetchProjectKeywords(domain, {
      ...scope,
      locationCode: project.locationCode,
      languageCode: project.languageCode,
    });
    const brandNames = own.names.map((n) => n.toLowerCase().replace(/[\s.-]+/g, ""));
    const existing = new Set(
      (await db.select({ prompt: aiPrompts.prompt }).from(aiPrompts).where(inScope(aiPrompts, scope))).map((p) => p.prompt.toLowerCase()),
    );
    const places = projectPlaces(project);
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const k of keywords.sort((a, b) => b.volume - a.volume)) {
      const squashed = k.keyword.toLowerCase().replace(/[\s-]+/g, "");
      if (brandNames.some((b) => b && squashed.includes(b))) continue;
      const prompt = keywordToPrompt(k.keyword, places);
      if (!prompt || seen.has(prompt.toLowerCase()) || existing.has(prompt.toLowerCase())) continue;
      seen.add(prompt.toLowerCase());
      out.push({ keyword: k.keyword, volume: k.volume, prompt, promptKeyword: k.keyword, topic: null });
      if (out.length >= 25) break;
    }
    const topics = suggestTopics(
      out.map((o) => o.keyword),
      await projectTopics(scope),
    );
    return { suggestions: out.map((o, i) => ({ ...o, topic: topics[i] })) };
  } catch (err) {
    if (err instanceof BudgetExceededError || err instanceof DataForSEOError) return { suggestions: [], error: plainActionFailure(err, "ai.suggest") };
    throw err;
  }
}

/** Whether AI visibility counts branded prompts, everywhere it shows for this project. */
export async function setIncludeBranded(projectId: number, on: boolean) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  await db
    .update(projects)
    .set({ aiIncludeBranded: on })
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  refresh();
}

/** Add a brand alias (a name, or an extra domain) and re-run detection on stored answers. */
export async function addAlias(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const domain = z.string().trim().min(3).parse(formData.get("domain"));
  const alias = z.string().trim().min(2).max(80).safeParse(formData.get("alias"));
  if (!alias.success) return { error: "Enter an alias of 2 to 80 characters." };
  await db.insert(aiBrandAliases).values({ ...scope, domain, alias: alias.data }).onConflictDoNothing();
  await redetectProject(scope);
  refresh();
}

export async function removeAlias(projectId: number, aliasId: number) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  await db.delete(aiBrandAliases).where(and(eq(aiBrandAliases.id, aliasId), inScope(aiBrandAliases, scope)));
  await redetectProject(scope);
  refresh();
}

/** Track a cited site as a competitor (the project's competitor list) and re-check stored answers for it, at no cost. */
export async function addSuggestedCompetitor(projectId: number, domain: string): Promise<ActionResult> {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  const d = normalizeDomain(z.string().trim().min(3).max(253).parse(domain));
  if (!d || d === project.domain) return;
  const form = new FormData();
  form.set("domain", d);
  const notAdded = await addCompetitor(projectId, form);
  if (notAdded) return notAdded;
  await redetectProject(scope);
  refresh();
}

/** Marks one action on AI visibility → Actions open, done or dismissed. */
export async function setAiActionStatus(projectId: number, ref: ActionRef, status: ActionStatus): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await setActionStatusOp(scope, [ref], status);
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  refresh();
}

/** Puts a Get featured page on the outreach list, or takes it off. */
export async function saveAiActionToList(projectId: number, ref: ActionRef, saved: boolean): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await saveToListOp(scope, ref, saved);
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  refresh();
}
