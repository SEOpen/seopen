import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/** Deleting a workspace against seopen_test, with Stripe, Google and PostHog stubbed: all of it goes, or none of it does, the Plausible key with it. */

vi.mock("server-only", () => ({}));
const calls: string[] = [];
const cancel = vi.fn(async () => void calls.push("stripe"));
const google = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => (calls.push("google"), { ok: true }));
const posthog = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => (calls.push("posthog"), { ok: true }));
const isAdmin = vi.fn<(userId?: string) => Promise<boolean>>(async () => false);
const failure = vi.hoisted(() => ({ current: undefined as { logTag: string; message: string } | undefined }));
vi.mock("@/billing-provider", () => ({
  provider: {
    cancelSubscriptionsForWorkspace: cancel,
    get cancelFailure() {
      return failure.current;
    },
  },
}));
vi.mock("@/modules/google/auth", () => ({ disconnectAccount: google }));
vi.mock("@/modules/posthog/account", () => ({ disconnectPosthogAccount: posthog }));
vi.mock("@/lib/admin/access", () => ({ isAdmin }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { OWNER_WORKSPACE_ID } = await import("@/lib/workspace");
const { accountsGoingWith, deleteUserAsAdminOp, deleteWorkspaceAsAdminOp, deleteWorkspaceOp, userDeletion } = await import("./delete");
const { deleteProjectOp } = await import("@/lib/ops/projects");

async function addUser() {
  const id = randomUUID();
  const email = `${id}@example.com`;
  await db.insert(s.users).values({ id, email, name: "Owner", emailVerified: true });
  return { id, email };
}

async function seed() {
  const user = await addUser();
  const [ws] = await db.insert(s.workspaces).values({ name: `delete-${randomUUID()}`, plan: "free" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `delete-${ws.id}.example` }).returning();
  await db.insert(s.rankKeywords).values({ workspaceId: ws.id, projectId: project.id, keyword: "kept or not" });
  await db.insert(s.apiKeys).values({ workspaceId: ws.id, userId: user.id, name: "Laptop", prefix: `p${ws.id}`, hash: randomUUID(), scopes: ["read"] });
  return { user, ws, project, scope: { workspaceId: ws.id }, actor: { userId: user.id, source: "app" as const } };
}

const statusOf = async (id: number) => (await db.select({ status: s.workspaces.status }).from(s.workspaces).where(eq(s.workspaces.id, id)))[0]?.status;

describe.skipIf(!ready)("deleteWorkspaceOp", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    isAdmin.mockResolvedValue(false);
  });

  it("cancels Stripe, disconnects, then deletes every row, the account and its waitlist entry", async () => {
    const { user, ws, project, scope, actor } = await seed();
    await db.insert(s.sessions).values({ id: randomUUID(), userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(s.waitlist).values({ email: user.email });
    const expiresAt = new Date(Date.now() + 60_000);
    const shared = `shared-${randomUUID()}`;
    const other = `w${ws.id + 1000000}:${randomUUID()}`;
    await db.insert(s.apiCache).values([
      { key: `w${ws.id}:${randomUUID()}`, endpoint: "x", response: {}, expiresAt },
      { key: shared, endpoint: "x", response: {}, expiresAt },
      { key: other, endpoint: "x", response: {}, expiresAt },
    ]);
    const hash = randomUUID();
    await db.insert(s.trialClaims).values({ kind: "email", hash, workspaceId: ws.id });
    await db.insert(s.plausibleAccounts).values({ workspaceId: ws.id, apiKeyEnc: "made-up-ciphertext" });
    await db.insert(s.googleSyncState).values({ workspaceId: ws.id, projectId: project.id, source: "plausible", property: "made-up.example", backfillStart: "2026-01-01" });
    await db.insert(s.ga4LandingDaily).values({ workspaceId: ws.id, projectId: project.id, date: "2026-10-01", hostName: "made-up.example", landingPage: "/", sessions: 1, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 });

    expect(await deleteWorkspaceOp(scope, actor, " Delete ")).toEqual({ dryRun: false, accountRemoved: true, message: `Deleted ${ws.name}.` });

    expect(calls[0]).toBe("stripe");
    expect(calls.slice(1).sort()).toEqual(["google", "posthog"]);
    expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
    expect(await db.$count(s.projects, eq(s.projects.id, project.id))).toBe(0);
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, ws.id))).toBe(0);
    expect(await db.$count(s.apiKeys, eq(s.apiKeys.workspaceId, ws.id))).toBe(0);
    expect(await db.$count(s.plausibleAccounts, eq(s.plausibleAccounts.workspaceId, ws.id))).toBe(0);
    expect(await db.$count(s.googleSyncState, eq(s.googleSyncState.workspaceId, ws.id))).toBe(0);
    expect(await db.$count(s.ga4LandingDaily, eq(s.ga4LandingDaily.workspaceId, ws.id))).toBe(0);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(0);
    expect(await db.$count(s.sessions, eq(s.sessions.userId, user.id))).toBe(0);
    expect(await db.$count(s.waitlist, eq(s.waitlist.email, user.email))).toBe(0);
    // This workspace's cached lookups go; shared ones and another workspace's stay.
    expect(await db.$count(s.apiCache, eq(s.apiCache.key, shared))).toBe(1);
    expect(await db.$count(s.apiCache, eq(s.apiCache.key, other))).toBe(1);
    const left = await db.select({ key: s.apiCache.key }).from(s.apiCache);
    expect(left.filter((r) => r.key.startsWith(`w${ws.id}:`))).toEqual([]);
    // Trial claims outlive the workspace on purpose.
    expect(await db.$count(s.trialClaims, eq(s.trialClaims.hash, hash))).toBe(1);
  });

  it("leaves another workspace alone", async () => {
    const a = await seed();
    const b = await seed();
    await deleteWorkspaceOp(a.scope, a.actor, "delete");
    expect(await statusOf(b.ws.id)).toBe("active");
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, b.ws.id))).toBe(1);
    expect(await db.$count(s.users, eq(s.users.id, b.user.id))).toBe(1);
  });

  it("refuses someone from another workspace, and changes nothing", async () => {
    const a = await seed();
    const b = await seed();
    await expect(deleteWorkspaceOp(a.scope, b.actor, "delete")).rejects.toThrow("Only the workspace's owner can delete it.");
    expect(calls).toEqual([]);
    expect(await statusOf(a.ws.id)).toBe("active");
  });

  it("keeps the account when it has another workspace, and only that workspace's connected apps go", async () => {
    const { user, ws, scope, actor } = await seed();
    const [other] = await db.insert(s.workspaces).values({ name: `other-${randomUUID()}` }).returning();
    await db.insert(s.workspaceMembers).values({ workspaceId: other.id, userId: user.id, role: "owner" });
    const clientId = randomUUID();
    await db.insert(s.oauthClients).values({ id: randomUUID(), clientId, redirectUris: ["https://app.example/callback"] });
    const expiresAt = new Date(Date.now() + 60_000);
    for (const ref of [String(ws.id), String(other.id)]) {
      await db.insert(s.oauthConsents).values({ id: randomUUID(), clientId, userId: user.id, referenceId: ref, scopes: ["read"] });
      await db.insert(s.oauthRefreshTokens).values({ id: randomUUID(), token: randomUUID(), clientId, userId: user.id, referenceId: ref, scopes: ["read"], expiresAt });
    }
    expect((await deleteWorkspaceOp(scope, actor, "delete")).accountRemoved).toBe(false);
    expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
    expect(await db.$count(s.oauthConsents, eq(s.oauthConsents.referenceId, String(ws.id)))).toBe(0);
    expect(await db.$count(s.oauthRefreshTokens, eq(s.oauthRefreshTokens.referenceId, String(ws.id)))).toBe(0);
    expect(await db.$count(s.oauthConsents, eq(s.oauthConsents.referenceId, String(other.id)))).toBe(1);
    expect(await db.$count(s.oauthRefreshTokens, eq(s.oauthRefreshTokens.referenceId, String(other.id)))).toBe(1);
  });

  it("keeps a self sign-up's inbox claim and starts its wait, only when the account goes", async () => {
    const { user, scope, actor } = await seed();
    await db.insert(s.signupClaims).values({ hash: `test-${randomUUID()}`, userId: user.id, claimedAt: new Date(Date.now() - 86_400_000) });
    expect((await deleteWorkspaceOp(scope, actor, "delete")).accountRemoved).toBe(true);
    const [claim] = await db.select().from(s.signupClaims).where(eq(s.signupClaims.userId, user.id));
    expect(claim.releasedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const kept = await seed();
    const [other] = await db.insert(s.workspaces).values({ name: `other-${randomUUID()}` }).returning();
    await db.insert(s.workspaceMembers).values({ workspaceId: other.id, userId: kept.user.id, role: "owner" });
    await db.insert(s.signupClaims).values({ hash: `test-${randomUUID()}`, userId: kept.user.id });
    await deleteWorkspaceOp(kept.scope, kept.actor, "delete");
    const [still] = await db.select().from(s.signupClaims).where(eq(s.signupClaims.userId, kept.user.id));
    expect(still.releasedAt).toBeNull();
  });

  it("keeps an admin's account", async () => {
    const { user, scope, actor } = await seed();
    isAdmin.mockResolvedValue(true);
    expect((await deleteWorkspaceOp(scope, actor, "delete")).accountRemoved).toBe(false);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
  });

  it("removes a second member's account too when it's left with no workspace", async () => {
    const { ws, scope, actor } = await seed();
    const second = await addUser();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: second.id, role: "member" });
    await deleteWorkspaceOp(scope, actor, "delete");
    expect(await db.$count(s.users, eq(s.users.id, second.id))).toBe(0);
  });

  it("refuses a member who isn't the owner", async () => {
    const { ws, scope } = await seed();
    const second = await addUser();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: second.id, role: "member" });
    await expect(deleteWorkspaceOp(scope, { userId: second.id, source: "app" }, "delete")).rejects.toThrow("Only the workspace's owner can delete it.");
    expect(calls).toEqual([]);
  });

  it("refuses the owner's workspace and an unconfirmed delete", async () => {
    const { scope, actor, ws } = await seed();
    await expect(deleteWorkspaceOp({ workspaceId: OWNER_WORKSPACE_ID }, actor, "delete")).rejects.toThrow("The owner's workspace can't be deleted.");
    await expect(deleteWorkspaceOp(scope, actor, "nope")).rejects.toThrow("Type delete to confirm.");
    expect(calls).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("goes through a check stuck past any real check's length, and not one younger", async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    // Statuses no poller in another test file closes first: they all share this database.
    for (const [table, since, status] of [
      [s.rankRuns, "createdAt", "pending"],
      [s.aiRuns, "startedAt", "running"],
      [s.auditCrawls, "createdAt", "crawling"],
    ] as const) {
      const { ws, project, scope, actor } = await seed();
      const values = { workspaceId: ws.id, projectId: project.id, status, [since]: days(3) };
      const row = table === s.rankRuns ? { ...values, kind: "manual", date: "2026-11-01", depth: 10, aiOverview: false } : table === s.auditCrawls ? { ...values, target: project.domain, maxPages: 10 } : values;
      const [made] = await db.insert(table as typeof s.aiRuns).values(row as never).returning();
      await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("A check is still running.");
      await db.update(table as typeof s.aiRuns).set({ [since]: days(5) } as never).where(eq((table as typeof s.aiRuns).id, made.id));
      await deleteWorkspaceOp(scope, actor, "delete");
      expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
    }
  });

  it("lets a stuck check past the age limit through a project's delete too, and not a fresh one", async () => {
    const { project, ws, actor } = await seed();
    const scope = { workspaceId: ws.id, projectId: project.id };
    await db.update(s.projects).set({ archived: true }).where(eq(s.projects.id, project.id));
    const [row] = await db.insert(s.aiRuns).values({ ...scope, status: "running" }).returning();
    await expect(deleteProjectOp(scope, actor, "delete")).rejects.toThrow("still running");
    await db.update(s.aiRuns).set({ startedAt: new Date(Date.now() - 5 * 86_400_000) }).where(eq(s.aiRuns.id, row.id));
    await deleteProjectOp(scope, actor, "delete");
    expect(await db.$count(s.projects, eq(s.projects.id, project.id))).toBe(0);
  });

  it("refuses while a check is running, and calls nobody", async () => {
    const { ws, project, scope, actor } = await seed();
    await db.insert(s.aiRuns).values({ workspaceId: ws.id, projectId: project.id, status: "running" });
    await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("A check is still running.");
    expect(calls).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("changes nothing on a dry run", async () => {
    const { ws, scope, actor } = await seed();
    expect(await deleteWorkspaceOp(scope, actor, "delete", { dryRun: true })).toMatchObject({ dryRun: true, message: `Would delete ${ws.name}.` });
    expect(calls).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("says the provider's own words when its cancel fails", async () => {
    const { ws, scope, actor } = await seed();
    failure.current = { logTag: "Paywise", message: "Paywise couldn't confirm the cancel, so nothing was deleted." };
    cancel.mockRejectedValueOnce(new Error("provider down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("Paywise couldn't confirm the cancel, so nothing was deleted.");
      expect(logged).toHaveBeenCalledWith(`[workspace.delete] ${ws.id}: Paywise:`, expect.any(Error));
    } finally {
      failure.current = undefined;
      logged.mockRestore();
    }
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("keeps everything and its status when the provider can't confirm the cancel, and disconnects nothing", async () => {
    const { ws, scope, actor, user } = await seed();
    cancel.mockRejectedValueOnce(new Error("provider down"));
    await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("Your subscription couldn't be confirmed as cancelled, so nothing was deleted.");
    expect(google).not.toHaveBeenCalled();
    expect(await statusOf(ws.id)).toBe("active");
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, ws.id))).toBe(1);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
  });

  it("keeps everything when Google refuses, and a second try finishes", async () => {
    const { ws, scope, actor } = await seed();
    google.mockResolvedValueOnce({ ok: false, error: "google down" });
    await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow(rules.hasPlans ? "Any paid subscription is cancelled, but Google couldn't be disconnected, so nothing was deleted." : /^Google couldn't be disconnected, so nothing was deleted\./);
    expect(await statusOf(ws.id)).toBe("active");
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, ws.id))).toBe(1);
    expect((await deleteWorkspaceOp(scope, actor, "delete")).dryRun).toBe(false);
    expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
  });

  it("says so and keeps everything when the delete itself fails", async () => {
    const { ws, scope, actor, user } = await seed();
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database gone"));
    await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("deleting the data failed, so it's all still here");
    spy.mockRestore();
    expect(await statusOf(ws.id)).toBe("active");
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, ws.id))).toBe(1);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
  });

  it("puts a suspended workspace back to suspended when it fails", async () => {
    const { ws, scope, actor } = await seed();
    await db.update(s.workspaces).set({ status: "suspended" }).where(eq(s.workspaces.id, ws.id));
    posthog.mockResolvedValueOnce({ ok: false, error: "posthog down" });
    await expect(deleteWorkspaceOp(scope, actor, "delete")).rejects.toThrow("PostHog couldn't be disconnected");
    expect(await statusOf(ws.id)).toBe("suspended");
  });
});

describe.skipIf(!ready)("deleting from Admin", () => {
  const admin = randomUUID();
  const actor = { userId: admin, source: "app" as const };
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    isAdmin.mockImplementation(async (userId) => userId === admin);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const gone = async (user: { id: string }, ws: { id: number }) => {
    expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(0);
  };

  it("deletes someone else's workspace with its subscription, connections and account, and no other", async () => {
    const a = await seed();
    const b = await seed();
    expect(await accountsGoingWith(a.ws.id)).toEqual([a.user.email]);
    expect(await deleteWorkspaceAsAdminOp(a.ws.id, actor, "delete")).toEqual({ dryRun: false, accountRemoved: false, message: `Deleted ${a.ws.name}.` });
    expect(calls[0]).toBe("stripe");
    expect(calls.slice(1).sort()).toEqual(["google", "posthog"]);
    await gone(a.user, a.ws);
    expect(await statusOf(b.ws.id)).toBe("active");
    expect(await db.$count(s.users, eq(s.users.id, b.user.id))).toBe(1);
  });

  it("refuses anyone who isn't an admin, the workspace's own owner included, and an agent's key", async () => {
    const { user, ws } = await seed();
    for (const who of [{ userId: user.id, source: "app" as const }, { userId: admin, source: "mcp" as const }]) {
      await expect(deleteWorkspaceAsAdminOp(ws.id, who, "delete")).rejects.toThrow("Only an admin can do this.");
      await expect(deleteUserAsAdminOp(user.id, who, "delete")).rejects.toThrow("Only an admin can do this.");
    }
    expect(calls).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("refuses the owner's workspace, an unconfirmed delete and a running check", async () => {
    const { user, ws, project } = await seed();
    await expect(deleteWorkspaceAsAdminOp(OWNER_WORKSPACE_ID, actor, "delete")).rejects.toThrow("The owner's workspace can't be deleted.");
    await expect(deleteWorkspaceAsAdminOp(ws.id, actor, "")).rejects.toThrow("Type delete to confirm.");
    await expect(deleteUserAsAdminOp(user.id, actor, "")).rejects.toThrow("Type delete to confirm.");
    await db.insert(s.aiRuns).values({ workspaceId: ws.id, projectId: project.id, status: "running" });
    await expect(deleteWorkspaceAsAdminOp(ws.id, actor, "delete")).rejects.toThrow("A check is still running.");
    await expect(deleteUserAsAdminOp(user.id, actor, "delete")).rejects.toThrow(`A check is still running in ${ws.name}.`);
    expect(calls).toEqual([]);
    expect(await statusOf(ws.id)).toBe("active");
  });

  it("keeps everything when the cancel fails, in words for an admin", async () => {
    const { user, ws } = await seed();
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    cancel.mockRejectedValueOnce(new Error("provider down"));
    await expect(deleteUserAsAdminOp(user.id, actor, "delete")).rejects.toThrow("The workspace's subscription couldn't be confirmed as cancelled");
    expect(await statusOf(ws.id)).toBe("active");
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
  });

  it("deletes an account with every workspace it alone is in, through the same steps, and starts its inbox claim's wait", async () => {
    const { user, ws } = await seed();
    const [second] = await db.insert(s.workspaces).values({ name: `second-${randomUUID()}` }).returning();
    await db.insert(s.workspaceMembers).values({ workspaceId: second.id, userId: user.id, role: "owner" });
    await db.insert(s.signupClaims).values({ hash: `test-${randomUUID()}`, userId: user.id });
    await db.insert(s.waitlist).values({ email: user.email });
    expect((await userDeletion(user.id, admin)).workspaces.map((w) => w.id)).toEqual([ws.id, second.id]);
    expect(await deleteUserAsAdminOp(user.id, actor, "delete")).toEqual({ message: `Deleted ${user.email}.` });
    expect(calls.filter((c) => c === "stripe")).toHaveLength(2);
    await gone(user, ws);
    await gone(user, second);
    expect(await db.$count(s.waitlist, eq(s.waitlist.email, user.email))).toBe(0);
    const [claim] = await db.select().from(s.signupClaims).where(eq(s.signupClaims.userId, user.id));
    expect(claim.releasedAt).not.toBeNull();
  });

  it("deletes an account with no workspace, and one that is only a member of someone else's, which stays", async () => {
    const alone = await addUser();
    await deleteUserAsAdminOp(alone.id, actor, "delete");
    expect(await db.$count(s.users, eq(s.users.id, alone.id))).toBe(0);

    const { ws, user } = await seed();
    const member = await addUser();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: member.id, role: "member" });
    await deleteUserAsAdminOp(member.id, actor, "delete");
    expect(await db.$count(s.users, eq(s.users.id, member.id))).toBe(0);
    expect(await db.$count(s.users, eq(s.users.id, user.id))).toBe(1);
    expect(await statusOf(ws.id)).toBe("active");
    expect(calls).toEqual([]);
  });

  it("refuses the admin's own account, another admin, the owner workspace's owner and a workspace others are in", async () => {
    const self = await addUser();
    isAdmin.mockImplementation(async (userId) => userId === self.id || userId === admin);
    await expect(deleteUserAsAdminOp(self.id, { userId: self.id, source: "app" }, "delete")).rejects.toThrow("You can't delete your own account here.");
    await expect(deleteUserAsAdminOp(self.id, actor, "delete")).rejects.toThrow("This is an admin.");

    const owner = await addUser();
    await db.insert(s.workspaceMembers).values({ workspaceId: OWNER_WORKSPACE_ID, userId: owner.id, role: "owner" });
    await expect(deleteUserAsAdminOp(owner.id, actor, "delete")).rejects.toThrow("The owner's workspace can't be deleted.");
    await db.delete(s.users).where(eq(s.users.id, owner.id));

    const shared = await seed();
    const second = await addUser();
    await db.insert(s.workspaceMembers).values({ workspaceId: shared.ws.id, userId: second.id, role: "member" });
    await expect(deleteUserAsAdminOp(shared.user.id, actor, "delete")).rejects.toThrow(`Other people belong to ${shared.ws.name}.`);
    expect(await statusOf(shared.ws.id)).toBe("active");
    expect(calls).toEqual([]);
  });
});
