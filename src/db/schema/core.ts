import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * `workspace_id` for a tenant-owned table. No default: every insert must say which workspace the
 * row belongs to, and every query filters on it (src/lib/workspace). Tables without one are listed
 * in GLOBAL_TABLES and checked by src/db/schema/tenancy.test.ts.
 */
export const workspaceId = () => integer().notNull();

/**
 * Tables that are shared by every workspace on purpose. Everything else carries `workspace_id`.
 * `settings` is platform-only, `api_cache` holds public market data (who paid for each entry is in
 * `api_cache_access`), and the Better Auth tables belong to accounts, which reach workspaces
 * through `workspace_members`.
 */
export const GLOBAL_TABLES = [
  "workspaces",
  "settings",
  "api_cache",
  // Who is fetching an api_cache key right now: keys span workspaces, as api_cache's do.
  "api_cache_claims",
  "users",
  "sessions",
  "accounts",
  "verifications",
  "rate_limits",
  // OAuth for the MCP server (src/db/schema/auth.ts), Better Auth's too: apps, tokens and consents
  // belong to accounts. A consent names its workspace in `reference_id`, and `oauth_connections` is the
  // workspace's own record of each connected app.
  "oauth_clients",
  "oauth_resources",
  "oauth_client_resources",
  "oauth_refresh_tokens",
  "oauth_access_tokens",
  "oauth_consents",
  "oauth_client_assertions",
  "jwks",
  // Billing (src/db/schema/billing.ts): the platform meter, Stripe's event log, and trial claims,
  // which outlive the workspace that made them on purpose.
  "platform_usage",
  "stripe_events",
  "trial_claims",
  // One Free account per inbox, where the copy has public sign-up: it outlives the account on purpose, like trial claims.
  "signup_claims",
  // The marketing site's beta waitlist (src/db/schema/site.ts): nobody on it has a workspace yet.
  "waitlist",
  // DataForSEO's list of places (src/lib/dataforseo/places.ts): public data, the same for everyone.
  "dfs_places",
  // The free tools' request log and result cache (src/db/schema/site.ts): anonymous visitors.
  // Paid calls themselves are charged to the internal `public-tools` workspace's ledger.
  "public_tool_uses",
  "public_tool_results",
] as const;

/** Cities DataForSEO can search from, filled per country from its free location list when first needed. */
export const dfsPlaces = pgTable(
  "dfs_places",
  {
    /** DataForSEO location_code. */
    code: integer().primaryKey(),
    /** "Salem, New Hampshire": the location's name without its country. */
    name: text().notNull(),
    /** Lowercase ISO 3166 alpha-2, e.g. "us". */
    countryIso: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.countryIso, t.name)],
);

export const projects = pgTable(
  "projects",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Bare hostname, e.g. "alphanote.example" (no scheme, no trailing slash). */
    domain: text().notNull(),
    /** DataForSEO location_code, e.g. 2840 = United States. */
    locationCode: integer().notNull().default(2840),
    /** DataForSEO language_code, e.g. "en". */
    languageCode: text().notNull().default("en"),
    /**
     * City that rank tracking searches from, a DataForSEO location_code inside `locationCode`'s country.
     * Null tracks the whole country. Kept apart from `locationCode` because Labs, which most research
     * pages use, only takes countries (see `trackedLocation`).
     */
    cityCode: integer(),
    /** The city's name, e.g. "Salem, New Hampshire". Set with `cityCode`. */
    cityName: text(),
    /** What kind of business the site is ("local", "software", "store", "other"), as confirmed in the guided setup. Null until then. */
    businessType: text(),
    /** The towns a local business serves, "Riverton, Ohio" style, main town first, as confirmed in the guided setup. */
    servedTowns: jsonb().$type<string[]>(),
    /** What people search for to find a business that isn't local, as confirmed in the guided setup. Null until then; empty means the user cleared the guess. */
    setupSearches: jsonb().$type<string[]>(),
    /** Search Console property, e.g. "sc-domain:alphanote.example". Set by the Google module. */
    gscProperty: text(),
    /** GA4 property resource name, e.g. "properties/123456". Set by the Google module. */
    ga4Property: text(),
    /**
     * PostHog project id on the workspace's PostHog connection, e.g. "12345". Set by the posthog
     * module. A project's Analytics comes from one of GA4, PostHog, Plausible or Umami: setting one clears the others.
     */
    posthogProject: text(),
    /** Plausible site ID (the site's domain in Plausible) on the workspace's Plausible connection. Set by the plausible module. */
    plausibleSite: text(),
    /** Umami website ID (a UUID) on the workspace's Umami connection. Set by the umami module. */
    umamiSite: text(),
    /**
     * Count branded prompts (the question names the brand) in AI visibility: Overview, the
     * dashboard card, the projects overview and MCP. Off by default, since such answers name us almost by definition.
     */
    aiIncludeBranded: boolean().notNull().default(false),
    archived: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // The target of every (workspace_id, project_id) foreign key; also the workspace index.
  (t) => [unique("projects_workspace_id_id_key").on(t.workspaceId, t.id)],
);

/**
 * Index and foreign key for a table with `project_id`: (workspace_id, project_id) must name a
 * project of the same workspace, so a row can never point at another workspace's project.
 */
export function projectScoped(table: string, t: { workspaceId: AnyPgColumn; projectId: AnyPgColumn }) {
  return [
    index(`${table}_workspace_project_idx`).on(t.workspaceId, t.projectId),
    foreignKey({ name: `${table}_project_fk`, columns: [t.workspaceId, t.projectId], foreignColumns: [projects.workspaceId, projects.id] }).onDelete("cascade"),
  ];
}

/**
 * Index and foreign key for a child of another tenant row (a crawl's pages, a run's tasks):
 * (workspace_id, parent_id) must name a parent of the same workspace. The parent table needs a
 * unique (workspace_id, id).
 */
export function parentScoped(table: string, cols: [AnyPgColumn, AnyPgColumn], parent: [AnyPgColumn, AnyPgColumn]) {
  return [
    index(`${table}_workspace_parent_idx`).on(...cols),
    foreignKey({ name: `${table}_parent_fk`, columns: cols, foreignColumns: parent }).onDelete("cascade"),
  ];
}

export const competitors = pgTable(
  "competitors",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    domain: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.domain), ...projectScoped("competitors", t)],
);

/**
 * Platform-wide key/value settings, shared by every workspace, e.g. "platform.monthly_cap_usd"
 * (a backstop over every workspace's spend). A workspace's own values live in workspace_settings.
 */
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Response cache for paid API calls, keyed by a hash of endpoint + request body. Shared by every
 * workspace, but only for public market data (`sharedCacheEndpoint` in the DataForSEO client);
 * other endpoints are cached under a per-workspace key. Who paid for an entry is in api_cache_access.
 */
export const apiCache = pgTable(
  "api_cache",
  {
    key: text().primaryKey(),
    endpoint: text().notNull(),
    response: jsonb().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.expiresAt)],
);

/**
 * A call fetching a cache key from DataForSEO right now, so another call with the same key waits
 * for its answer instead of paying for the same lookup again (src/lib/dataforseo/claims.ts). The
 * call deletes its row when it ends. One whose process died lapses at `expiresAt`, and the daily
 * billing.alerts job deletes it.
 */
export const apiCacheClaims = pgTable("api_cache_claims", {
  key: text().primaryKey(),
  /** Which call holds the claim, so only that call renews or releases it. */
  token: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which workspaces have paid for a cache entry. A hit is free only for them; any other workspace
 * is charged the original call's cost and then gets a row here. Rewriting the entry clears its
 * rows, so a refreshed response is paid for again.
 */
export const apiCacheAccess = pgTable(
  "api_cache_access",
  {
    key: text().notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    paidAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.workspaceId] }), index().on(t.workspaceId)],
);

/**
 * One row per paid API call. `cost_usd` is what DataForSEO billed us; `charged_usd` is what the
 * workspace's cap was charged. They differ for a shared cache hit another workspace paid for
 * (cost 0, charged the original price). Free cache hits are not recorded.
 */
export const apiLedger = pgTable(
  "api_ledger",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text().notNull().default("dataforseo"),
    endpoint: text().notNull(),
    /** Module that made the call, e.g. "keywords", "rank", "audit". */
    module: text().notNull(),
    projectId: integer().references(() => projects.id, { onDelete: "set null" }),
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    chargedUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    tasks: integer().notNull().default(1),
    statusCode: integer(),
    /** Who started the work: "app" (a person in SEOpen, or a schedule) or "mcp" (an AI agent through a workspace API key). */
    source: text().notNull().default("app"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // project_id: deleting a project sets it null here.
  (t) => [index().on(t.createdAt), index().on(t.module), index().on(t.workspaceId, t.createdAt), index().on(t.projectId)],
);
