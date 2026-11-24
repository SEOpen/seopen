// Owned by the google module. See docs/conventions.md and docs/google.md.
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";
import { workspaces } from "./workspaces";

/**
 * A workspace's Google connection: at most one per workspace. The same Google account may be
 * connected to two workspaces (an agency and its client), so `google_sub` isn't unique on its own.
 */
export const googleAccounts = pgTable(
  "google_accounts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text().notNull(),
    googleSub: text().notNull(),
    /** Refresh token, AES-256-GCM via src/lib/crypto.ts. Never log or render it. */
    refreshTokenEnc: text().notNull(),
    scopes: text().array().notNull(),
    /** "active" or "reauth_required" (refresh failed with invalid_grant). */
    status: text().notNull().default("active"),
    /** Set when the user picked time-based access at consent; the token dies at this time. */
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastRefreshAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [uniqueIndex("google_accounts_workspace_id_key").on(t.workspaceId)],
);

/** Sync progress per project and source ("gsc" | "ga4"), shown on the pages. */
export const googleSyncState = pgTable(
  "google_sync_state",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    source: text().notNull(),
    /** Property the state belongs to; a mapping change resets the backfill. */
    property: text().notNull(),
    /** "idle" | "queued" | "running" | "ok" | "error" | "quota" | "reauth" */
    status: text().notNull().default("idle"),
    message: text(),
    lastRunAt: timestamp({ withTimezone: true }),
    lastSuccessAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** Newest final date stored. */
    latestDate: date({ mode: "string" }),
    /** Oldest date the backfill aims for (16 months back). */
    backfillStart: date({ mode: "string" }),
    /** Next date the backfill fetches, moving forward oldest-first. Null once done. */
    backfillCursor: date({ mode: "string" }),
    backfillDone: boolean().notNull().default(false),
    quotaFailures: integer().notNull().default(0),
    rowsWritten: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.source] }), ...projectScoped("google_sync_state", t)],
);

const metrics = {
  clicks: integer().notNull(),
  impressions: integer().notNull(),
  ctr: doublePrecision().notNull(),
  position: doublePrecision().notNull(),
};

/** Exact site totals per day (dimensions: date only). Never sum query or page rows for totals. */
export const gscDaily = pgTable(
  "gsc_daily",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    ...metrics,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.date] }), ...projectScoped("gsc_daily", t)],
);

/** Per-day breakdowns: kind "country" (ISO alpha-3) or "device" (DESKTOP, MOBILE, TABLET). */
export const gscBreakdown = pgTable(
  "gsc_breakdown",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    kind: text().notNull(),
    key: text().notNull(),
    ...metrics,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.kind, t.date, t.key] }), ...projectScoped("gsc_breakdown", t)],
);

export const gscPages = pgTable(
  "gsc_pages",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    page: text().notNull(),
    ...metrics,
  },
  (t) => [uniqueIndex().on(t.projectId, t.date, t.page), index().on(t.projectId, t.page), ...projectScoped("gsc_pages", t)],
);

export const gscQueries = pgTable(
  "gsc_queries",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    query: text().notNull(),
    ...metrics,
  },
  (t) => [uniqueIndex().on(t.projectId, t.date, t.query), index().on(t.projectId, t.query), ...projectScoped("gsc_queries", t)],
);

/** Query-to-page mapping; the most expensive dataset (capped by GSC at 50k rows a day). */
export const gscQueryPages = pgTable(
  "gsc_query_pages",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    query: text().notNull(),
    page: text().notNull(),
    ...metrics,
  },
  (t) => [
    uniqueIndex().on(t.projectId, t.date, t.query, t.page),
    index().on(t.projectId, t.query),
    index().on(t.projectId, t.page),
    ...projectScoped("gsc_query_pages", t),
  ],
);

/** One row per URL inspection run. */
export const gscUrlInspections = pgTable(
  "gsc_url_inspections",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    url: text().notNull(),
    inspectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    verdict: text(),
    coverageState: text(),
    indexingState: text(),
    robotsTxtState: text(),
    pageFetchState: text(),
    lastCrawlTime: timestamp({ withTimezone: true }),
    googleCanonical: text(),
    userCanonical: text(),
    crawledAs: text(),
    inspectionResultLink: text(),
    richResults: jsonb(),
  },
  (t) => [index().on(t.projectId, t.inspectedAt), ...projectScoped("gsc_url_inspections", t)],
);

/** GA4 organic-search sessions per landing page per day (property time zone). */
export const ga4LandingDaily = pgTable(
  "ga4_landing_daily",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    date: date({ mode: "string" }).notNull(),
    hostName: text().notNull(),
    landingPage: text().notNull(),
    sessions: integer().notNull(),
    engagedSessions: integer().notNull(),
    keyEvents: doublePrecision().notNull(),
    totalRevenue: doublePrecision().notNull(),
  },
  (t) => [
    // Also serves lookups by (project_id, date).
    uniqueIndex().on(t.projectId, t.date, t.hostName, t.landingPage),
    ...projectScoped("ga4_landing_daily", t),
  ],
);
