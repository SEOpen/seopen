// Owned by the backlinks module. See docs/conventions.md.
import { date, index, integer, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/** One backlink-summary snapshot per project domain per day, for the dashboard trend. */
export const backlinksSnapshots = pgTable(
  "backlinks_snapshots",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    target: text().notNull(),
    backlinks: integer().notNull(),
    referringDomains: integer().notNull(),
    referringMainDomains: integer(),
    /** Provider rank, 0–1000 scale. */
    rank: integer(),
    /** Provider backlinks spam score, 0–100. */
    spamScore: integer(),
    nofollowBacklinks: integer(),
    brokenBacklinks: integer(),
    /** Share of backlinks without rel=nofollow, 0–1. */
    dofollowShare: real(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.date), ...projectScoped("backlinks_snapshots", t)],
);

/** Per-project keep/disavow decision for a linking domain, used to build disavow.txt. */
export const backlinksDomainDecisions = pgTable(
  "backlinks_domain_decisions",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    domain: text().notNull(),
    /** "keep" | "disavow" */
    decision: text().notNull(),
    /** Label and reasons at the time of the decision, for the disavow comment. */
    note: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.domain), index().on(t.projectId, t.decision), ...projectScoped("backlinks_domain_decisions", t)],
);
