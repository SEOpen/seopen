import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * PostHog as an Analytics source, against seopen_test: the sync fills the table GA4 uses, a
 * project maps one source at a time, and an expiring token refreshes (or asks to reconnect).
 */

const state = vi.hoisted(() => ({ ws: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "test-user" }), getCurrentUser: async () => ({ id: "test-user" }) }));
vi.mock("@/lib/workspace/current", async () => {
  const { db } = await import("@/db");
  const { workspaces } = await import("@/db/schema");
  const { eq: eqOp } = await import("drizzle-orm");
  const currentWorkspace = async () => {
    const [ws] = await db.select().from(workspaces).where(eqOp(workspaces.id, state.ws));
    if (!ws) throw new Error("no workspace");
    return ws;
  };
  return { currentWorkspace, workspaceScope: async () => ({ workspaceId: (await currentWorkspace()).id }) };
});
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.SEOPEN_POSTHOG_FIXTURES = "1";
process.env.SEOPEN_GOOGLE_FIXTURES = "1";

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { syncPosthog, getPosthogSyncState } = await import("./sync");
const { fixturePosthogApis } = await import("./api");
const { setPosthogProject } = await import("./actions");
const { posthogAccessToken, savePosthogAccount } = await import("./account");
const { setProjectProperties } = await import("@/modules/google/actions");

async function seed(set: { ga4Property?: string; posthogProject?: string } = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `posthog-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: "Alphanote", domain: `alphanote-${ws.id}.example`, ...set })
    .returning();
  state.ws = ws.id;
  return { ws, project, scope: { workspaceId: ws.id, projectId: project.id } };
}

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};

const landingRows = (scope: { workspaceId: number; projectId: number }) =>
  db.select().from(s.ga4LandingDaily).where(and(eq(s.ga4LandingDaily.workspaceId, scope.workspaceId), eq(s.ga4LandingDaily.projectId, scope.projectId)));

const projectRow = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0];

describe.skipIf(!ready)("PostHog analytics source", () => {
  beforeEach(() => {
    process.env.SEOPEN_POSTHOG_FIXTURES = "1";
  });

  it("syncs organic landing pages into the shared Analytics table", async () => {
    const { scope } = await seed({ posthogProject: "2001" });
    const r = await syncPosthog(scope, fixturePosthogApis);
    expect(r.more).toBe(true);
    const rows = await landingRows(scope);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.keyEvents === 0 && x.totalRevenue === 0)).toBe(true);
    const st = await getPosthogSyncState(scope);
    expect(st).toMatchObject({ source: "posthog", property: "2001", status: "ok" });
    expect(st?.backfillCursor).toBeTruthy();
  });

  it("does nothing for a project without a PostHog mapping", async () => {
    const { scope } = await seed();
    expect(await syncPosthog(scope, fixturePosthogApis)).toEqual({ more: false, skipped: "no PostHog project mapped" });
  });

  it("choosing PostHog replaces GA4 and its rows", async () => {
    const { project, scope } = await seed({ ga4Property: "properties/1000001" });
    await db.insert(s.ga4LandingDaily).values({ ...scope, date: "2026-10-01", hostName: "a.example", landingPage: "/", sessions: 3, engagedSessions: 1, keyEvents: 1, totalRevenue: 0 });
    await setPosthogProject(project.id, form({ posthogProject: "2002" }));
    expect(await projectRow(project.id)).toMatchObject({ posthogProject: "2002", ga4Property: null });
    expect(await landingRows(scope)).toEqual([]);
  });

  it("refuses a PostHog project the connection can't see", async () => {
    const { project } = await seed();
    await expect(setPosthogProject(project.id, form({ posthogProject: "999999" }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace/) });
    expect((await projectRow(project.id)).posthogProject).toBeNull();
  });

  it("choosing a GA4 property drops the PostHog mapping", async () => {
    const { project } = await seed({ posthogProject: "2001" });
    await setProjectProperties(project.id, form({ gscProperty: "", ga4Property: "properties/1000001" }));
    expect(await projectRow(project.id)).toMatchObject({ posthogProject: null, ga4Property: "properties/1000001" });
  });

  it("refreshes an expiring token, and asks to reconnect when the refresh is refused", async () => {
    process.env.SEOPEN_POSTHOG_FIXTURES = "0";
    const { ws } = await seed();
    await savePosthogAccount(ws.id, "eu", { access_token: "pha_old", refresh_token: "phr_old", expires_in: 30, scope: "project:read query:read", scoped_teams: [5] });

    const ok = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://eu.posthog.com/oauth/token/");
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("phr_old");
      return new Response(JSON.stringify({ access_token: "pha_new", expires_in: 36000 }), { status: 200 });
    }) as unknown as typeof fetch;
    const fresh = await posthogAccessToken(ws.id, ok);
    expect(fresh.token).toBe("pha_new");
    // Still fresh: no second refresh.
    expect((await posthogAccessToken(ws.id, ok)).token).toBe("pha_new");
    expect(ok).toHaveBeenCalledOnce();

    await db.update(s.posthogAccounts).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(s.posthogAccounts.workspaceId, ws.id));
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(posthogAccessToken(ws.id, refused)).rejects.toThrow(/reconnecting/);
    const [acct] = await db.select().from(s.posthogAccounts).where(eq(s.posthogAccounts.workspaceId, ws.id));
    expect(acct).toMatchObject({ status: "reauth_required", scopedTeams: [5], region: "eu" });
  });
});
