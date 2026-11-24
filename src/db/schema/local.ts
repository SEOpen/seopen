// Owned by the local module (Local SEO: a geo-grid Google Maps rank tracker). See docs/conventions.md.
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { parentScoped, projectScoped, workspaceId } from "./core";

/**
 * A business listing tracked on Google Maps. It was picked from a Maps search, and ranks are
 * matched on its cid or place_id, never on its name.
 */
export const localBusinesses = pgTable(
  "local_businesses",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** What the user searched for, e.g. "Beta Web Design" in "Salem, NH". */
    query: text().notNull(),
    city: text().notNull(),
    /** The listing as Google Maps shows it. */
    title: text().notNull(),
    address: text(),
    category: text(),
    domain: text(),
    phone: text(),
    rating: real(),
    votes: integer(),
    /** Google's ids for the listing. At least one is set; matching prefers cid. */
    cid: text(),
    placeId: text(),
    lat: doublePrecision().notNull(),
    lng: doublePrecision().notNull(),
    /** Points per side: 3, 5 or 7. */
    gridSize: smallint().notNull().default(5),
    /** Distance from the listing to the edge of the grid, in miles: 1, 3, 5 or 10. */
    radiusMiles: smallint().notNull().default(5),
    /** Off pauses the weekly check; "Check now" still works. */
    scheduled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.projectId, t.createdAt),
    ...projectScoped("local_businesses", t),
    // Target of the keywords' and checks' (workspace_id, business_id) foreign keys.
    unique("local_businesses_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** Keywords searched at every grid point for one business. Trimmed, lowercased and unique. */
export const localKeywords = pgTable(
  "local_keywords",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    businessId: integer().notNull(),
    keyword: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.businessId, t.keyword),
    ...parentScoped("local_keywords", [t.workspaceId, t.businessId], [localBusinesses.workspaceId, localBusinesses.id]),
  ],
);

/** Partial unique index: at most one check in flight per business (double clicks, schedule vs "Check now"). */
export const ONE_ACTIVE_CHECK_INDEX = "local_checks_one_active_per_business";

/**
 * One check of a business: every keyword at every grid point. The grid is copied from the
 * business at the time, so history stays readable after the grid changes. Every check is kept.
 */
export const localChecks = pgTable(
  "local_checks",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    businessId: integer().notNull(),
    kind: text({ enum: ["scheduled", "manual"] }).notNull(),
    gridSize: smallint().notNull(),
    radiusMiles: smallint().notNull(),
    /** Google Maps zoom sent with every point, chosen from the radius. */
    zoom: smallint().notNull(),
    lat: doublePrecision().notNull(),
    lng: doublePrecision().notNull(),
    status: text({ enum: ["posting", "pending", "done", "failed"] }).notNull().default("posting"),
    tasksTotal: integer().notNull().default(0),
    tasksDone: integer().notNull().default(0),
    tasksFailed: integer().notNull().default(0),
    /** Sum of task_post costs DataForSEO reported. */
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.businessId, t.createdAt),
    index().on(t.status),
    uniqueIndex(ONE_ACTIVE_CHECK_INDEX)
      .on(t.businessId)
      .where(sql`${t.status} in ('posting', 'pending')`),
    ...projectScoped("local_checks", t),
    ...parentScoped("local_checks_business", [t.workspaceId, t.businessId], [localBusinesses.workspaceId, localBusinesses.id]),
    unique("local_checks_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** A listing Google Maps returned at a point, kept compact for the point panel and competitors. */
export interface LocalListing {
  /** Position among the Maps results (rank_group). */
  r: number;
  t: string;
  cid: string | null;
  pid: string | null;
  cat: string | null;
  addr: string | null;
  d: string | null;
  rating: number | null;
  votes: number | null;
}

/**
 * One grid point for one keyword in one check: the Standard-queue task and its result.
 * `failed` means DataForSEO answered with an error or no listings at all, which says nothing about
 * our rank. `done` with a null rank means Maps listed businesses there and ours wasn't among them.
 */
export const localPoints = pgTable(
  "local_points",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    checkId: integer().notNull(),
    keywordId: integer()
      .notNull()
      .references(() => localKeywords.id, { onDelete: "cascade" }),
    /** Grid position, 0-based from the north-west corner. */
    row: smallint().notNull(),
    col: smallint().notNull(),
    lat: doublePrecision().notNull(),
    lng: doublePrecision().notNull(),
    /** DataForSEO task id, set once posted. */
    taskId: text(),
    status: text({ enum: ["pending", "done", "failed"] }).notNull().default("pending"),
    /** Our listing's position at this point, null when it isn't in the results (or the point failed). */
    rank: smallint(),
    /** Up to 20 listings Maps returned here. */
    items: jsonb().$type<LocalListing[]>().notNull().default([]),
    error: text(),
    postedAt: timestamp({ withTimezone: true }),
    fetchedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.checkId, t.keywordId, t.row, t.col),
    uniqueIndex().on(t.taskId),
    index().on(t.status, t.postedAt),
    // Deleting a keyword cascades here; without this every delete scans all points.
    index().on(t.keywordId),
    ...parentScoped("local_points", [t.workspaceId, t.checkId], [localChecks.workspaceId, localChecks.id]),
  ],
);
