// Owned by the umami module. See docs/umami.md.
import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaceId } from "./core";
import { workspaces } from "./workspaces";

/**
 * A workspace's Umami connection (one per workspace), an analytics source a project can use instead
 * of GA4, PostHog or Plausible: Umami Cloud with an API key, or a self-hosted Umami server with an API
 * key or a login token. Its synced rows live in `ga4_landing_daily`, the Analytics table every source shares.
 */
export const umamiAccounts = pgTable(
  "umami_accounts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** The self-hosted server's address, "https://stats.example.com" or with a path. Null for Umami Cloud. */
    baseUrl: text(),
    /** "api_key" (an Umami API key) or "login" (a token from a self-hosted server's login; the password is never stored). */
    authType: text().notNull(),
    /** The API key or login token, AES-256-GCM via src/lib/crypto.ts. Never log, render or export it. */
    credentialEnc: text().notNull(),
    /** "active" or "reauth_required" (Umami stopped accepting the credential). */
    status: text().notNull().default("active"),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),
  },
  (t) => [uniqueIndex("umami_accounts_workspace_id_key").on(t.workspaceId)],
);
