import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Admin access against seopen_test: with no list the owner workspace's members are the admins;
 * adding an address makes the account (with its own workspace) and emails a password link; the
 * list then decides alone; and the last admin can't be removed. The overview queries run too.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }) => void sent.push(msg),
}));

const ready = await testDb();

const { db } = await import("@/db");
const { settings, users, workspaceMembers, workspaces } = await import("@/db/schema");
const { ADMINS_SETTING_KEY, addAdmin, adminUserIds, isAdmin, removeAdmin } = await import("./access");
const { accountCount, dailyActivity, OVERVIEW_DAYS } = await import("./overview");
const { OWNER_WORKSPACE_ID } = await import("@/lib/workspace");

const email = () => `admin-${randomUUID().slice(0, 8)}@example.com`;
const clearList = () => db.delete(settings).where(eq(settings.key, ADMINS_SETTING_KEY));

async function user(address = email()) {
  const [row] = await db.insert(users).values({ id: randomUUID(), email: address, name: "" }).returning();
  return row;
}

describe.skipIf(!ready)("admin access", () => {
  beforeEach(async () => {
    sent.length = 0;
    await clearList();
  });
  afterAll(clearList);

  it("falls back to the owner workspace's members while the list is empty", async () => {
    await db.insert(workspaces).values({ id: OWNER_WORKSPACE_ID, name: "Owner", plan: "internal" }).onConflictDoNothing();
    const owner = await user();
    const stranger = await user();
    await db.insert(workspaceMembers).values({ workspaceId: OWNER_WORKSPACE_ID, userId: owner.id, role: "owner" });
    expect(await isAdmin(owner.id)).toBe(true);
    expect(await isAdmin(stranger.id)).toBe(false);
  });

  it("adds a new address as an account with its own workspace and emails a link", async () => {
    const address = email();
    const result = await addAdmin(`  ${address.toUpperCase()} `);
    expect(result).toEqual({ ok: true, message: `${address} is an admin. We emailed a link to choose a password.` });

    const [u] = await db.select().from(users).where(eq(users.email, address));
    expect(u.emailVerified).toBe(true);
    const members = await db.select({ ws: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, u.id));
    expect(members).toHaveLength(1);
    expect(members[0].ws.id).not.toBe(OWNER_WORKSPACE_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(address);
    expect(sent[0].subject).toBe("Your SEOpen admin account");
    expect(sent[0].text).toMatch(/\/reset-password\?token=[\w-]+&invite=1/);
    expect(await adminUserIds()).toEqual([u.id]);
  });

  it("lets the list decide once anyone is on it", async () => {
    await db.insert(workspaces).values({ id: OWNER_WORKSPACE_ID, name: "Owner", plan: "internal" }).onConflictDoNothing();
    const owner = await user();
    await db.insert(workspaceMembers).values({ workspaceId: OWNER_WORKSPACE_ID, userId: owner.id, role: "owner" });
    const address = email();
    await addAdmin(address);
    const [added] = await db.select().from(users).where(eq(users.email, address));
    expect(await isAdmin(added.id)).toBe(true);
    expect(await isAdmin(owner.id)).toBe(false);
  });

  it("refuses a bad address, and adding twice keeps one entry", async () => {
    expect(await addAdmin("not an email")).toEqual({ ok: false, message: "That email address doesn't look right." });
    const address = email();
    await addAdmin(address);
    await addAdmin(address);
    expect(await adminUserIds()).toHaveLength(1);
  });

  it("won't adopt an unconfirmed sign-up, but takes the account once it's confirmed", async () => {
    const address = email();
    const squat = await user(address);
    const result = await addAdmin(address);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/hasn't confirmed its email/);
    expect(await isAdmin(squat.id)).toBe(false);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, squat.id))).toEqual([]);

    await db.update(users).set({ emailVerified: true }).where(eq(users.id, squat.id));
    expect((await addAdmin(address)).ok).toBe(true);
    expect(await isAdmin(squat.id)).toBe(true);
  });

  it("removes an admin but never the last one", async () => {
    const a = email();
    const b = email();
    await addAdmin(a);
    await addAdmin(b);
    const [ua] = await db.select().from(users).where(eq(users.email, a));
    const [ub] = await db.select().from(users).where(eq(users.email, b));
    expect((await removeAdmin(ua.id)).ok).toBe(true);
    expect(await removeAdmin(ub.id)).toEqual({ ok: false, message: "That's the last admin. Add another admin first." });
    expect(await adminUserIds()).toEqual([ub.id]);
  });

  it("runs the overview queries", async () => {
    const days = await dailyActivity();
    expect(days).toHaveLength(OVERVIEW_DAYS);
    expect(days.at(-1)!.accounts).toBeGreaterThan(0);
    expect(await accountCount()).toBeGreaterThan(0);
  });
});
