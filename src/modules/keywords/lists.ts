import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { keywordsListItems, keywordsLists } from "@/db/schema";
import type { ProjectScope } from "@/lib/workspace";

export type KeywordList = typeof keywordsLists.$inferSelect;
export type KeywordListItem = typeof keywordsListItems.$inferSelect;

export interface ListSummary {
  [key: string]: unknown;
  id: number;
  name: string;
  keywords: number;
  volume: number;
  avgKd: number | null;
  updatedAt: string;
}

const inScope = (s: ProjectScope) => and(eq(keywordsLists.workspaceId, s.workspaceId), eq(keywordsLists.projectId, s.projectId));

export async function listOptions(scope: ProjectScope): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: keywordsLists.id, name: keywordsLists.name })
    .from(keywordsLists)
    .where(inScope(scope))
    .orderBy(asc(keywordsLists.name));
}

export async function listSummaries(scope: ProjectScope): Promise<ListSummary[]> {
  const rows = await db
    .select({
      id: keywordsLists.id,
      name: keywordsLists.name,
      updatedAt: keywordsLists.updatedAt,
      keywords: sql<number>`count(${keywordsListItems.id})::int`,
      volume: sql<number>`coalesce(sum(${keywordsListItems.volume}), 0)::int`,
      avgKd: sql<number | null>`round(avg(${keywordsListItems.kd}))::int`,
    })
    .from(keywordsLists)
    .leftJoin(keywordsListItems, and(eq(keywordsListItems.listId, keywordsLists.id), eq(keywordsListItems.workspaceId, keywordsLists.workspaceId)))
    .where(inScope(scope))
    .groupBy(keywordsLists.id)
    .orderBy(desc(keywordsLists.updatedAt));
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

export async function getList(scope: ProjectScope, id: number): Promise<KeywordList | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select()
    .from(keywordsLists)
    .where(and(eq(keywordsLists.id, id), inScope(scope)));
  return row ?? null;
}

/** Items of a list from `getList`, which checked the list belongs to the scope. */
export async function listItems(list: Pick<KeywordList, "id" | "workspaceId">): Promise<KeywordListItem[]> {
  return db
    .select()
    .from(keywordsListItems)
    .where(and(eq(keywordsListItems.workspaceId, list.workspaceId), eq(keywordsListItems.listId, list.id)))
    .orderBy(desc(keywordsListItems.volume));
}
