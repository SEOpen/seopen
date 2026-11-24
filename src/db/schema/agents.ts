// AI agents: API keys for the MCP server (/api/mcp).
import { index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { oauthClients, users } from "./auth";
import { workspaceId } from "./core";
import { workspaces } from "./workspaces";

/**
 * A workspace API key, made on the MCP page. It acts as its creator in this workspace and stops
 * working when it's revoked or expires, the creator leaves the workspace, or the workspace is
 * suspended. Only the SHA-256 of the key is stored; the key itself is shown once.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** The key's first characters ("seopen_AbC1x"), so Settings can show which key is which. */
    prefix: text().notNull(),
    /** Hex SHA-256 of the whole key. */
    hash: text().notNull(),
    /** "read", plus "write" for a key that may make changes; "research" (may spend credits) arrives with the research tools. */
    scopes: text().array().notNull().default(["read"]),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_hash_key").on(t.hash), index().on(t.workspaceId)],
);

/**
 * Per-key rate limit counters (`src/lib/mcp/limits.ts`): one row per key, limit and fixed window,
 * counted in Postgres so every instance shares them. Rows older than a day are pruned daily.
 */
export const apiKeyUsage = pgTable(
  "api_key_usage",
  {
    keyId: integer()
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    /** Which limit: "requests" (every call) or "changes" (confirmed write tools). */
    bucket: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.bucket, t.windowStart] }), index().on(t.workspaceId), index().on(t.windowStart)],
);

/**
 * An app connected over OAuth (Claude.ai, Claude Desktop, ChatGPT) as one user in one workspace:
 * SEOpen's own record beside Better Auth's consent, for the MCP page's last use and the per-app
 * rate limits. Made by the first call that comes in with the app's token. What the app may do is
 * the consent's (`oauth_consents`); disconnecting deletes both, and the app's refresh tokens.
 */
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.userId, t.clientId), index().on(t.clientId)],
);

/** `api_key_usage` for connected apps: the same limits, counted per connection. */
export const oauthConnectionUsage = pgTable(
  "oauth_connection_usage",
  {
    connectionId: integer()
      .notNull()
      .references(() => oauthConnections.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    bucket: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.bucket, t.windowStart] }), index().on(t.workspaceId), index().on(t.windowStart)],
);
