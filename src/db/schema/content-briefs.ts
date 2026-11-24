import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/**
 * A saved content brief (Keyword research → Briefs): what a page for one keyword should cover,
 * built from the research lookups, the project's Search Console data and its latest site audit.
 * Never article text. Not the dashboard summaries in the modules' `brief.ts` files.
 *
 * `brief` is the snapshot made when it was created (`ContentBrief` in
 * `src/modules/content-briefs/types.ts`), with the source and date of every figure in it. `fill` is
 * what the owner has written into the fields marked "to fill" since (`BriefFill`). Both are plain
 * data read back as text; much of `brief` was read off other sites.
 */
export const contentBriefs = pgTable(
  "content_briefs",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    keyword: text().notNull(),
    /** guide | vs | alternatives | best | pricing */
    pageType: text().notNull(),
    brief: jsonb().notNull(),
    fill: jsonb().notNull().default({}),
    /** Research credits creating it spent; 0 when every lookup was already saved. */
    creditsSpent: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId, t.createdAt), ...projectScoped("content_briefs", t)],
);
