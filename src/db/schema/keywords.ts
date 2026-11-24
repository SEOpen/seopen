import { index, integer, pgTable, real, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { parentScoped, projectScoped, workspaceId } from "./core";

/** Named keyword lists per project, filled from the research tools. */
export const keywordsLists = pgTable(
  "keywords_lists",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.projectId, t.name),
    ...projectScoped("keywords_lists", t),
    // Target of the items' (workspace_id, list_id) foreign key.
    unique("keywords_lists_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** A keyword in a list, with the metrics it had when it was added (so the list view costs nothing). */
export const keywordsListItems = pgTable(
  "keywords_list_items",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    listId: integer().notNull(),
    keyword: text().notNull(),
    locationCode: integer().notNull(),
    languageCode: text().notNull(),
    volume: integer(),
    kd: integer(),
    cpc: real(),
    competition: real(),
    intent: text(),
    /** Where it was added from, e.g. "ideas:suggestions" or "domain:example.com". */
    source: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.listId, t.keyword),
    index().on(t.listId, t.createdAt),
    ...parentScoped("keywords_list_items", [t.workspaceId, t.listId], [keywordsLists.workspaceId, keywordsLists.id]),
  ],
);
