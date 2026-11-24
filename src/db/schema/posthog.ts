// Owned by the posthog module. See docs/posthog.md.
import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaceId } from "./core";
import { workspaces } from "./workspaces";

/**
 * A workspace's PostHog connection (OAuth, one per workspace), the analytics source a project can
 * use instead of GA4. Its synced rows live in `ga4_landing_daily`, the Analytics table both sources share.
 */
export const posthogAccounts = pgTable(
  "posthog_accounts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** "us" or "eu": the PostHog Cloud the user signed in to. Every API call goes to that region's host. */
    region: text().notNull(),
    /** Access and refresh tokens, AES-256-GCM via src/lib/crypto.ts. Never log or render them. */
    accessTokenEnc: text().notNull(),
    refreshTokenEnc: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    scopes: text().array().notNull(),
    /** Project ids the user granted; empty when they granted access to every project. */
    scopedTeams: integer().array().notNull(),
    /** "active" or "reauth_required" (the refresh failed, or there was no refresh token). */
    status: text().notNull().default("active"),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastRefreshAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [uniqueIndex("posthog_accounts_workspace_id_key").on(t.workspaceId)],
);
