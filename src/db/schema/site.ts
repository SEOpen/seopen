// The marketing site: the beta waitlist.
import { index, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One row per email that asked to join the beta. Global on purpose: nobody on the list has a
 * workspace yet. `from_path` is the site page the form was on and `heard_from` the answer to "How
 * did you hear about SEOpen?", so the plan's channels (search, AI answers, communities, launches)
 * can be compared by who actually signed up. A second sign-up with the same email updates the row.
 */
export const waitlist = pgTable(
  "waitlist",
  {
    id: serial().primaryKey(),
    /** Lowercased. */
    email: text().notNull(),
    /** The site they'd use SEOpen for, as typed. */
    site: text(),
    /** One of WAITLIST_SOURCES in src/lib/waitlist.ts. */
    heardFrom: text(),
    /** Free text when heardFrom is "other". */
    heardFromOther: text(),
    fromPath: text(),
    /** Hostname of the page that sent them to the site, and utm_source or ref from the URL. */
    referrer: text(),
    utmSource: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    invitedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("waitlist_email_key").on(t.email)],
);

/**
 * One row per request to a free tool (src/modules/tools), so per-IP and site-wide limits hold
 * across every server instance, and tool use can be compared with waitlist sign-ups. The IP is
 * stored only as a keyed hash. `status` starts as "running" and ends as "ok", "cached", "error",
 * or "refused" (budget); a request turned away by a rate limit gets "limited". The waitlist form
 * logs each accepted sign-up here too (`tool` "waitlist", empty `input`, status "ok") for its own
 * per-IP limit (src/app/actions/waitlist.ts); the tools' limits leave those rows out. The daily
 * tools.purge job deletes rows after 31 days, and the paid tools' expired api_cache rows
 * (`purgePublicToolRows` in src/modules/tools/limits.ts).
 */
export const publicToolUses = pgTable(
  "public_tool_uses",
  {
    id: serial().primaryKey(),
    tool: text().notNull(),
    ipHash: text().notNull(),
    /** The normalised input, e.g. "example.com" or "best crm|2840". */
    input: text().notNull(),
    status: text().notNull().default("running"),
    /** What DataForSEO charged for this request (0 for cached results and the fetch-only tools). */
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.tool, t.createdAt), index().on(t.ipHash, t.createdAt)],
);

/** A free tool's finished result for one normalised input, reused until it expires and deleted by the next daily purge. */
export const publicToolResults = pgTable("public_tool_results", {
  /** `<tool>:<sha256 of the normalised input>`. */
  key: text().primaryKey(),
  tool: text().notNull(),
  result: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
