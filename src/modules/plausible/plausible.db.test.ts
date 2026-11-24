import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Plausible as an Analytics source, against seopen_test with faked Plausible responses: a checked
 * key is stored encrypted, the sync fills the table the other sources use, and a project maps one
 * source at a time. Every site and number here is made up.
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
process.env.SEOPEN_GOOGLE_FIXTURES = "1";
process.env.SEOPEN_POSTHOG_FIXTURES = "1";

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { decrypt } = await import("@/lib/crypto");
const { connectionProblems, syncProblems } = await import("@/lib/admin/health");
const { connectPlausible, disconnectPlausible, setPlausibleSite } = await import("./actions");
const { getPlausibleConnectionInfo, savePlausibleAccount } = await import("./account");
const { fixturePlausibleApis } = await import("./api");
const { forgetPlausibleSites } = await import("./sites");
const { getPlausibleSyncState, syncPlausible } = await import("./sync");
const { setPosthogProject } = await import("@/modules/posthog/actions");
const { setProjectProperties, syncNow } = await import("@/modules/google/actions");
const { enqueue } = await import("@/lib/jobs/boss");

const KEY = "made-up-stats-key-456";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Plausible that knows one site, with one made-up row per query. */
function stubPlausible(over: { status?: number } = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (over.status) return json({ error: `Refused ${KEY}` }, over.status);
    const { pathname } = new URL(String(input));
    if (pathname === "/api/v1/sites") return json({ sites: [{ domain: "made-up.example", timezone: "UTC" }], meta: { after: null } });
    if (pathname === "/api/v1/sites/made-up.example") return json({ domain: "made-up.example", timezone: "UTC" });
    if (pathname === "/api/v2/query") {
      const body = JSON.parse(String(init?.body)) as { dimensions?: string[]; date_range: string | string[] };
      const day = Array.isArray(body.date_range) ? body.date_range[0] : "";
      return json({ results: body.dimensions ? [{ dimensions: [day, "made-up.example", "/pricing"], metrics: [10, 40] }] : [{ dimensions: [], metrics: [10] }] });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed(set: { ga4Property?: string; posthogProject?: string; plausibleSite?: string } = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `plausible-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: "Made Up", domain: `made-up-${ws.id}.example`, ...set })
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

const accountRow = async (workspaceId: number) => (await db.select().from(s.plausibleAccounts).where(eq(s.plausibleAccounts.workspaceId, workspaceId)))[0];
const projectRow = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0];

describe.skipIf(!ready)("Plausible analytics source", () => {
  beforeEach(() => {
    process.env.SEOPEN_PLAUSIBLE_FIXTURES = "0";
    vi.mocked(enqueue).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPlausibleSites(state.ws);
  });

  describe("connecting", () => {
    it("stores a key Plausible accepted, encrypted, and says nothing of it", async () => {
      const { ws } = await seed();
      const fetchMock = stubPlausible();
      await expect(connectPlausible(form({ plausibleKey: `  ${KEY}  ` }))).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
      const row = await accountRow(ws.id);
      expect(row.apiKeyEnc).not.toContain(KEY);
      expect(decrypt(row.apiKeyEnc)).toBe(KEY);
      expect(row.status).toBe("active");
      expect(Object.keys((await getPlausibleConnectionInfo(ws.id))!)).not.toContain("apiKeyEnc");
    });

    it("stores nothing when Plausible refuses, and answers in plain words without the key", async () => {
      const { ws } = await seed();
      stubPlausible({ status: 401 });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await connectPlausible(form({ plausibleKey: KEY }));
      expect(res).toEqual({ error: expect.stringMatching(/didn't accept that key/) });
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
      expect(await accountRow(ws.id)).toBeUndefined();
      log.mockRestore();
    });

    it("asks for a key when none was pasted, without calling Plausible", async () => {
      await seed();
      const fetchMock = stubPlausible();
      expect(await connectPlausible(form({ plausibleKey: "   " }))).toEqual({ error: "Paste your Plausible Stats API key." });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("replaces the workspace's key on a second connect, keeping one row", async () => {
      const { ws } = await seed();
      stubPlausible();
      await connectPlausible(form({ plausibleKey: "made-up-first-key" }));
      await connectPlausible(form({ plausibleKey: "made-up-second-key" }));
      expect(await db.$count(s.plausibleAccounts, eq(s.plausibleAccounts.workspaceId, ws.id))).toBe(1);
      expect(decrypt((await accountRow(ws.id)).apiKeyEnc)).toBe("made-up-second-key");
    });

    it("deletes the key on disconnect, and the next sync says to reconnect", async () => {
      const { ws, scope } = await seed({ plausibleSite: "made-up.example" });
      await savePlausibleAccount(ws.id, KEY);
      await disconnectPlausible();
      expect(await accountRow(ws.id)).toBeUndefined();
      await expect(syncPlausible(scope)).rejects.toThrow(/not connected/);
      expect(await getPlausibleSyncState(scope)).toMatchObject({ status: "reauth", message: "Plausible is not connected." });
    });
  });

  describe("syncing", () => {
    it("fills the shared Analytics table from faked responses, in pages of real rows", async () => {
      const { ws, scope } = await seed({ plausibleSite: "made-up.example" });
      await savePlausibleAccount(ws.id, KEY);
      const fetchMock = stubPlausible();
      const r = await syncPlausible(scope);
      expect(r.more).toBe(true);
      const rows = await landingRows(scope);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ hostName: "made-up.example", landingPage: "/pricing", sessions: 10, engagedSessions: 6, keyEvents: 0, totalRevenue: 0 });
      const st = await getPlausibleSyncState(scope);
      expect(st).toMatchObject({ source: "plausible", property: "made-up.example", status: "ok" });
      for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    });

    it("fills it from fixtures in development", async () => {
      process.env.SEOPEN_PLAUSIBLE_FIXTURES = "1";
      const { scope } = await seed({ plausibleSite: "alphanote.example" });
      expect((await syncPlausible(scope, fixturePlausibleApis)).more).toBe(true);
      expect((await landingRows(scope)).length).toBeGreaterThan(0);
    });

    it("does nothing for a project without a Plausible site", async () => {
      const { scope } = await seed();
      expect(await syncPlausible(scope, fixturePlausibleApis)).toEqual({ more: false, skipped: "no Plausible site mapped" });
    });

    it("shows a failure in Admin, Health, with the key taken out of the error", async () => {
      const { ws, scope } = await seed({ plausibleSite: "made-up.example" });
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible({ status: 500 });
      await expect(syncPlausible(scope)).rejects.toThrow(/Plausible API error 500/);
      const st = await getPlausibleSyncState(scope);
      expect(st).toMatchObject({ status: "error" });
      expect(st?.lastError).not.toContain(KEY);
      expect(await syncProblems(ws.id)).toEqual([expect.objectContaining({ source: "plausible", sourceLabel: "Plausible", kind: "error" })]);
    });

    it("backs off on a rate limit and keeps the sync alive", async () => {
      const { ws, scope } = await seed({ plausibleSite: "made-up.example" });
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible({ status: 429 });
      expect(await syncPlausible(scope)).toEqual({ more: true, retryAfterSeconds: 15 * 60 });
      expect(await getPlausibleSyncState(scope)).toMatchObject({ status: "quota" });
    });

    it("flips a key Plausible stopped accepting to reconnect, in the panel and in Admin", async () => {
      const { ws, scope } = await seed({ plausibleSite: "made-up.example" });
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible({ status: 401 });
      await expect(syncPlausible(scope)).rejects.toThrow(/reconnecting/);
      expect(await accountRow(ws.id)).toMatchObject({ status: "reauth_required" });
      expect(await getPlausibleSyncState(scope)).toMatchObject({ status: "reauth", message: "Plausible needs reconnecting." });
      expect(await connectionProblems(ws.id)).toEqual([expect.objectContaining({ service: "Plausible", account: "Plausible Cloud", status: "reauth_required" })]);
      // Its message shows no key, and neither do the problems Admin lists.
      expect(JSON.stringify(await connectionProblems(ws.id))).not.toContain(KEY);
    });
  });

  describe("one source at a time", () => {
    it("choosing Plausible replaces GA4 and its rows, and queues the first sync", async () => {
      const { ws, project, scope } = await seed({ ga4Property: "properties/1000001" });
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible();
      await db.insert(s.ga4LandingDaily).values({ ...scope, date: "2026-10-01", hostName: "a.example", landingPage: "/", sessions: 3, engagedSessions: 1, keyEvents: 1, totalRevenue: 0 });
      await setPlausibleSite(project.id, form({ plausibleSite: "made-up.example" }));
      expect(await projectRow(project.id)).toMatchObject({ plausibleSite: "made-up.example", ga4Property: null, posthogProject: null });
      expect(await landingRows(scope)).toEqual([]);
      expect(enqueue).toHaveBeenCalledWith("plausible.sync", scope, { singletonKey: `project:${project.id}` });
    });

    it("choosing Plausible replaces PostHog and its sync state", async () => {
      const { ws, project, scope } = await seed({ posthogProject: "2001" });
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible();
      await db.insert(s.googleSyncState).values({ ...scope, source: "posthog", property: "2001", backfillStart: "2026-01-01" });
      await setPlausibleSite(project.id, form({ plausibleSite: "made-up.example" }));
      expect(await projectRow(project.id)).toMatchObject({ plausibleSite: "made-up.example", posthogProject: null });
      expect(await db.$count(s.googleSyncState, and(eq(s.googleSyncState.projectId, project.id), eq(s.googleSyncState.source, "posthog")))).toBe(0);
    });

    it("refuses a site the key can't read", async () => {
      const { ws, project } = await seed();
      await savePlausibleAccount(ws.id, KEY);
      stubPlausible();
      await expect(setPlausibleSite(project.id, form({ plausibleSite: "someone-elses.example" }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace/) });
      expect((await projectRow(project.id)).plausibleSite).toBeNull();
    });

    it("refuses any site with no connection", async () => {
      const { project } = await seed();
      await expect(setPlausibleSite(project.id, form({ plausibleSite: "made-up.example" }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace/) });
    });

    it("clearing Plausible drops its rows and leaves the other sources alone", async () => {
      const { project, scope } = await seed({ plausibleSite: "made-up.example" });
      await db.insert(s.ga4LandingDaily).values({ ...scope, date: "2026-10-01", hostName: "a.example", landingPage: "/", sessions: 3, engagedSessions: 1, keyEvents: 0, totalRevenue: 0 });
      await setPlausibleSite(project.id, form({ plausibleSite: "" }));
      expect((await projectRow(project.id)).plausibleSite).toBeNull();
      expect(await landingRows(scope)).toEqual([]);
    });

    it("choosing a GA4 property drops the Plausible mapping and its state", async () => {
      const { project, scope } = await seed({ plausibleSite: "made-up.example" });
      await db.insert(s.googleSyncState).values({ ...scope, source: "plausible", property: "made-up.example", backfillStart: "2026-01-01" });
      await setProjectProperties(project.id, form({ gscProperty: "", ga4Property: "properties/1000001" }));
      expect(await projectRow(project.id)).toMatchObject({ plausibleSite: null, ga4Property: "properties/1000001" });
      expect(await getPlausibleSyncState(scope)).toBeNull();
    });

    it("choosing a PostHog project drops the Plausible mapping and its state", async () => {
      const { project, scope } = await seed({ plausibleSite: "made-up.example" });
      await db.insert(s.googleSyncState).values({ ...scope, source: "plausible", property: "made-up.example", backfillStart: "2026-01-01" });
      await setPosthogProject(project.id, form({ posthogProject: "2001" }));
      expect(await projectRow(project.id)).toMatchObject({ plausibleSite: null, posthogProject: "2001" });
      expect(await getPlausibleSyncState(scope)).toBeNull();
    });

    it("Sync now queues the Plausible sync", async () => {
      const { project, scope } = await seed({ plausibleSite: "made-up.example" });
      await syncNow(project.id);
      expect(enqueue).toHaveBeenCalledWith("plausible.sync", scope, { singletonKey: `project:${project.id}` });
    });
  });
});
