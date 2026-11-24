// Owned by the plausible module. See docs/plausible.md.
import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaceId } from "./core";
import { workspaces } from "./workspaces";

/**
 * A workspace's Plausible Cloud connection (a pasted Stats API key, one per workspace), an analytics
 * source a project can use instead of GA4 or PostHog. Its synced rows live in `ga4_landing_daily`,
 * the Analytics table every source shares.
 */
export const plausibleAccounts = pgTable(
  "plausible_accounts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** The Stats API key, AES-256-GCM via src/lib/crypto.ts. Never log, render or export it. */
    apiKeyEnc: text().notNull(),
    /** "active" or "reauth_required" (Plausible stopped accepting the key). */
    status: text().notNull().default("active"),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),
  },
  (t) => [uniqueIndex("plausible_accounts_workspace_id_key").on(t.workspaceId)],
);
