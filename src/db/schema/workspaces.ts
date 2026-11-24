// Tenancy: workspaces own every tenant row.
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * The tenant. Every tenant-owned table carries `workspace_id`; users reach data only through
 * `workspace_members`. The owner's workspace (id 1) was created by migration 0004 and holds all
 * data from before tenancy.
 */
export const workspaces = pgTable("workspaces", {
  id: serial().primaryKey(),
  name: text().notNull(),
  /**
   * "internal" (the owner's, no Stripe, limits set by hand), "free" (no live subscription, the
   * default), "trial", "starter" or "pro". Set only by the Stripe webhook and by an admin's grant
   * (src/lib/billing/grants.ts), except "internal". An unknown value reads as "none", which fails
   * closed. Read through src/lib/billing/gates.ts.
   */
  plan: text().notNull().default("free"),
  /** "active" or "suspended". A suspended workspace's jobs and paid calls stop. */
  status: text().notNull().default("active"),
  stripeCustomerId: text(),
  /** The subscription the plan comes from, and what Stripe last said about it. */
  stripeSubscriptionId: text(),
  subscriptionStatus: text(),
  stripePriceId: text(),
  trialEndsAt: timestamp({ withTimezone: true }),
  currentPeriodEnd: timestamp({ withTimezone: true }),
  cancelAt: timestamp({ withTimezone: true }),
  /** Why the last charge or Upgrade now failed, shown on the billing page until a payment succeeds. */
  billingError: text(),
  /**
   * Set when a trial matched an earlier trial's card, email, Google account, site or property: the
   * trial is ended at once, and paid calls wait until the first invoice is paid.
   */
  trialBlockedReason: text(),
  /**
   * An admin gave this workspace its plan for free, with no Stripe subscription. Set means granted;
   * `grantEndsAt` is when it falls back to Free, null for lifetime. A real subscription replaces it.
   */
  grantedAt: timestamp({ withTimezone: true }),
  grantEndsAt: timestamp({ withTimezone: true }),
  /** The admin's user id. Plain text, so an admin's account can go without touching this row. */
  grantedBy: text(),
  /** The internal plan's limits, set by hand. Keys of PlanLimits; missing keys are unlimited. */
  limits: jsonb().$type<Record<string, number>>(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Who belongs to a workspace: Better Auth users (text ids). Deleting a user drops their memberships. */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: integer()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "owner" for now; teammates come later. */
    role: text().notNull().default("owner"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId)],
);

/** A workspace's own settings. A missing row means the defaults below. */
export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: integer()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Monthly DataForSEO spend cap for this workspace. Null uses DATAFORSEO_MONTHLY_CAP_USD. */
  monthlyCapUsd: numeric({ precision: 12, scale: 2, mode: "number" }),
  /** IANA time zone every date and time in the app renders in. Jobs run on one clock for everyone: SCHEDULE_TIME_ZONE. */
  timeZone: text().notNull().default("America/New_York"),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Weekly recaps sent (src/lib/recap): one row per person, workspace and week, claimed before the
 * send and given back if it fails, so a retried job never sends one twice.
 */
export const recapSends = pgTable(
  "recap_sends",
  {
    workspaceId: integer()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Monday of the week the recap is for, on the schedule's calendar. */
    week: date({ mode: "string" }).notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.week] }), index().on(t.userId)],
);
