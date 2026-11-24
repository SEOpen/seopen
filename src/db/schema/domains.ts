import { date, index, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/**
 * One row per project per day an overview of the project's own domain was fetched fresh
 * from DataForSEO. The dashboard card reads these, so it never pays for data.
 */
export const domainsSnapshots = pgTable(
  "domains_snapshots",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    domain: text().notNull(),
    locationCode: integer().notNull(),
    languageCode: text().notNull(),
    date: date({ mode: "string" }).notNull(),
    keywords: integer().notNull(),
    traffic: integer().notNull(),
    trafficValue: real().notNull(),
    top3: integer().notNull(),
    top10: integer().notNull(),
    /** Keywords per position band, e.g. [{ label: "1–3", count: 2 }]. */
    distribution: jsonb().$type<{ label: string; count: number }[]>().notNull(),
    /** Keyword movement since the provider's previous update. */
    changes: jsonb().$type<{ new: number; up: number; down: number; lost: number }>().notNull(),
    /** Monthly history ({ date: "2026-10", traffic, keywords, top10 }), when it was loaded. */
    history: jsonb().$type<{ date: string; traffic: number; keywords: number; top10: number }[]>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.date), index().on(t.projectId, t.createdAt), ...projectScoped("domains_snapshots", t)],
);

export interface TeardownFinding {
  title: string;
  body: string;
}

export interface TeardownMove {
  title: string;
  why: string;
  /** How big the work is. */
  size: "page" | "template" | "project";
  firstStep: string;
}

/**
 * A competitor teardown an agent saved with the MCP tool `save_teardown` (the plugin's
 * seopen-teardown skill), shown on Domains → Teardowns. Plain text only: much of it was read off
 * other sites, so it's rendered as text, never as HTML or Markdown. The numbers behind it stay in
 * the research cache, where the Domains and Backlinks pages read them.
 */
export const domainsTeardowns = pgTable(
  "domains_teardowns",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** The site taken apart, such as example.com. */
    domain: text().notNull(),
    locationCode: integer().notNull(),
    languageCode: text().notNull(),
    summary: text().notNull(),
    findings: jsonb().$type<TeardownFinding[]>().notNull(),
    moves: jsonb().$type<TeardownMove[]>().notNull(),
    /** Research credits the agent spent on it, as it reported them. */
    creditsSpent: integer().notNull().default(0),
    /** Who saved it: the API key's or connected app's name. */
    savedBy: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId, t.createdAt), ...projectScoped("domains_teardowns", t)],
);
