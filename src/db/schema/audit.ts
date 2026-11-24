// Owned by the audit module. See docs/conventions.md.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { parentScoped, projectScoped, workspaceId } from "./core";

/** Per-project crawl settings. One row per project, created on first save. */
export const auditSettings = pgTable(
  "audit_settings",
  {
    projectId: integer().primaryKey(),
    workspaceId: workspaceId(),
    maxPages: integer().notNull().default(500),
    enableJavascript: boolean().notNull().default(false),
    /** Fetch images, CSS and JS so broken resources can be reported. */
    loadResources: boolean().notNull().default(true),
    /** Re-crawl every Monday morning. */
    weeklyEnabled: boolean().notNull().default(false),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => projectScoped("audit_settings", t),
);

/**
 * One crawl. status: queued → posting → crawling → importing → done (or failed).
 * Totals and the health score are filled in when the import finishes.
 */
export const auditCrawls = pgTable(
  "audit_crawls",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** DataForSEO On-Page task id. */
    taskId: text(),
    status: text().notNull().default("queued"),
    trigger: text().notNull().default("manual"),
    target: text().notNull(),
    maxPages: integer().notNull(),
    enableJavascript: boolean().notNull().default(false),
    loadResources: boolean().notNull().default(true),
    estimatedCostUsd: real().notNull().default(0),
    costUsd: real(),
    pagesCrawled: integer().notNull().default(0),
    pagesInQueue: integer().notNull().default(0),
    healthScore: real(),
    errors: integer(),
    warnings: integer(),
    notices: integer(),
    /** Distinct affected URLs across all issues. */
    pagesWithIssues: integer(),
    /** Small subset of the On-Page summary: domain info, site checks, page metrics. */
    summary: jsonb(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    lastPolledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.projectId, t.createdAt),
    index().on(t.status),
    // At most one active crawl per project, so a double submit can't pay for two.
    uniqueIndex("audit_crawls_one_active_per_project")
      .on(t.projectId)
      .where(sql`status in ('queued', 'posting', 'crawling', 'importing')`),
    ...projectScoped("audit_crawls", t),
    // Target of the crawl children's (workspace_id, crawl_id) foreign keys.
    unique("audit_crawls_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** A crawl child's index and foreign key: (workspace_id, crawl_id) must name a crawl of the same workspace. */
const crawlScoped = (table: string, t: { workspaceId: AnyPgColumn; crawlId: AnyPgColumn }) =>
  parentScoped(table, [t.workspaceId, t.crawlId], [auditCrawls.workspaceId, auditCrawls.id]);

/** Crawled pages (and other crawled resources DataForSEO lists as pages, e.g. broken URLs). */
export const auditPages = pgTable(
  "audit_pages",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    url: text().notNull(),
    statusCode: integer(),
    resourceType: text(),
    title: text(),
    description: text(),
    h1: text(),
    canonical: text(),
    depth: integer(),
    wordCount: integer(),
    internalLinksOut: integer(),
    externalLinksOut: integer(),
    internalLinksIn: integer(),
    loadTimeMs: integer(),
    sizeBytes: integer(),
    onpageScore: real(),
    indexable: boolean(),
    /** Names of the provider checks that were true for this page. */
    checks: jsonb().$type<string[]>(),
    issueCount: integer().notNull().default(0),
  },
  (t) => [uniqueIndex().on(t.crawlId, t.url), index().on(t.crawlId, t.statusCode), ...crawlScoped("audit_pages", t)],
);

/** One row per (issue, affected URL) in a crawl. `code` is our own taxonomy (see modules/audit/taxonomy.ts). */
export const auditIssues = pgTable(
  "audit_issues",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    code: text().notNull(),
    url: text().notNull(),
    /** Check-specific value shown next to the URL, e.g. "Title is 74 characters" or the broken link target. */
    detail: text(),
  },
  // The unique index serves lookups by (crawl_id, code) too.
  (t) => [uniqueIndex().on(t.crawlId, t.code, t.url), ...crawlScoped("audit_issues", t)],
);

/** Broken and nofollow links copied from the crawl (all links would be too many rows to be useful). */
export const auditLinks = pgTable(
  "audit_links",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    fromUrl: text().notNull(),
    toUrl: text().notNull(),
    direction: text(),
    linkType: text(),
    dofollow: boolean(),
    isBroken: boolean(),
    anchor: text(),
  },
  (t) => crawlScoped("audit_links", t),
);

/** Resources (images, scripts, stylesheets) with problems. */
export const auditResources = pgTable(
  "audit_resources",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    url: text().notNull(),
    resourceType: text(),
    statusCode: integer(),
    sizeBytes: integer(),
    checks: jsonb().$type<string[]>(),
  },
  (t) => crawlScoped("audit_resources", t),
);

/** Groups of pages that share a title, description or near-identical content. */
export const auditDuplicates = pgTable(
  "audit_duplicates",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    kind: text().notNull(),
    value: text(),
    urls: jsonb().$type<string[]>().notNull(),
  },
  (t) => [index().on(t.crawlId, t.kind), ...crawlScoped("audit_duplicates", t)],
);

/** Pages search engines can't index, with the reason. */
export const auditNonIndexable = pgTable(
  "audit_non_indexable",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    crawlId: integer().notNull(),
    url: text().notNull(),
    reason: text(),
  },
  (t) => crawlScoped("audit_non_indexable", t),
);

/** Lighthouse runs for a project's homepage. */
export const auditLighthouse = pgTable(
  "audit_lighthouse",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    url: text().notNull(),
    status: text().notNull().default("queued"),
    forMobile: boolean().notNull().default(false),
    performance: real(),
    accessibility: real(),
    bestPractices: real(),
    seo: real(),
    /** Lab metrics in ms (CLS unitless): lcp, fcp, tbt, cls, si, tti. */
    metrics: jsonb().$type<Record<string, number | null>>(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId, t.createdAt), ...projectScoped("audit_lighthouse", t)],
);
