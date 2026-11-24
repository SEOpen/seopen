import "server-only";
import { and, asc, eq, getTableColumns, gt, isNotNull, type SQL } from "drizzle-orm";
import { getTableConfig, type AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import type { WorkspaceScope } from "@/lib/workspace";
import { plausibleOpen } from "@/modules/plausible/gate";
import { umamiOpen } from "@/modules/umami/gate";

/**
 * Everything a workspace can download (the privacy page promises it). The browser asks for one page
 * at a time and joins them, so no response comes near the function's 4.5 MB body limit or its time
 * limit, however much the workspace holds. A tenant table added later is exported unless it's listed
 * here, and export.db.test.ts fails if one of its columns looks like a secret. The person downloading
 * also gets their own account rows (PERSONAL), which belong to them rather than the workspace.
 */

/**
 * Tenant tables left out: internal billing and queue records, not what the customer put in or asked
 * for. `api_ledger` goes out, as the usage records the privacy page lists, without what we paid.
 */
const LEFT_OUT = new Set(["alert_sends", "api_cache_access", "api_key_usage", "free_site_claims", "oauth_connection_usage", "rank_tasks", "recap_sends", "spend_reservations", "trial_claims", "workspace_job_pauses", "workspace_usage", "workspace_members"]);

/** Columns left out of every table: what we pay, our provider's task ids, and errors that may name it. */
const OMIT = new Set(["taskId", "costUsd", "estimatedCostUsd", "error", "lastError"]);

/** Secrets and internal ids. */
const OMIT_BY_TABLE: Record<string, string[]> = {
  google_accounts: ["refreshTokenEnc", "refreshTokenExpiresAt", "googleSub"],
  posthog_accounts: ["accessTokenEnc", "accessTokenExpiresAt", "refreshTokenEnc"],
  plausible_accounts: ["apiKeyEnc"],
  umami_accounts: ["credentialEnc"],
  api_keys: ["hash"],
  // Which provider endpoint ran, like the task ids and errors above.
  api_ledger: ["provider", "endpoint"],
};

/** Who is downloading. The account tables are theirs alone, never another member's. */
export interface ExportPerson {
  userId: string;
  email: string;
}

interface PersonalTable {
  table: PgTable;
  columns: Record<string, AnyPgColumn>;
  where: (p: ExportPerson) => SQL;
  order: AnyPgColumn[];
}

const { accounts, sessions, users, waitlist } = schema;

/**
 * Better Auth's and the site's rows about the person downloading, which carry no workspace: their
 * account, how they sign in, where they're signed in (the IP address and browser each session keeps)
 * and their beta waitlist entry. No ids, password hashes or tokens: an id here is Better Auth's or
 * Google's, and a session's token signs it in.
 */
const PERSONAL: Record<string, PersonalTable> = {
  account: {
    table: users,
    columns: {
      email: users.email,
      name: users.name,
      image: users.image,
      emailVerified: users.emailVerified,
      weeklyRecap: users.weeklyRecap,
      alertEmails: users.alertEmails,
      firstSource: users.firstSource,
      firstReferrerHost: users.firstReferrerHost,
      firstLandingPath: users.firstLandingPath,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    },
    where: (p) => eq(users.id, p.userId),
    order: [users.id],
  },
  sign_in_methods: {
    table: accounts,
    columns: { providerId: accounts.providerId, scope: accounts.scope, createdAt: accounts.createdAt, updatedAt: accounts.updatedAt },
    where: (p) => eq(accounts.userId, p.userId),
    order: [accounts.createdAt, accounts.id],
  },
  sessions: {
    table: sessions,
    columns: { createdAt: sessions.createdAt, updatedAt: sessions.updatedAt, expiresAt: sessions.expiresAt, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent },
    where: (p) => eq(sessions.userId, p.userId),
    order: [sessions.createdAt, sessions.id],
  },
  waitlist: {
    table: waitlist,
    columns: {
      email: waitlist.email,
      site: waitlist.site,
      heardFrom: waitlist.heardFrom,
      heardFromOther: waitlist.heardFromOther,
      fromPath: waitlist.fromPath,
      referrer: waitlist.referrer,
      utmSource: waitlist.utmSource,
      createdAt: waitlist.createdAt,
      updatedAt: waitlist.updatedAt,
      invitedAt: waitlist.invitedAt,
    },
    // The waitlist keeps emails lowercased.
    where: (p) => eq(waitlist.email, p.email.trim().toLowerCase()),
    order: [waitlist.id],
  },
};

/** Rows a page reads, and when to cut it short in UTF-8 bytes: well under the 4.5 MB limit on a function's response. */
const PAGE_ROWS = 2000;
const PAGE_BYTES = 3_000_000;

interface ExportTable {
  table: PgTable;
  name: string;
  /** Every column, and the ones a download gets. */
  all: Record<string, AnyPgColumn>;
  columns: Record<string, AnyPgColumn>;
  /** The primary key or first unique index: a stable order to read pages in. */
  order: AnyPgColumn[];
}

const tables: ExportTable[] = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((table) => {
    const config = getTableConfig(table);
    const all = getTableColumns(table) as Record<string, AnyPgColumn>;
    const omit = new Set(OMIT_BY_TABLE[config.name]);
    const columns = Object.fromEntries(Object.entries(all).filter(([key]) => !OMIT.has(key) && !omit.has(key)));
    const key: { name: string }[] = config.columns.filter((c) => c.primary);
    const named = key.length ? key : (config.primaryKeys[0]?.columns ?? config.indexes.find((i) => i.config.unique)?.config.columns ?? []);
    const order = (named as { name: string }[]).flatMap(({ name }) => Object.values(all).filter((c) => c.name === name));
    return { table, name: config.name, all, columns, order };
  })
  .filter((t) => "workspaceId" in t.all && !LEFT_OUT.has(t.name));

const byName = new Map(tables.map((t) => [t.name, t]));

/** Every name `exportPage` takes, in the order a full export writes them. */
export const EXPORT_TABLES = ["workspace", "members", ...Object.keys(PERSONAL), ...tables.map((t) => t.name).sort()];

/**
 * Whether a workspace's download can say Plausible. Until the privacy page names it, only a workspace
 * the gate has opened sees the name (docs/plausible.md), but one holding Plausible data keeps that
 * data in its download, because the download is everything stored for it.
 */
async function showsPlausible({ workspaceId }: WorkspaceScope): Promise<boolean> {
  const { plausibleAccounts, projects } = schema;
  if (plausibleOpen(await loadBillingWorkspace(workspaceId))) return true;
  const held = await Promise.all([
    db.$count(plausibleAccounts, eq(plausibleAccounts.workspaceId, workspaceId)),
    db.$count(projects, and(eq(projects.workspaceId, workspaceId), isNotNull(projects.plausibleSite))),
  ]);
  return held.some((n) => n > 0);
}

/** The same for Umami, which the privacy page doesn't name either (docs/umami.md). */
async function showsUmami({ workspaceId }: WorkspaceScope): Promise<boolean> {
  const { umamiAccounts, projects } = schema;
  if (umamiOpen(await loadBillingWorkspace(workspaceId))) return true;
  const held = await Promise.all([
    db.$count(umamiAccounts, eq(umamiAccounts.workspaceId, workspaceId)),
    db.$count(projects, and(eq(projects.workspaceId, workspaceId), isNotNull(projects.umamiSite))),
  ]);
  return held.some((n) => n > 0);
}

/** The tables this workspace is offered, for the export card and the JSON download. */
export async function exportTablesFor(scope: WorkspaceScope): Promise<string[]> {
  const [plausible, umami] = await Promise.all([showsPlausible(scope), showsUmami(scope)]);
  return EXPORT_TABLES.filter((name) => (plausible || name !== "plausible_accounts") && (umami || name !== "umami_accounts"));
}

export type ExportRow = Record<string, unknown>;

export interface ExportPage {
  rows: ExportRow[];
  /** What to pass as `after` for the next page, or null at the end. */
  next: number | null;
}

/** The columns a table exports, for the test that keeps secrets out. */
export function exportColumns(name: string): string[] {
  return Object.keys((Object.hasOwn(PERSONAL, name) ? PERSONAL[name] : byName.get(name))?.columns ?? {});
}

/** One person's rows: a handful each, so they come in one page. */
async function personalRows(t: PersonalTable, person: ExportPerson): Promise<ExportRow[]> {
  return db
    .select(t.columns)
    .from(t.table as never)
    .where(t.where(person))
    .orderBy(...t.order.map((c) => asc(c)))
    .limit(PAGE_ROWS);
}

async function workspaceRows({ workspaceId }: WorkspaceScope): Promise<ExportRow[]> {
  const { workspaces } = schema;
  return db
    .select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, status: workspaces.status, createdAt: workspaces.createdAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
}

async function memberRows({ workspaceId }: WorkspaceScope): Promise<ExportRow[]> {
  const { users, workspaceMembers } = schema;
  return db
    .select({ email: users.email, name: users.name, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

/**
 * One page of one table, only ever this workspace's rows, and for the account tables only the
 * person's downloading. A table with an `id` pages on it; the others page by offset in key order.
 * Returns null for a name that isn't exported, or isn't for this workspace.
 */
export async function exportPage(scope: WorkspaceScope, name: string, after: number, person: ExportPerson): Promise<ExportPage | null> {
  if (name === "workspace") return { rows: await workspaceRows(scope), next: null };
  if (name === "members") return { rows: await memberRows(scope), next: null };
  if (Object.hasOwn(PERSONAL, name)) return { rows: await personalRows(PERSONAL[name], person), next: null };
  const t = byName.get(name);
  if (!t) return null;
  let columns = t.columns;
  if (name === "plausible_accounts" || name === "projects") {
    if (!(await showsPlausible(scope))) {
      if (name === "plausible_accounts") return null;
      columns = Object.fromEntries(Object.entries(columns).filter(([key]) => key !== "plausibleSite"));
    }
  }
  if (name === "umami_accounts" || name === "projects") {
    if (!(await showsUmami(scope))) {
      if (name === "umami_accounts") return null;
      columns = Object.fromEntries(Object.entries(columns).filter(([key]) => key !== "umamiSite"));
    }
  }

  const own: SQL = eq(t.all.workspaceId, scope.workspaceId);
  const keyed = "id" in t.all;
  const found = await db
    .select(columns)
    .from(t.table as never)
    .where(keyed ? and(own, gt(t.all.id, after)) : own)
    .orderBy(...t.order.map((c) => asc(c)))
    .limit(PAGE_ROWS)
    .offset(keyed ? 0 : after);

  const rows: ExportRow[] = [];
  let bytes = 0;
  for (const row of found as ExportRow[]) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (rows.length && bytes > PAGE_BYTES) break;
    rows.push(row);
  }
  if (rows.length === found.length && found.length < PAGE_ROWS) return { rows, next: null };
  return { rows, next: keyed ? (rows[rows.length - 1].id as number) : after + rows.length };
}
