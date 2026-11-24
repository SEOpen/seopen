import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/**
 * Urgent alerts (src/modules/alerts): a clicked page that broke, a search bot newly blocked, a
 * tracked keyword out of the top 10. Found where the data already arrives (crawl import, rank check
 * close), emailed to the people who get the weekly recap, and listed on the project's Alerts page.
 */

/** A rule switched off for a project. A missing row means the rule is on, which is the default. */
export const alertRules = pgTable(
  "alert_rules",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** page-broken | bot-blocked | left-top-10 (`ALERT_RULES` in src/modules/alerts/rules.ts). */
    rule: text().notNull(),
    enabled: boolean().notNull().default(true),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.rule] }), ...projectScoped("alert_rules", t)],
);

/**
 * One alert. `key` is what it's about (a page URL, or a keyword and place), so one thing alerts once
 * while it stays broken: at most one open row per project, rule and key. `resolved_at` is set when a
 * later check finds it fixed, and a new row opens if it breaks again. `send_id` is the email it went
 * out in; null until then.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    rule: text().notNull(),
    key: text().notNull(),
    /** What broke, in words: "/pricing returns 404". */
    title: text().notNull(),
    /** What the check saw, in words. Plain data read back as text: some of it came from the site. */
    detail: text(),
    /** The check that found it: "Site audit crawl", "Rank check". */
    source: text().notNull(),
    /** The app screen it's about, a path such as /rank/12. */
    screen: text().notNull(),
    detectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    sendId: integer(),
  },
  (t) => [
    uniqueIndex("alerts_one_open_per_key")
      .on(t.projectId, t.rule, t.key)
      .where(sql`${t.resolvedAt} is null`),
    index().on(t.projectId, t.detectedAt),
    index().on(t.sendId),
    ...projectScoped("alerts", t),
  ],
);

/**
 * Alert emails: at most one urgent and one daily email per project per day on the schedule's
 * calendar, claimed here before the alerts are attached. `sent_at` stays null until every recipient
 * has it, so a failed send is retried with the same alerts and the same idempotency keys.
 */
export const alertSends = pgTable(
  "alert_sends",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    day: date({ mode: "string" }).notNull(),
    /** urgent | daily */
    kind: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.projectId, t.day, t.kind), ...projectScoped("alert_sends", t)],
);
