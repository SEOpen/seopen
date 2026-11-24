import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** The workspace download against seopen_test: every table reads, pages join up, and nothing crosses workspaces or leaks a secret. */

vi.mock("server-only", () => ({}));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { EXPORT_TABLES, exportColumns, exportPage, exportTablesFor } = await import("./export");
const { exportLabel, hasExportLabel } = await import("./export-labels");
const { savePlausibleAccount } = await import("@/modules/plausible/account");
const { saveUmamiAccount } = await import("@/modules/umami/account");

/** An account, made up, that isn't a member of anything yet. */
async function account() {
  const userId = randomUUID();
  const email = `downloader-${randomUUID()}@example.com`;
  await db.insert(s.users).values({ id: userId, email, name: "Downloader", emailVerified: true });
  return { userId, email };
}

/** A workspace, a project and the account downloading, its owner. */
async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `export-${randomUUID()}`, plan: "internal", stripeCustomerId: "cus_secret" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `export-${ws.id}.example` }).returning();
  const person = await account();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: person.userId, role: "owner" });
  return { ws, project, person, scope: { workspaceId: ws.id } };
}

type Person = { userId: string; email: string };

async function readAll(scope: { workspaceId: number }, table: string, person: Person) {
  const rows: Record<string, unknown>[] = [];
  let after: number | null = 0;
  let pages = 0;
  while (after !== null) {
    const page: { rows: Record<string, unknown>[]; next: number | null } | null = await exportPage(scope, table, after, person);
    rows.push(...page!.rows);
    after = page!.next;
    pages += 1;
  }
  return { rows, pages };
}

describe("what the export holds", () => {
  it("leaves out secrets, payment ids, what we pay and our provider's task ids", () => {
    for (const table of EXPORT_TABLES) {
      const risky = exportColumns(table).filter((c) => /token|enc$|hash|password|secret|stripe|taskId|costUsd/i.test(c));
      expect(risky, table).toEqual([]);
    }
    expect(exportColumns("api_keys")).toContain("prefix");
    expect(exportColumns("google_accounts")).toContain("email");
    expect(exportColumns("plausible_accounts")).toEqual(["id", "workspaceId", "status", "connectedAt"]);
    expect(exportColumns("umami_accounts")).toEqual(["id", "workspaceId", "baseUrl", "authType", "status", "connectedAt"]);
  });

  it("offers the customer's data and not the internal tables", () => {
    expect(EXPORT_TABLES).toEqual(
      expect.arrayContaining(["workspace", "members", "account", "sign_in_methods", "sessions", "waitlist", "api_ledger", "projects", "rank_keywords", "gsc_query_pages", "fixes"]),
    );
    for (const table of ["trial_claims", "workspace_usage", "rank_tasks", "users", "accounts", "api_cache", "api_cache_access", "rate_limits", "verifications"]) expect(EXPORT_TABLES).not.toContain(table);
  });

  it("gives the account tables without ids or anything that signs in", () => {
    expect(exportColumns("account")).toEqual(["email", "name", "image", "emailVerified", "weeklyRecap", "alertEmails", "firstSource", "firstReferrerHost", "firstLandingPath", "createdAt", "updatedAt"]);
    expect(exportColumns("sign_in_methods")).toEqual(["providerId", "scope", "createdAt", "updatedAt"]);
    expect(exportColumns("sessions")).toEqual(["createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent"]);
    expect(exportColumns("waitlist")).toEqual(expect.arrayContaining(["email", "site", "heardFrom", "createdAt", "invitedAt"]));
  });

  it("gives usage records with what the workspace was charged, never what we paid or which provider endpoint ran", () => {
    expect(exportColumns("api_ledger")).toEqual(expect.arrayContaining(["module", "projectId", "chargedUsd", "tasks", "source", "createdAt"]));
    for (const column of ["costUsd", "endpoint", "provider"]) expect(exportColumns("api_ledger")).not.toContain(column);
  });

  it("names every table it offers in words, each its own", () => {
    for (const table of EXPORT_TABLES) {
      expect(hasExportLabel(table), `${table} needs a name in export-labels.ts`).toBe(true);
      expect(exportLabel(table)).not.toMatch(/_/);
    }
    expect(new Set(EXPORT_TABLES.map(exportLabel)).size).toBe(EXPORT_TABLES.length);
    expect(exportLabel("gsc_query_pages")).toBe("Search Console: searches by page");
  });
});

describe.skipIf(!ready)("exportPage", () => {
  it("reads every table, and only this workspace's rows", async () => {
    const a = await seed();
    const b = await seed();
    await db.insert(s.rankKeywords).values({ workspaceId: a.ws.id, projectId: a.project.id, keyword: "only a" });
    await db.insert(s.apiLedger).values({ workspaceId: a.ws.id, endpoint: "only/a", module: "domains", chargedUsd: 0.02, costUsd: 0.02 });
    for (const table of EXPORT_TABLES) {
      const { rows } = await readAll(b.scope, table, b.person);
      if (table === "workspace") expect(rows).toEqual([expect.objectContaining({ id: b.ws.id })]);
      else if (table === "projects") expect(rows).toEqual([expect.objectContaining({ id: b.project.id })]);
      else if (table === "members" || table === "account") expect(rows).toEqual([expect.objectContaining({ email: b.person.email })]);
      else expect(rows, table).toEqual([]);
    }
    expect((await readAll(a.scope, "rank_keywords", a.person)).rows).toEqual([expect.objectContaining({ keyword: "only a" })]);
  });

  it("gives the workspace row without its Stripe ids, and its members' emails", async () => {
    const { ws, scope, person } = await seed();
    const other = await account();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: other.userId, role: "member" });
    const { rows } = await readAll(scope, "workspace", person);
    expect(JSON.stringify(rows)).not.toContain("cus_secret");
    expect((await readAll(scope, "members", person)).rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: person.email, role: "owner" }), expect.objectContaining({ email: other.email, role: "member" })]),
    );
  });

  it("gives the downloader's own account, sign-in methods, sessions and waitlist entry, and nobody else's", async () => {
    const { ws, scope, person } = await seed();
    const other = await account();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: other.userId, role: "member" });
    const session = (userId: string, ip: string) => ({ id: randomUUID(), userId, token: `token-${randomUUID()}`, expiresAt: new Date(Date.now() + 86_400_000), ipAddress: ip, userAgent: "Test browser" });
    const mine = session(person.userId, "203.0.113.7");
    await db.insert(s.sessions).values([mine, session(other.userId, "198.51.100.4")]);
    await db.insert(s.accounts).values([
      { id: randomUUID(), userId: person.userId, accountId: person.userId, providerId: "credential", password: "made-up-password-hash" },
      { id: randomUUID(), userId: person.userId, accountId: "google-sub-123", providerId: "google", accessToken: "made-up-access", refreshToken: "made-up-refresh", idToken: "made-up-id", scope: "openid,email,profile" },
      { id: randomUUID(), userId: other.userId, accountId: other.userId, providerId: "credential", password: "other-hash" },
    ]);
    await db.insert(s.waitlist).values([{ email: person.email, site: "mine.example", heardFrom: "search" }, { email: other.email, site: "theirs.example" }]);
    // Where each first came from: the download gives the downloader's own.
    await db.update(s.users).set({ firstSource: "newsletter", firstReferrerHost: "news.example", firstLandingPath: "/pricing" }).where(eq(s.users.id, person.userId));
    await db.update(s.users).set({ firstSource: "their-campaign", firstReferrerHost: "theirs-referrer.example" }).where(eq(s.users.id, other.userId));

    const accountRows = (await readAll(scope, "account", person)).rows;
    expect(accountRows).toEqual([
      {
        email: person.email,
        name: "Downloader",
        image: null,
        emailVerified: true,
        weeklyRecap: false,
        alertEmails: true,
        firstSource: "newsletter",
        firstReferrerHost: "news.example",
        firstLandingPath: "/pricing",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);

    const methods = (await readAll(scope, "sign_in_methods", person)).rows;
    expect(methods.map((m) => m.providerId).sort()).toEqual(["credential", "google"]);
    const sessionRows = (await readAll(scope, "sessions", person)).rows;
    expect(sessionRows).toEqual([expect.objectContaining({ ipAddress: "203.0.113.7", userAgent: "Test browser" })]);
    const entry = (await readAll(scope, "waitlist", person)).rows;
    expect(entry).toEqual([expect.objectContaining({ email: person.email, site: "mine.example", heardFrom: "search" })]);

    const everything = JSON.stringify([accountRows, methods, sessionRows, entry]);
    for (const secret of ["made-up-password-hash", "made-up-access", "made-up-refresh", "made-up-id", "google-sub-123", mine.token, mine.id, person.userId]) expect(everything).not.toContain(secret);
    for (const theirs of ["198.51.100.4", "theirs.example", "other-hash", other.email, "their-campaign", "theirs-referrer.example"]) expect(everything).not.toContain(theirs);
    await db.delete(s.waitlist).where(eq(s.waitlist.email, person.email));
    await db.delete(s.waitlist).where(eq(s.waitlist.email, other.email));
  });

  it("finds the waitlist entry whatever the account email's case", async () => {
    const { scope, person } = await seed();
    await db.insert(s.waitlist).values({ email: person.email, site: "case.example" });
    expect((await readAll(scope, "waitlist", { ...person, email: person.email.toUpperCase() })).rows).toEqual([expect.objectContaining({ site: "case.example" })]);
    await db.delete(s.waitlist).where(eq(s.waitlist.email, person.email));
  });

  it("gives the workspace's usage records with what it was charged, not what we paid", async () => {
    const { ws, project, scope, person } = await seed();
    await db.insert(s.apiLedger).values({ workspaceId: ws.id, endpoint: "dataforseo_labs/google/x/live", module: "keywords", projectId: project.id, costUsd: 0.0123, chargedUsd: 0.02, tasks: 1, statusCode: 20000 });
    const { rows } = await readAll(scope, "api_ledger", person);
    expect(rows).toEqual([expect.objectContaining({ module: "keywords", projectId: project.id, chargedUsd: 0.02, tasks: 1 })]);
    expect(JSON.stringify(rows)).not.toMatch(/dataforseo|0\.0123/);
  });

  it("exports a Plausible connection without its key, in the stored or the plain form", async () => {
    const { ws, scope, person } = await seed();
    const key = `made-up-key-${randomUUID()}`;
    await savePlausibleAccount(ws.id, key);
    const [stored] = await db.select().from(s.plausibleAccounts).where(eq(s.plausibleAccounts.workspaceId, ws.id));
    const { rows } = await readAll(scope, "plausible_accounts", person);
    expect(rows).toEqual([expect.objectContaining({ workspaceId: ws.id, status: "active" })]);
    expect(JSON.stringify(rows)).not.toContain(stored.apiKeyEnc);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(Object.keys(rows[0])).not.toContain("apiKeyEnc");
  });

  it("exports an Umami connection without its key or token, in the stored or the plain form", async () => {
    const { ws, scope, person } = await seed();
    const credential = `made-up-token-${randomUUID()}`;
    await saveUmamiAccount(ws.id, { baseUrl: "https://stats.madeup-umami.app", authType: "login", credential });
    const [stored] = await db.select().from(s.umamiAccounts).where(eq(s.umamiAccounts.workspaceId, ws.id));
    expect(stored.credentialEnc).not.toContain(credential);
    const { rows } = await readAll(scope, "umami_accounts", person);
    expect(rows).toEqual([expect.objectContaining({ workspaceId: ws.id, baseUrl: "https://stats.madeup-umami.app", authType: "login", status: "active" })]);
    expect(JSON.stringify(rows)).not.toContain(stored.credentialEnc);
    expect(JSON.stringify(rows)).not.toContain(credential);
    expect(Object.keys(rows[0])).not.toContain("credentialEnc");
  });

  it("joins pages with no gaps, on a table with an id", async () => {
    const { ws, project, scope, person } = await seed();
    await db.insert(s.rankKeywords).values(Array.from({ length: 2005 }, (_, i) => ({ workspaceId: ws.id, projectId: project.id, keyword: `kw ${i}` })));
    const { rows, pages } = await readAll(scope, "rank_keywords", person);
    expect(pages).toBe(2);
    expect(new Set(rows.map((r) => r.keyword)).size).toBe(2005);
  });

  it("joins pages with no gaps, on a table without one", async () => {
    const { ws, project, scope, person } = await seed();
    const row = (i: number) => ({ workspaceId: ws.id, projectId: project.id, date: "2026-11-01", page: `/p${i}`, clicks: 1, impressions: 1, ctr: 1, position: 1 });
    await db.insert(s.gscPages).values(Array.from({ length: 2005 }, (_, i) => row(i)));
    const { rows, pages } = await readAll(scope, "gsc_pages", person);
    expect(pages).toBe(2);
    expect(new Set(rows.map((r) => r.page)).size).toBe(2005);
  });

  it("cuts a page short before it gets too big for a response", async () => {
    const { ws, project, scope, person } = await seed();
    const note = "x".repeat(2_000_000);
    await db.insert(s.backlinksDomainDecisions).values(["a.example", "b.example", "c.example"].map((domain) => ({ workspaceId: ws.id, projectId: project.id, domain, decision: "keep", note })));
    const first = await exportPage(scope, "backlinks_domain_decisions", 0, person);
    expect(first!.rows).toHaveLength(1);
    expect(first!.next).not.toBeNull();
    const { rows, pages } = await readAll(scope, "backlinks_domain_decisions", person);
    expect(rows).toHaveLength(3);
    expect(pages).toBe(3);
  });

  it("refuses a table it doesn't export", async () => {
    const { scope, person } = await seed();
    for (const name of ["trial_claims", "users", "accounts", "rate_limits", "", "projects; drop table users"]) expect(await exportPage(scope, name, 0, person)).toBeNull();
  });
});

describe.skipIf(!ready)("the Plausible name in the download", () => {
  async function closed(plan = "starter") {
    const [ws] = await db.insert(s.workspaces).values({ name: `closed-${randomUUID()}`, plan }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `closed-${ws.id}.example` }).returning();
    const person = await account();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: person.userId, role: "owner" });
    return { ws, project, person, scope: { workspaceId: ws.id } };
  }

  it.each(["free", "starter", "pro"])("never reaches a %s workspace that holds no Plausible data", async (plan) => {
    const { scope, person } = await closed(plan);
    const offered = await exportTablesFor(scope);
    expect(offered).not.toContain("plausible_accounts");
    expect(offered).toEqual(expect.arrayContaining(["workspace", "projects", "rank_keywords"]));
    expect(await exportPage(scope, "plausible_accounts", 0, person)).toBeNull();
    const everything = await Promise.all(offered.map(async (table) => [table, (await readAll(scope, table, person)).rows]));
    expect(JSON.stringify(Object.fromEntries(everything))).not.toMatch(/plausible/i);
  });

  it("shows a workspace the gate has opened", async () => {
    const { scope, person } = await seed();
    expect(await exportTablesFor(scope)).toContain("plausible_accounts");
    expect((await readAll(scope, "projects", person)).rows[0]).toHaveProperty("plausibleSite");
  });

  it("keeps a connected account in a closed workspace's download", async () => {
    const { ws, scope, person } = await closed();
    await db.insert(s.plausibleAccounts).values({ workspaceId: ws.id, apiKeyEnc: "made-up-ciphertext" });
    expect(await exportTablesFor(scope)).toContain("plausible_accounts");
    const { rows } = await readAll(scope, "plausible_accounts", person);
    expect(rows).toEqual([expect.objectContaining({ workspaceId: ws.id })]);
    expect(rows[0]).not.toHaveProperty("apiKeyEnc");
  });

  it("keeps a mapped site in a closed workspace's download", async () => {
    const { project, scope, person } = await closed();
    await db.update(s.projects).set({ plausibleSite: "mapped.example" }).where(eq(s.projects.id, project.id));
    expect(await exportTablesFor(scope)).toContain("plausible_accounts");
    expect((await readAll(scope, "projects", person)).rows[0].plausibleSite).toBe("mapped.example");
  });

  it("doesn't read another workspace's account as this one's", async () => {
    const a = await closed();
    const b = await closed();
    await db.insert(s.plausibleAccounts).values({ workspaceId: a.ws.id, apiKeyEnc: "made-up-ciphertext" });
    expect(await exportTablesFor(b.scope)).not.toContain("plausible_accounts");
  });
});

describe.skipIf(!ready)("the Umami name in the download", () => {
  async function closed(plan = "starter") {
    const [ws] = await db.insert(s.workspaces).values({ name: `closed-${randomUUID()}`, plan }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `closed-${ws.id}.example` }).returning();
    const person = await account();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: person.userId, role: "owner" });
    return { ws, project, person, scope: { workspaceId: ws.id } };
  }

  it.each(["free", "starter", "pro"])("never reaches a %s workspace that holds no Umami data", async (plan) => {
    const { scope, person } = await closed(plan);
    const offered = await exportTablesFor(scope);
    expect(offered).not.toContain("umami_accounts");
    expect(await exportPage(scope, "umami_accounts", 0, person)).toBeNull();
    const everything = await Promise.all(offered.map(async (table) => [table, (await readAll(scope, table, person)).rows]));
    expect(JSON.stringify(Object.fromEntries(everything))).not.toMatch(/umami/i);
  });

  it("shows a workspace the gate has opened", async () => {
    const { scope, person } = await seed();
    expect(await exportTablesFor(scope)).toContain("umami_accounts");
    expect((await readAll(scope, "projects", person)).rows[0]).toHaveProperty("umamiSite");
  });

  it("keeps a connected account or a mapped website in a closed workspace's download", async () => {
    const a = await closed();
    await db.insert(s.umamiAccounts).values({ workspaceId: a.ws.id, authType: "api_key", credentialEnc: "made-up-ciphertext" });
    expect(await exportTablesFor(a.scope)).toContain("umami_accounts");
    expect((await readAll(a.scope, "umami_accounts", a.person)).rows[0]).not.toHaveProperty("credentialEnc");
    const b = await closed();
    await db.update(s.projects).set({ umamiSite: "4f0c1e2a-0000-4000-8000-00000000abcd" }).where(eq(s.projects.id, b.project.id));
    expect((await readAll(b.scope, "projects", b.person)).rows[0].umamiSite).toBe("4f0c1e2a-0000-4000-8000-00000000abcd");
  });

  it("doesn't read another workspace's account as this one's", async () => {
    const a = await closed();
    const b = await closed();
    await db.insert(s.umamiAccounts).values({ workspaceId: a.ws.id, authType: "api_key", credentialEnc: "made-up-ciphertext" });
    expect(await exportTablesFor(b.scope)).not.toContain("umami_accounts");
  });
});

describe.skipIf(!ready)("the page cap", () => {
  it("counts UTF-8 bytes, so text that takes 3 bytes a character can't overrun the response limit", async () => {
    const { ws, project, scope, person } = await seed();
    const row = (domain: string) => ({ workspaceId: ws.id, projectId: project.id, domain, decision: "keep", note: "語".repeat(800_000) });
    await db.insert(s.backlinksDomainDecisions).values([row("a.example"), row("b.example")]);

    const first = (await exportPage(scope, "backlinks_domain_decisions", 0, person))!;
    // Together the two rows are 1.6 M characters and 4.8 MB: only counting bytes stops at one.
    expect(first.rows).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(first.rows))).toBeLessThanOrEqual(4_500_000);

    const { rows, pages } = await readAll(scope, "backlinks_domain_decisions", person);
    expect(rows).toHaveLength(2);
    expect(pages).toBe(2);
    expect(new Set(rows.map((r) => r.domain)).size).toBe(2);
  });
});
