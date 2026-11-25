import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Leaving a source, against seopen_test: it works with the account already disconnected, and the page says the account is gone. Every number is made up. */

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
  return { currentWorkspace, workspaceScope: async () => ({ workspaceId: (await currentWorkspace()).id }), currentTimeZone: async () => "UTC" };
});
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test.apps.googleusercontent.example";
process.env.GOOGLE_CLIENT_SECRET = "test";
delete process.env.SEOPEN_GOOGLE_FIXTURES;
delete process.env.SEOPEN_POSTHOG_FIXTURES;

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { stopUsingGoogle } = await import("./actions");
const { saveAccount } = await import("./auth");
const { ConnectionPanel, getConnection, SyncStatus } = await import("./ui/status");
const { setPosthogProject } = await import("@/modules/posthog/actions");

async function seed(set: { gscProperty?: string; ga4Property?: string; posthogProject?: string }) {
  const [ws] = await db.insert(s.workspaces).values({ name: `stop-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: "Alphanote", domain: `alphanote-${ws.id}.example`, ...set })
    .returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-01", clicks: 2, impressions: 9, ctr: 0.2, position: 4 });
  await db.insert(s.ga4LandingDaily).values({ ...scope, date: "2026-10-01", hostName: "a.example", landingPage: "/", sessions: 3, engagedSessions: 1, keyEvents: 1, totalRevenue: 0 });
  for (const [source, property] of [["gsc", set.gscProperty], ["ga4", set.ga4Property], ["posthog", set.posthogProject]] as const) {
    if (property) await db.insert(s.googleSyncState).values({ ...scope, source, property, status: "ok", message: "Up to date" });
  }
  state.ws = ws.id;
  return { ws, project, scope };
}

const reload = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0];
const rows = async (scope: { workspaceId: number; projectId: number }) => ({
  gsc: (await db.select().from(s.gscDaily).where(and(eq(s.gscDaily.workspaceId, scope.workspaceId), eq(s.gscDaily.projectId, scope.projectId)))).length,
  analytics: (await db.select().from(s.ga4LandingDaily).where(and(eq(s.ga4LandingDaily.workspaceId, scope.workspaceId), eq(s.ga4LandingDaily.projectId, scope.projectId)))).length,
});
const syncHtml = async (id: number) => renderToStaticMarkup(await SyncStatus({ project: await reload(id) }));
const both = { gscProperty: "sc-domain:alphanote.example", ga4Property: "properties/1" };

describe.skipIf(!ready)("stopping a source", () => {
  it("unlinks one Google source with the account disconnected, deletes its rows and leaves the other", async () => {
    const { project, scope } = await seed(both);
    await stopUsingGoogle(project.id, "ga4");
    expect(await reload(project.id)).toMatchObject({ gscProperty: both.gscProperty, ga4Property: null });
    expect(await rows(scope)).toEqual({ gsc: 1, analytics: 0 });
    await stopUsingGoogle(project.id, "gsc");
    expect(await reload(project.id)).toMatchObject({ gscProperty: null });
    expect(await rows(scope)).toEqual({ gsc: 0, analytics: 0 });
    expect(await db.select().from(s.googleSyncState).where(eq(s.googleSyncState.projectId, project.id))).toEqual([]);
  });

  it("keeps the rows of a project that has since moved its Analytics to PostHog", async () => {
    const { project, scope } = await seed({ posthogProject: "2001" });
    await stopUsingGoogle(project.id, "ga4");
    expect(await rows(scope)).toEqual({ gsc: 1, analytics: 1 });
    expect(await reload(project.id)).toMatchObject({ posthogProject: "2001" });
  });

  it("won't touch another workspace's project, or a source it doesn't know", async () => {
    const other = await seed(both);
    const mine = await seed(both);
    await expect(stopUsingGoogle(other.project.id, "ga4")).rejects.toThrow();
    await expect(stopUsingGoogle(mine.project.id, "all" as "ga4")).rejects.toThrow();
    expect(await reload(other.project.id)).toMatchObject(both);
    expect(await reload(mine.project.id)).toMatchObject(both);
  });

  it("stops PostHog with the account disconnected", async () => {
    const { project, scope } = await seed({ posthogProject: "2001" });
    const form = new FormData();
    form.set("posthogProject", "");
    await setPosthogProject(project.id, form);
    expect(await reload(project.id)).toMatchObject({ posthogProject: null });
    expect((await rows(scope)).analytics).toBe(0);
  });
});

describe.skipIf(!ready)("the Sync rows", () => {
  it("say Disconnected for both Google sources, whatever the last sync said, and offer to stop each", async () => {
    const { project } = await seed(both);
    const html = await syncHtml(project.id);
    expect(html.match(/Disconnected/g)).toHaveLength(2);
    expect(html).not.toContain("Up to date");
    expect(html).not.toContain("Sync now");
    expect(html).toContain("Stop using Search Console for Alphanote");
    expect(html).toContain("Stop using GA4 for Alphanote");
  });

  it("say Disconnected for PostHog alone when Google is still connected", async () => {
    const { ws, project } = await seed({ gscProperty: both.gscProperty, posthogProject: "2001" });
    await saveAccount(ws.id, { email: "pat@example.com", googleSub: randomUUID(), refreshToken: "token", scopes: [] });
    const html = await syncHtml(project.id);
    expect(html.match(/Disconnected/g)).toHaveLength(1);
    expect(html).toContain("Up to date");
    expect(html).toContain("Sync now");
    expect(html).toContain("Stop using PostHog for Alphanote");
  });

  it("offer nothing to stop for a source the project doesn't use", async () => {
    const { project } = await seed({ gscProperty: both.gscProperty });
    const html = await syncHtml(project.id);
    expect(html).toContain("Stop using Search Console for Alphanote");
    expect(html).not.toContain("Stop using GA4");
  });
});

describe.skipIf(!ready)("the Google panel", () => {
  it("names both sources when it connects and when it disconnects", async () => {
    const { ws } = await seed(both);
    expect(renderToStaticMarkup(await ConnectionPanel({ connection: await getConnection(), sp: {} }))).toContain("Connect Search Console and Analytics");
    await saveAccount(ws.id, { email: "pat@example.com", googleSub: randomUUID(), refreshToken: "token", scopes: [] });
    expect(renderToStaticMarkup(await ConnectionPanel({ connection: await getConnection(), sp: {} }))).toContain("Disconnect both");
  });
});
