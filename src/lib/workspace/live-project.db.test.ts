import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(), getCurrentUser: vi.fn() }));

const ready = await testDb();

// Imported after the mocks above.
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { isLiveProject } = await import("./current");

async function seedProject(workspaceId: number, archived = false) {
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId, name: `site ${randomUUID()}`, domain: `${randomUUID()}.example`, archived })
    .returning();
  return project.id;
}

async function seedWorkspace() {
  const [ws] = await db.insert(s.workspaces).values({ name: `live-${randomUUID()}`, plan: "internal" }).returning();
  return ws.id;
}

async function seedUser(...workspaceIds: number[]) {
  const id = randomUUID();
  await db.insert(s.users).values({ id, name: "Test", email: `${id}@example.test`, emailVerified: true });
  for (const [i, workspaceId] of workspaceIds.entries()) {
    await db.insert(s.workspaceMembers).values({ workspaceId, userId: id, createdAt: new Date(2026, 0, i + 1) });
  }
  return id;
}

describe.skipIf(!ready)("isLiveProject", () => {
  let mine: number;
  let other: number;
  let user: string;

  beforeAll(async () => {
    mine = await seedWorkspace();
    other = await seedWorkspace();
    user = await seedUser(mine);
  });

  it("is true for an unarchived project of the account's workspace", async () => {
    expect(await isLiveProject(user, await seedProject(mine))).toBe(true);
  });

  it("is false for an archived project", async () => {
    expect(await isLiveProject(user, await seedProject(mine, true))).toBe(false);
  });

  it("is false for another workspace's project", async () => {
    expect(await isLiveProject(user, await seedProject(other))).toBe(false);
  });

  it("is false for a project that doesn't exist, without asking Postgres about a number it would refuse", async () => {
    expect(await isLiveProject(user, 2_147_483_647)).toBe(false);
    expect(await isLiveProject(user, 2_147_483_648)).toBe(false);
    expect(await isLiveProject(user, 99_999_999_999_999_999_999)).toBe(false);
    expect(await isLiveProject(user, 0)).toBe(false);
    expect(await isLiveProject(user, Number.NaN)).toBe(false);
  });

  it("is false for an account with no workspace", async () => {
    expect(await isLiveProject(await seedUser(), await seedProject(mine))).toBe(false);
  });

  it("goes by the oldest membership, as currentWorkspace does", async () => {
    const both = await seedUser(mine, other);
    expect(await isLiveProject(both, await seedProject(mine))).toBe(true);
    expect(await isLiveProject(both, await seedProject(other))).toBe(false);
  });
});
