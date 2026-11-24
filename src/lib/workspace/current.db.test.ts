import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";
import { deleteWorkspaceDescription } from "./delete-copy";

/** Where an account with no workspace goes, against seopen_test: an admin's lands in Admin, anyone else's is refused. */

vi.mock("server-only", () => ({}));
const signedIn = vi.hoisted(() => ({ id: "" }));
const isAdmin = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: signedIn.id }), getCurrentUser: async () => ({ id: signedIn.id }) }));
vi.mock("@/lib/admin/access", () => ({ isAdmin }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { currentWorkspace } = await import("./current");

async function seedUser(withWorkspace: boolean) {
  const id = randomUUID();
  await db.insert(s.users).values({ id, name: "Test", email: `${id}@example.test`, emailVerified: true });
  if (withWorkspace) {
    const [ws] = await db.insert(s.workspaces).values({ name: `current-${randomUUID()}` }).returning();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: id, role: "owner" });
    return { id, workspaceId: ws.id };
  }
  return { id, workspaceId: null };
}

describe.skipIf(!ready)("currentWorkspace for an account with no workspace", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(false);
  });

  it("sends an admin to Admin, as after deleting their only workspace", async () => {
    signedIn.id = (await seedUser(false)).id;
    isAdmin.mockResolvedValue(true);
    await expect(currentWorkspace()).rejects.toThrow("redirect /admin");
  });

  it("still refuses anyone else, and never falls back to another workspace", async () => {
    signedIn.id = (await seedUser(false)).id;
    await expect(currentWorkspace()).rejects.toThrow("This account isn't a member of any workspace yet.");
  });

  it("doesn't resolve a membership with a role nothing enforces yet", async () => {
    const user = await seedUser(true);
    signedIn.id = user.id;
    await db.update(s.workspaceMembers).set({ role: "member" }).where(eq(s.workspaceMembers.userId, user.id));
    await expect(currentWorkspace()).rejects.toThrow("This account isn't a member of any workspace yet.");
  });

  it("gives an admin with a workspace that workspace", async () => {
    const user = await seedUser(true);
    signedIn.id = user.id;
    isAdmin.mockResolvedValue(true);
    expect((await currentWorkspace()).id).toBe(user.workspaceId);
  });
});

describe("the Delete this workspace card", () => {
  it("tells an admin their account stays, and where they'll land", () => {
    const copy = deleteWorkspaceDescription(true);
    expect(copy).toContain("Your account stays");
    expect(copy).toContain("Admin");
    expect(copy).not.toContain("your account goes too");
  });

  it("tells anyone else their account goes with their only workspace", () => {
    expect(deleteWorkspaceDescription(false)).toContain("If this is your only workspace, your account goes too.");
  });

  it("says any paid subscription is cancelled on getseopen.com, and names none without plans", () => {
    const copy = deleteWorkspaceDescription(false);
    if (rules.hasPlans) expect(copy).toMatch(/^This deletes every project and report, disconnects Google and PostHog, and cancels any paid subscription straight away\. /);
    else {
      expect(copy).toMatch(/^This deletes every project and report and disconnects Google and PostHog straight away\. /);
      expect(copy).not.toMatch(/subscription|plan/i);
    }
  });
});
