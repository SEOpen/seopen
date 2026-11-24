// Billing: usage meters, trial claims, Stripe events and paused jobs.
import { boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";
import { workspaces } from "./workspaces";

const usd = () => numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0);

/**
 * One row per workspace per calendar month: what its paid DataForSEO calls have reserved and spent.
 * A paid call first reserves its estimate with one conditional UPDATE (`spent + reserved + est <=
 * ceiling`), so two calls at once can't both pass the ceiling, then settles the real cost
 * (src/lib/billing/usage.ts). `spent_usd` is what the workspace was charged (the ledger's
 * `charged_usd`), `research_usd` the part of it that counts as research credits.
 */
export const workspaceUsage = pgTable(
  "workspace_usage",
  {
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** First day of the month (UTC). */
    month: date().notNull(),
    reservedUsd: usd(),
    spentUsd: usd(),
    researchUsd: usd(),
    /** Reservations of research calls still in flight, so concurrent calls can't pass the credits either. */
    researchReservedUsd: usd(),
    /** When this month's limit-reached email was claimed (src/lib/billing/limit-email.ts). */
    limitEmailAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.month] })],
);

/**
 * One row per reservation in flight, made in the same transaction as the reservation on
 * `workspace_usage` and deleted when it settles. A row left over an hour old was leaked by a crash,
 * so the daily cleanup subtracts it from its workspace's meter even when other calls keep that row
 * busy (src/lib/billing/usage.ts, `releaseStaleReservations`).
 */
export const spendReservations = pgTable(
  "spend_reservations",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** The `workspace_usage` month it was reserved against. */
    month: date().notNull(),
    estimateUsd: usd(),
    research: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.createdAt)],
);

/** The platform backstop's meter: what DataForSEO billed this month across every workspace. */
export const platformUsage = pgTable("platform_usage", {
  month: date().primaryKey(),
  reservedUsd: usd(),
  spentUsd: usd(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * One trial per card, email, Google account, site and Search Console or GA4 property, ever. Values
 * are stored only as one-way hashes, and rows outlive the workspace (no foreign key), so deleting a
 * workspace and signing up again doesn't give a second trial. `workspace_id` is the trial that
 * claimed it first.
 */
export const trialClaims = pgTable(
  "trial_claims",
  {
    id: serial().primaryKey(),
    /** "card", "email", "google", "domain", "gsc" or "ga4". */
    kind: text().notNull(),
    hash: text().notNull(),
    workspaceId: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.kind, t.hash), index().on(t.workspaceId)],
);

/**
 * One Free account per inbox (src/lib/signup.ts). A self sign-up claims its normalized email when
 * it's verified, stored only as a one-way hash. Like trial claims the row has no foreign key, so it
 * outlives the account: `released_at` is when the account was deleted, and the inbox can sign up
 * again a while after that. Invited and admin-made accounts claim nothing.
 */
export const signupClaims = pgTable("signup_claims", {
  hash: text().primaryKey(),
  /** The account holding the inbox. Plain text, so deleting the account leaves the row. */
  userId: text().notNull(),
  claimedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp({ withTimezone: true }),
});

/**
 * One Free workspace per site (src/lib/billing/site-claims.ts). A Free workspace's editable
 * project claims its site's registrable domain, stored only as a keyed hash (HMAC under a key
 * derived from SEOPEN_SECRET_KEY), so a guess can't be confirmed without the server's key. Unlike
 * trial claims a row is released: moving to a paid plan, archiving or deleting the project, or
 * deleting the workspace (the foreign key) drops it, so a site is never locked for good.
 */
export const freeSiteClaims = pgTable(
  "free_site_claims",
  {
    hash: text().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    claimedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The holder proved it owns the site in Search Console, so a workspace that hasn't can't take it over. */
    verified: boolean().notNull().default(false),
  },
  (t) => [index().on(t.workspaceId)],
);

/** Every Stripe webhook event applied, so a redelivery changes nothing. */
export const stripeEvents = pgTable("stripe_events", {
  id: text().primaryKey(),
  type: text().notNull(),
  processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * A scheduled job that stopped because the workspace hit a limit, with the payload to run again.
 * The app shows a banner while a row exists; an upgrade (or the job passing its checks again)
 * removes it, and an upgrade re-queues the payload.
 */
export const workspaceJobPauses = pgTable(
  "workspace_job_pauses",
  {
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: integer().notNull(),
    /** Queue name, e.g. "rank.schedule". */
    job: text().notNull(),
    payload: jsonb().notNull(),
    /** A SpendRefusal code: "ceiling", "credits", "platform", "trial_audit", "no_plan"... */
    reason: text().notNull(),
    message: text().notNull(),
    pausedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.projectId, t.job] }), ...projectScoped("workspace_job_pauses", t)],
);
