// Owned by the fixes module.
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/** A page's Search Console numbers over one window. */
export interface FixMetrics {
  clicks: number;
  impressions: number;
  /** Impression-weighted average position; null with no impressions. */
  position: number | null;
}

/** What a page or the whole site did over the same days before and after a fix went live. */
export interface FixResult {
  days: number;
  before: { from: string; to: string } & FixMetrics;
  after: { from: string; to: string } & FixMetrics;
  site: { before: FixMetrics; after: FixMetrics };
  computedAt: string;
}

/** What SEOpen saw when it fetched the live page. */
export interface FixLiveCheck {
  state: "fixed" | "still_there" | "page_broken" | "cannot_check";
  saw: string;
  checkedAt: string;
  status: number | null;
}

/** What the page said just before the fix, so a later check can tell whether it changed. */
export interface FixSnapshot {
  title: string | null;
  description: string | null;
  words: number | null;
  /** The first H1's text. Missing on snapshots taken before logged changes existed. */
  h1?: string | null;
  from: "live" | "crawl" | null;
}

/**
 * One thing to fix on one page, from a site audit or Search Console. The plain-English wording, the
 * proposed change and the likely files aren't stored: `catalog.ts` builds them when read, so copy
 * changes reach old records too. `status`:
 *   open       found, nobody has acted on it
 *   applied    an agent or person changed the code; it may not be deployed yet
 *   live       the change is on the live page (`liveAt`), and results are being measured
 *   measured   the 28-day result is in
 *   resolved   it went away without being applied here
 *   dismissed  someone decided not to fix it; syncs leave it alone
 */
export const fixes = pgTable(
  "fixes",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** "audit", "search_console", or "manual" for a change logged without a finding (`MANUAL_CODE`). */
    source: text().notNull(),
    /** An audit issue code from `modules/audit/taxonomy.ts`, or a `gsc-` or manual code from `modules/fixes/catalog.ts`. */
    code: text().notNull(),
    url: text().notNull(),
    status: text().notNull().default("open"),
    /** The check's own value, e.g. "Title is 74 characters". For a logged change, what changed. */
    detail: text(),
    /** The Search Console numbers behind a `gsc-` finding. For a logged change, `expect`: text the live page should contain. */
    evidence: jsonb().$type<Record<string, unknown>>(),
    /** The page's impressions over the last 28 days, for ordering by what matters. */
    pageImpressions: integer().notNull().default(0),
    lastSeenCrawlId: integer(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp({ withTimezone: true }),
    /** Where the change was made: "mcp" or "app". */
    appliedVia: text(),
    appliedCommit: text(),
    appliedNote: text(),
    appliedFiles: jsonb().$type<string[]>(),
    before: jsonb().$type<FixSnapshot>(),
    liveAt: timestamp({ withTimezone: true }),
    liveCheck: jsonb().$type<FixLiveCheck>(),
    /** When Google last crawled the page, once that's after the fix went live. */
    recrawledAt: timestamp({ withTimezone: true }),
    /** When the daily job last asked Search Console about the page, a failed ask included, so pages take turns. */
    inspectedAt: timestamp({ withTimezone: true }),
    /** Keyed by days after going live: 7, 14 and 28. */
    results: jsonb().$type<Record<string, FixResult>>(),
    resolvedAt: timestamp({ withTimezone: true }),
    dismissedAt: timestamp({ withTimezone: true }),
    dismissedReason: text(),
    /** A later crawl found it again after it went live. */
    reopenedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fixes_one_per_finding").on(t.projectId, t.source, t.code, t.url),
    index().on(t.projectId, t.status, t.pageImpressions),
    // The daily job's work: fixes waiting on a live check, a recrawl or a result.
    index("fixes_in_progress").on(t.status).where(sql`status in ('applied', 'live')`),
    ...projectScoped("fixes", t),
  ],
);
