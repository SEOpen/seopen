"use server";

import { and, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { keywordsListItems, keywordsLists } from "@/db/schema";
import { refusalResult, type ActionRefusal, type ActionResult } from "@/lib/action-result";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { LOCATIONS } from "@/lib/dataforseo/locations";
import { getCurrentProject } from "@/lib/projects";
import { projectScope, type ProjectScope } from "@/lib/workspace";
import { requireSession } from "@/lib/auth/session";

const itemInput = z.object({
  keyword: z.string().trim().min(1).max(700),
  volume: z.number().int().nullable().optional(),
  kd: z.number().nullable().optional(),
  cpc: z.number().nullable().optional(),
  competition: z.number().nullable().optional(),
  intent: z.string().nullable().optional(),
});

/** The market the keywords were researched in. */
const marketInput = z.object({
  locationCode: z.number().int().positive(),
  languageCode: z.string().regex(/^[a-z]{2,3}(-[a-z]{2,4})?$/i),
});

const addInput = z.object({
  /** An existing list id, or a new list name. */
  listId: z.number().int().positive().optional(),
  newName: z.string().trim().min(1).max(80).optional(),
  source: z.string().max(200).optional(),
  market: marketInput,
  items: z.array(itemInput).min(1).max(2000),
});

const listIdInput = z.number().int().positive();
const keywordsInput = z.array(z.string().trim().min(1).max(700)).max(2000);
const nameInput = z.string().trim().min(1).max(80);

export type AddToListInput = z.input<typeof addInput>;

/** The current project (of the current workspace); lists belong to it. */
async function requireProject() {
  const project = await getCurrentProject();
  if (!project) throw new Error("Create a project first: keyword lists belong to a project.");
  return { project, scope: projectScope(project) };
}

/** A read-only project (after a downgrade) keeps its lists as they are. */
async function lockedRefusal(scope: ProjectScope): Promise<ActionRefusal | null> {
  const refusal = await projectActionRefusal(scope);
  return refusal ? refusalResult(refusal) : null;
}

const inScope = (s: ProjectScope) => and(eq(keywordsLists.workspaceId, s.workspaceId), eq(keywordsLists.projectId, s.projectId));
const listWhere = (s: ProjectScope, id: number) => and(eq(keywordsLists.id, id), inScope(s));

/** A known location with its own language, or the project's own market. */
function checkMarket(m: z.infer<typeof marketInput>, project: { locationCode: number; languageCode: string }) {
  const known = LOCATIONS.some((l) => l.code === m.locationCode && l.languageCode === m.languageCode);
  const own = m.locationCode === project.locationCode && m.languageCode === project.languageCode;
  if (!known && !own) throw new Error("Unknown market for these keywords.");
}

/** Postgres unique_violation, possibly wrapped by the driver. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "23505") return true;
  }
  return false;
}

/** Adds keywords to a list (creating it when `newName` is given). Duplicates are skipped. */
export async function addToList(raw: AddToListInput): Promise<{ listId: number; added: number; name: string } | ActionRefusal> {
  await requireSession();
  const input = addInput.parse(raw);
  const { project, scope } = await requireProject();
  const locked = await lockedRefusal(scope);
  if (locked) return locked;
  checkMarket(input.market, project);
  let list: { id: number; name: string } | undefined;
  if (input.newName) {
    [list] = await db
      .insert(keywordsLists)
      .values({ ...scope, name: input.newName })
      .onConflictDoUpdate({ target: [keywordsLists.projectId, keywordsLists.name], set: { updatedAt: new Date() } })
      .returning({ id: keywordsLists.id, name: keywordsLists.name });
  } else if (input.listId) {
    [list] = await db
      .select({ id: keywordsLists.id, name: keywordsLists.name })
      .from(keywordsLists)
      .where(listWhere(scope, input.listId));
  }
  if (!list) throw new Error("Pick a list or name a new one.");

  const inserted = await db
    .insert(keywordsListItems)
    .values(
      input.items.map((i) => ({
        workspaceId: scope.workspaceId,
        listId: list.id,
        keyword: i.keyword.toLowerCase(),
        locationCode: input.market.locationCode,
        languageCode: input.market.languageCode,
        volume: i.volume ?? null,
        kd: i.kd == null ? null : Math.round(i.kd),
        cpc: i.cpc ?? null,
        competition: i.competition ?? null,
        intent: i.intent ?? null,
        source: input.source ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: keywordsListItems.id });
  await db.update(keywordsLists).set({ updatedAt: new Date() }).where(listWhere(scope, list.id));
  refresh();
  return { listId: list.id, added: inserted.length, name: list.name };
}

export async function createList(formData: FormData): Promise<ActionResult> {
  await requireSession();
  const name = nameInput.safeParse(formData.get("name"));
  if (!name.success) return { error: "Name the list (up to 80 characters)." };
  const { scope } = await requireProject();
  const locked = await lockedRefusal(scope);
  if (locked) return locked;
  const [list] = await db
    .insert(keywordsLists)
    .values({ ...scope, name: name.data })
    .onConflictDoUpdate({ target: [keywordsLists.projectId, keywordsLists.name], set: { updatedAt: new Date() } })
    .returning({ id: keywordsLists.id });
  redirect(`/keywords/lists/${list.id}`);
}

export type RenameState = { error: string | null };

/** Form action (with useActionState): renames a list, reporting a duplicate name instead of throwing. */
export async function renameList(listId: number, _prev: RenameState, formData: FormData): Promise<RenameState> {
  await requireSession();
  const id = listIdInput.parse(listId);
  const parsed = nameInput.safeParse(formData.get("name"));
  if (!parsed.success) return { error: "Name the list (up to 80 characters)." };
  const { scope } = await requireProject();
  const locked = await lockedRefusal(scope);
  if (locked) return { error: locked.error };
  try {
    await db
      .update(keywordsLists)
      .set({ name: parsed.data, updatedAt: new Date() })
      .where(listWhere(scope, id));
  } catch (e) {
    if (isUniqueViolation(e)) return { error: `A list named “${parsed.data}” already exists.` };
    throw e;
  }
  refresh();
  return { error: null };
}

export async function deleteList(listId: number): Promise<ActionResult> {
  await requireSession();
  const id = listIdInput.parse(listId);
  const { scope } = await requireProject();
  const locked = await lockedRefusal(scope);
  if (locked) return locked;
  await db.delete(keywordsLists).where(listWhere(scope, id));
  redirect("/keywords/lists");
}

export async function removeFromList(listId: number, keywords: string[]): Promise<ActionResult> {
  await requireSession();
  const id = listIdInput.parse(listId);
  const words = keywordsInput.parse(keywords);
  const { scope } = await requireProject();
  const locked = await lockedRefusal(scope);
  if (locked) return locked;
  const [list] = await db.select({ id: keywordsLists.id }).from(keywordsLists).where(listWhere(scope, id));
  if (!list || !words.length) return;
  await db
    .delete(keywordsListItems)
    .where(and(eq(keywordsListItems.workspaceId, scope.workspaceId), eq(keywordsListItems.listId, id), inArray(keywordsListItems.keyword, words)));
  await db.update(keywordsLists).set({ updatedAt: new Date() }).where(listWhere(scope, id));
  refresh();
}
