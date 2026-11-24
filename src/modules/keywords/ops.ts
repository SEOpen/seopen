import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema/core";
import { keywordsListItems, keywordsLists } from "@/db/schema";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { OpError, plural, refused, type OpOptions } from "@/lib/ops";
import type { ProjectScope } from "@/lib/workspace";

/**
 * Saving keywords to a project's list, for the MCP server (see `src/lib/ops`). The app's own button
 * is `addToList` in `actions.ts`, which reads the session; this takes a scope instead. Lists have no
 * plan limit and nothing here spends: the metrics are the ones the agent already looked up.
 */

export const MAX_KEYWORDS_PER_SAVE = 500;
export const MAX_LIST_NAME = 80;

export interface SaveKeywordItem {
  keyword: string;
  volume?: number | null;
  kd?: number | null;
  cpc?: number | null;
  intent?: string | null;
}

export interface SaveKeywordsInput {
  list: string;
  items: SaveKeywordItem[];
  /** Where they came from, such as "teardown:example.com". */
  source?: string;
  /** The market they were researched in; the project's own when left out. */
  market?: { locationCode: number; languageCode: string };
}

export interface SavedKeywords {
  dryRun: boolean;
  listId: number | null;
  list: string;
  newList: boolean;
  added: number;
  already: number;
  /** Entries, as given, that repeat another in other case or spacing: saved once. */
  repeated: string[];
  message: string;
}

const clean = (k: string) => k.trim().replace(/\s+/g, " ").toLowerCase();

export async function saveKeywordsOp(scope: ProjectScope, input: SaveKeywordsInput, opts: OpOptions = {}): Promise<SavedKeywords> {
  const refusal = await projectActionRefusal(scope);
  if (refusal) throw refused(refusal);
  const name = input.list.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_LIST_NAME) throw new OpError(`Name the list in 1 to ${MAX_LIST_NAME} characters.`);

  // One row per keyword: the first time it appears wins.
  const byKeyword = new Map<string, SaveKeywordItem>();
  const repeated: string[] = [];
  for (const item of input.items) {
    const keyword = clean(item.keyword);
    if (!keyword || keyword.length > 700) continue;
    if (byKeyword.has(keyword)) repeated.push(item.keyword.trim());
    else byKeyword.set(keyword, { ...item, keyword });
  }
  const dupes = repeated.length ? `${plural(repeated.length, "duplicate")} in other case or spacing saved once: ${repeated.map((r) => `“${r}”`).join(", ")}` : null;
  if (!byKeyword.size) throw new OpError("Give at least one keyword.");
  if (byKeyword.size > MAX_KEYWORDS_PER_SAVE) throw new OpError(`Save at most ${MAX_KEYWORDS_PER_SAVE} keywords at a time.`);

  const [project] = await db
    .select({ locationCode: projects.locationCode, languageCode: projects.languageCode })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) throw new OpError("That project wasn't found.");
  const market = input.market ?? project;

  const inScope = and(eq(keywordsLists.workspaceId, scope.workspaceId), eq(keywordsLists.projectId, scope.projectId), eq(keywordsLists.name, name));
  const [existing] = await db.select({ id: keywordsLists.id }).from(keywordsLists).where(inScope);
  const have = existing
    ? new Set(
        (
          await db
            .select({ keyword: keywordsListItems.keyword })
            .from(keywordsListItems)
            .where(and(eq(keywordsListItems.workspaceId, scope.workspaceId), eq(keywordsListItems.listId, existing.id), inArray(keywordsListItems.keyword, [...byKeyword.keys()])))
        ).map((r) => r.keyword),
      )
    : new Set<string>();
  const fresh = [...byKeyword.values()].filter((i) => !have.has(i.keyword));

  if (opts.dryRun) {
    const parts = [`Would add ${plural(fresh.length, "keyword")} to ${existing ? "" : "a new list "}“${name}”`];
    if (have.size) parts.push(`${have.size} already there`);
    if (dupes) parts.push(dupes);
    return { dryRun: true, listId: existing?.id ?? null, list: name, newList: !existing, added: fresh.length, already: have.size, repeated, message: `${parts.join(" · ")}.` };
  }

  const [list] = await db
    .insert(keywordsLists)
    .values({ ...scope, name })
    .onConflictDoUpdate({ target: [keywordsLists.projectId, keywordsLists.name], set: { updatedAt: new Date() } })
    .returning({ id: keywordsLists.id });
  const inserted = fresh.length
    ? await db
        .insert(keywordsListItems)
        .values(
          fresh.map((i) => ({
            workspaceId: scope.workspaceId,
            listId: list.id,
            keyword: i.keyword,
            locationCode: market.locationCode,
            languageCode: market.languageCode,
            volume: i.volume ?? null,
            kd: i.kd == null ? null : Math.round(i.kd),
            cpc: i.cpc ?? null,
            intent: i.intent ?? null,
            source: input.source?.slice(0, 200) ?? "mcp",
          })),
        )
        .onConflictDoNothing()
        .returning({ id: keywordsListItems.id })
    : [];
  const already = byKeyword.size - inserted.length;
  const parts = [`Added ${plural(inserted.length, "keyword")} to “${name}”`];
  if (already) parts.push(`${already} already there`);
  if (dupes) parts.push(dupes);
  return { dryRun: false, listId: list.id, list: name, newList: !existing, added: inserted.length, already, repeated, message: `${parts.join(" · ")}.` };
}
