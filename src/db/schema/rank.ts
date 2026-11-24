// Owned by the rank module. Add this module's tables here; see docs/conventions.md.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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

/** Per-project tracker settings. A missing row means the defaults below. */
export const rankSettings = pgTable(
  "rank_settings",
  {
    projectId: integer().primaryKey(),
    workspaceId: workspaceId(),
    /** SERP depth for the daily check. Billed per 10 results. */
    dailyDepth: smallint().notNull().default(20),
    /** Depth of the weekly sweep, which also loads async AI Overviews. */
    sweepDepth: smallint().notNull().default(100),
    /** Day of the week (UTC, 0 = Sunday) the sweep replaces the daily check. */
    sweepWeekday: smallint().notNull().default(0),
    /** Off pauses the scheduled checks; "Check now" still works. */
    enabled: boolean().notNull().default(true),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => projectScoped("rank_settings", t),
);

/** Keywords tracked for a project. Location and language come from the project. */
export const rankKeywords = pgTable(
  "rank_keywords",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    keyword: text().notNull(),
    tags: text().array().notNull().default([]),
    device: text({ enum: ["desktop", "mobile"] }).notNull().default("desktop"),
    active: boolean().notNull().default(true),
    /** Monthly volume from DataForSEO Labs keyword_overview (cached 30 days). */
    searchVolume: integer(),
    cpc: real(),
    difficulty: smallint(),
    volumeUpdatedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.keyword, t.device), index().on(t.projectId, t.active), ...projectScoped("rank_keywords", t)],
);

/** Run statuses that mean "in flight". At most one run per project may be in one of these. */
export const ACTIVE_RUN_STATUSES = ["posting", "pending"] as const;
/** Partial unique index that enforces one active run per project (double clicks, scheduler vs. "Check now"). */
export const ONE_ACTIVE_RUN_INDEX = "rank_runs_one_active_per_project";

/** One batch of SERP checks: the daily check, the weekly sweep, or a manual "Check now". */
export const rankRuns = pgTable(
  "rank_runs",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    kind: text({ enum: ["daily", "sweep", "manual"] }).notNull(),
    /** UTC date the results are filed under. */
    date: date({ mode: "string" }).notNull(),
    depth: smallint().notNull(),
    /** DataForSEO location_code this run searched from, set when it posts. */
    locationCode: integer(),
    aiOverview: boolean().notNull().default(false),
    /** Who started this run. Rechecks are posted later by the worker, so their ledger rows read it from here. */
    source: text({ enum: ["app", "mcp"] }).notNull().default("app"),
    status: text({ enum: ["posting", "pending", "done", "failed"] }).notNull().default("posting"),
    tasksTotal: integer().notNull().default(0),
    tasksDone: integer().notNull().default(0),
    tasksFailed: integer().notNull().default(0),
    /** Sum of task_post costs DataForSEO reported, rechecks included. */
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    /** Extra looks posted because a keyword came back missing or far below its recent best. */
    rechecks: integer().notNull().default(0),
    /** Keywords this run could not confirm: they kept their last position (`rank_results.not_checked`). */
    notChecked: integer().notNull().default(0),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.projectId, t.createdAt),
    index().on(t.status),
    uniqueIndex(ONE_ACTIVE_RUN_INDEX)
      .on(t.projectId)
      .where(sql`${t.status} in ('posting', 'pending')`),
    ...projectScoped("rank_runs", t),
    // Target of the tasks' (workspace_id, run_id) foreign key.
    unique("rank_runs_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** One posted Standard-queue task, keyed by the DataForSEO task id. A keyword gets one per look at its SERP. */
export const rankTasks = pgTable(
  "rank_tasks",
  {
    id: text().primaryKey(),
    workspaceId: workspaceId(),
    runId: integer().notNull(),
    keywordId: integer()
      .notNull()
      .references(() => rankKeywords.id, { onDelete: "cascade" }),
    /** 1 for the run's first look at the keyword, 2 or 3 for a recheck. */
    attempt: smallint().notNull().default(1),
    status: text({ enum: ["pending", "done", "failed"] }).notNull().default("pending"),
    error: text(),
    /** What this look saw, kept only while another look of the keyword is out (see tracker.ts). */
    look: jsonb(),
    postedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.status, t.postedAt),
    uniqueIndex().on(t.runId, t.keywordId, t.attempt),
    // Deleting a keyword cascades here.
    index().on(t.keywordId),
    ...parentScoped("rank_tasks", [t.workspaceId, t.runId], [rankRuns.workspaceId, rankRuns.id]),
  ],
);

/** Best position and URL of one domain on a SERP. */
export interface RankDomainHit {
  /** Organic position (rank_group). */
  p: number;
  u: string;
}

/** A compact SERP row kept for the snapshot view. */
export interface RankSerpItem {
  type: string;
  /** rank_group for organic items, rank_absolute for features. */
  pos: number;
  abs: number;
  domain: string | null;
  url: string | null;
  title: string | null;
}

/** One keyword's check result for one UTC day. A deeper check replaces a shallower one. */
export const rankResults = pgTable(
  "rank_results",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    keywordId: integer()
      .notNull()
      .references(() => rankKeywords.id, { onDelete: "cascade" }),
    date: date({ mode: "string" }).notNull(),
    runId: integer().references(() => rankRuns.id, { onDelete: "set null" }),
    depth: smallint().notNull(),
    /**
     * DataForSEO location_code this result was searched from. Positions from different places aren't
     * compared. Null only on a row the previous deploy wrote: read it as the project's country.
     */
    locationCode: integer(),
    /** Organic position of the project domain, null when not in the checked depth. */
    position: smallint(),
    rankAbsolute: smallint(),
    url: text(),
    /** Every URL of ours on the SERP, for cannibalization. */
    ownUrls: jsonb().$type<RankDomainHit[]>().notNull().default([]),
    /** SERP feature types present (everything except "organic"). */
    serpFeatures: text().array().notNull().default([]),
    /** Feature types where our domain appears (featured snippet, AI Overview citation, …). */
    ownedFeatures: text().array().notNull().default([]),
    aiOverview: boolean().notNull().default(false),
    aiOverviewCited: boolean().notNull().default(false),
    /** Best organic hit per domain on this SERP, so competitor history needs no extra calls. */
    domains: jsonb().$type<Record<string, RankDomainHit>>().notNull().default({}),
    /** First 20 SERP items for the snapshot view. */
    top: jsonb().$type<RankSerpItem[]>().notNull().default([]),
    seResultsCount: integer(),
    /** When this row's SERP was seen. On a not-checked row, that of the earlier check it was copied from. */
    checkedAt: timestamp({ withTimezone: true }).notNull(),
    /** No look could confirm the keyword today: this row repeats its last known result. */
    notChecked: boolean().notNull().default(false),
  },
  // run_id: deleting a run sets it null here.
  (t) => [uniqueIndex().on(t.keywordId, t.date), index().on(t.projectId, t.date), index().on(t.runId), ...projectScoped("rank_results", t)],
);
