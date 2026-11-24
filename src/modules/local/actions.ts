"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { localBusinesses, localKeywords } from "@/db/schema/local";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { requireSession } from "@/lib/auth/session";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { plainActionFailure } from "@/lib/dataforseo/failure-copy";
import { OpError } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import { isGridSize, isRadius } from "./grid";
import { addBusinessOp, addLocalKeywordsOp, findListingsOp, startLocalCheckOp } from "./ops";
import { parseKeywords, type Candidate } from "./parse";
import { getBusiness } from "./tracker";

/** Result of a form action, shown under the form. */
export interface ActionState {
  ok?: string;
  error?: string;
}

export interface FindState extends ActionState {
  name?: string;
  city?: string;
  candidates?: Candidate[];
}

const clean = (v: FormDataEntryValue | null, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Step 1 of adding a business: look it up on Google Maps and offer the listings found. */
export async function findListings(projectId: number, _prev: FindState, formData: FormData): Promise<FindState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const name = clean(formData.get("name"));
  const city = clean(formData.get("city"));
  try {
    const { candidates, message } = await findListingsOp(scope, { name, city });
    return candidates.length ? { name, city, candidates } : { name, city, candidates, error: message };
  } catch (e) {
    return { name, city, error: plainActionFailure(e, "local.find") };
  }
}

/** Step 2: track the listing the user picked (see `addBusinessOp`). */
export async function addBusiness(projectId: number, _prev: FindState, formData: FormData): Promise<FindState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const name = clean(formData.get("name"));
  const city = clean(formData.get("city"));
  let added;
  try {
    added = await addBusinessOp(scope, { name, city, listing: String(formData.get("listing") ?? ""), scheduled: formData.get("scheduled") === "on" });
  } catch (e) {
    return { name, city, error: plainActionFailure(e, "local.add") };
  }
  redirect(`/local/${added.businessId}`);
}

/** Deletes a business with its keywords and every check. */
export async function removeBusiness(projectId: number, businessId: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const locked = await projectActionRefusal(scope);
  if (locked) return refusalResult(locked);
  await db
    .delete(localBusinesses)
    .where(and(eq(localBusinesses.id, businessId), eq(localBusinesses.workspaceId, scope.workspaceId), eq(localBusinesses.projectId, scope.projectId)));
  redirect("/local");
}

/** Grid size, radius and the weekly schedule. Takes effect from the next check; history keeps its own grid. */
export async function updateBusiness(projectId: number, businessId: number, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const business = await getBusiness(scope, businessId);
  if (!business) return { error: "That business no longer exists." };
  const locked = await projectActionRefusal(scope);
  if (locked) return { error: locked.message };
  const gridSize = Number(formData.get("gridSize"));
  const radiusMiles = Number(formData.get("radiusMiles"));
  if (!isGridSize(gridSize) || !isRadius(radiusMiles)) return { error: "Pick a grid and a radius from the lists." };
  const scheduled = formData.get("scheduled") === "on";
  await db
    .update(localBusinesses)
    .set({ gridSize, radiusMiles, scheduled })
    .where(and(eq(localBusinesses.id, business.id), eq(localBusinesses.workspaceId, scope.workspaceId)));
  refresh();
  return { ok: "Saved. The next check uses this grid." };
}

/** Adds keywords to a business: trimmed, lowercased and deduped, against what's already there. */
export async function addKeywords(projectId: number, businessId: number, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    const { message } = await addLocalKeywordsOp(scope, businessId, parseKeywords(String(formData.get("keywords") ?? "")));
    refresh();
    return { ok: message };
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
}

/** Removes a keyword and its history. */
export async function removeKeyword(projectId: number, businessId: number, keywordId: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const business = await getBusiness(scope, businessId);
  if (!business) return;
  const locked = await projectActionRefusal(scope);
  if (locked) return refusalResult(locked);
  await db
    .delete(localKeywords)
    .where(and(eq(localKeywords.id, keywordId), eq(localKeywords.workspaceId, scope.workspaceId), eq(localKeywords.businessId, business.id)));
  refresh();
}

/** "Check now": every keyword at every point of the business's grid. One check at a time per business. */
export async function checkNow(projectId: number, businessId: number): Promise<ActionState> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await startLocalCheckOp(scope, businessId);
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    refresh();
    return { error: e.message };
  }
  refresh();
  return { ok: "Check started." };
}
