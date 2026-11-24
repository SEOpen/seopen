import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { OpError } from "@/lib/ops";

/**
 * A new workspace takes its zone from a member's browser, against seopen_test. Only the session is
 * mocked, so the action and the layout's check go through the real `currentWorkspace()`.
 */

const state = vi.hoisted(() => ({ userId: "", refreshes: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ id: state.userId }),
  getCurrentUser: async () => (state.userId ? { id: state.userId } : null),
}));
vi.mock("next/cache", () => ({
  refresh: () => {
    state.refreshes++;
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: () => {} }), headers: async () => new Headers() }));

const ready = await testDb();

// Imported after the mocks above.
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { workspaceTimeZone } = await import("@/lib/workspace");
const { applyBrowserTimeZoneOp, BROWSER_ZONE_FROM } = await import("./browser-time-zone");
const { timeZoneStillUnchosen } = await import("./current");
const { applyBrowserTimeZone, setTimeZone } = await import("@/app/actions/settings");

const NEW = new Date(BROWSER_ZONE_FROM.getTime() + 60_000);
const OLD = new Date(BROWSER_ZONE_FROM.getTime() - 60_000);
const NY = "America/New_York";

async function seedMember(createdAt = NEW) {
  const [ws] = await db.insert(s.workspaces).values({ name: `zone-${randomUUID()}`, createdAt }).returning();
  const userId = randomUUID();
  await db.insert(s.users).values({ id: userId, name: "Test", email: `${userId}@example.test`, emailVerified: true });
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId });
  return { scope: { workspaceId: ws.id }, actor: { userId, source: "app" as const } };
}

const row = async (workspaceId: number) => (await db.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, workspaceId)))[0];
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe.skipIf(!ready)("applyBrowserTimeZoneOp", () => {
  beforeEach(() => {
    state.userId = "";
    state.refreshes = 0;
  });

  it("starts a new workspace on the browser's zone, and dates read in it", async () => {
    const { scope, actor } = await seedMember();
    const result = await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo");
    expect(result).toMatchObject({ applied: true, timeZone: "Asia/Tokyo" });
    expect(await workspaceTimeZone(scope)).toBe("Asia/Tokyo");
  });

  it("stores the canonical name", async () => {
    const { scope, actor } = await seedMember();
    await applyBrowserTimeZoneOp(scope, actor, "asia/tokyo");
    expect((await row(scope.workspaceId)).timeZone).toBe("Asia/Tokyo");
  });

  it("refuses anything but a real IANA zone and writes nothing", async () => {
    const { scope, actor } = await seedMember();
    for (const zone of ["", "Mars/Olympus_Mons", "+05:00", "-08:00", "'; drop table workspaces; --"]) {
      await expect(applyBrowserTimeZoneOp(scope, actor, zone)).rejects.toBeInstanceOf(OpError);
    }
    expect(await row(scope.workspaceId)).toBeUndefined();
  });

  it("happens once: the second browser doesn't move it", async () => {
    const { scope, actor } = await seedMember();
    await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo");
    const second = await applyBrowserTimeZoneOp(scope, actor, "Europe/Paris");
    expect(second.applied).toBe(false);
    expect((await row(scope.workspaceId)).timeZone).toBe("Asia/Tokyo");
  });

  it("gives one zone to two browsers at once", async () => {
    const { scope, actor } = await seedMember();
    const results = await Promise.all([applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo"), applyBrowserTimeZoneOp(scope, actor, "Europe/Paris")]);
    const winners = results.filter((r) => r.applied);
    expect(winners).toHaveLength(1);
    expect((await row(scope.workspaceId)).timeZone).toBe(winners[0].timeZone);
  });

  it("never overrides a saved zone", async () => {
    const { scope, actor } = await seedMember();
    state.userId = actor.userId;
    await setTimeZone(form({ timeZone: "Europe/London" }));
    expect((await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo")).applied).toBe(false);
    expect((await row(scope.workspaceId)).timeZone).toBe("Europe/London");
  });

  it("never overrides someone deliberately saving the default zone", async () => {
    const { scope, actor } = await seedMember();
    state.userId = actor.userId;
    await setTimeZone(form({ timeZone: NY }));
    expect((await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo")).applied).toBe(false);
    expect(await workspaceTimeZone(scope)).toBe(NY);
    expect(await timeZoneStillUnchosen()).toBe(false);
  });

  it("leaves a workspace with a settings row for something else on its zone", async () => {
    const { scope, actor } = await seedMember();
    state.userId = actor.userId;
    await db.insert(s.workspaceSettings).values({ workspaceId: scope.workspaceId, monthlyCapUsd: 25 });
    expect((await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo")).applied).toBe(false);
    expect(await workspaceTimeZone(scope)).toBe(NY);
  });

  it("doesn't change an existing workspace, even one that never saved a setting", async () => {
    const { scope, actor } = await seedMember(OLD);
    expect((await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo")).applied).toBe(false);
    expect(await row(scope.workspaceId)).toBeUndefined();
    expect(await workspaceTimeZone(scope)).toBe(NY);
  });

  it("refuses someone who isn't a member, including a member of another workspace", async () => {
    const target = await seedMember();
    const outsider = await seedMember();
    await expect(applyBrowserTimeZoneOp(target.scope, outsider.actor, "Asia/Tokyo")).rejects.toThrow("member");
    await expect(applyBrowserTimeZoneOp(target.scope, { userId: randomUUID(), source: "app" }, "Asia/Tokyo")).rejects.toThrow("member");
    expect(await row(target.scope.workspaceId)).toBeUndefined();
    expect(await row(outsider.scope.workspaceId)).toBeUndefined();
  });

  it("only describes the change on a dry run", async () => {
    const { scope, actor } = await seedMember();
    const result = await applyBrowserTimeZoneOp(scope, actor, "Asia/Tokyo", { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, applied: false });
    expect(result.message).toContain("Asia/Tokyo");
    expect(await row(scope.workspaceId)).toBeUndefined();
  });
});

describe.skipIf(!ready)("applyBrowserTimeZone", () => {
  beforeEach(() => {
    state.userId = "";
    state.refreshes = 0;
  });

  it("sets the signed-in member's own workspace and refreshes the page once", async () => {
    const mine = await seedMember();
    const other = await seedMember();
    state.userId = mine.actor.userId;
    await applyBrowserTimeZone("Asia/Tokyo");
    expect(await workspaceTimeZone(mine.scope)).toBe("Asia/Tokyo");
    expect(await row(other.scope.workspaceId)).toBeUndefined();
    expect(state.refreshes).toBe(1);
    // Nothing is left to do, so another send doesn't refresh: this can't loop.
    await applyBrowserTimeZone("Europe/Paris");
    expect(await workspaceTimeZone(mine.scope)).toBe("Asia/Tokyo");
    expect(state.refreshes).toBe(1);
  });

  it("doesn't refresh when the zone is the one already showing, and it's settled from then on", async () => {
    const { actor } = await seedMember();
    state.userId = actor.userId;
    await applyBrowserTimeZone(NY);
    expect(state.refreshes).toBe(0);
    expect(await timeZoneStillUnchosen()).toBe(false);
  });

  it("stays quiet on a zone it refuses", async () => {
    const { scope, actor } = await seedMember();
    state.userId = actor.userId;
    await expect(applyBrowserTimeZone("Mars/Olympus_Mons")).resolves.toBeUndefined();
    expect(state.refreshes).toBe(0);
    expect(await row(scope.workspaceId)).toBeUndefined();
  });
});

describe.skipIf(!ready)("timeZoneStillUnchosen", () => {
  it("is true only for a new workspace nobody has set", async () => {
    const fresh = await seedMember();
    state.userId = fresh.actor.userId;
    expect(await timeZoneStillUnchosen()).toBe(true);
    await applyBrowserTimeZoneOp(fresh.scope, fresh.actor, "Asia/Tokyo");
    expect(await timeZoneStillUnchosen()).toBe(false);

    const old = await seedMember(OLD);
    state.userId = old.actor.userId;
    expect(await timeZoneStillUnchosen()).toBe(false);
  });

  it("is false signed out, and for an account with no workspace, without throwing", async () => {
    state.userId = "";
    expect(await timeZoneStillUnchosen()).toBe(false);
    state.userId = randomUUID();
    expect(await timeZoneStillUnchosen()).toBe(false);
  });
});
