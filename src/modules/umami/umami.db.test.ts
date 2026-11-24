import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Umami as an Analytics source, against seopen_test with faked Umami responses: the gate keeps it to
 * the owner's workspace, a checked credential is stored encrypted (a login's password never is), the
 * sync fills the table the other sources use, a project maps one source at a time, and the fix
 * report reads its visits. Every website, key and number here is made up.
 */

const state = vi.hoisted(() => ({ ws: 0, project: null as unknown, safe: [] as { url: string; method?: string; headers?: Record<string, string>; body?: string }[] }));

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
vi.mock("@/lib/projects", async (original) => ({ ...(await original<typeof import("@/lib/projects")>()), getCurrentProject: async () => state.project }));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
// The self-hosted path goes through safeFetch; this stands in for a self-hosted Umami at a public address.
vi.mock("@/lib/web/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/web/fetch")>()),
  safeFetch: vi.fn(async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    state.safe.push({ url, ...opts });
    const { pathname } = new URL(url);
    const body =
      pathname === "/api/auth/login"
        ? { token: "made-up-login-token", user: { id: "u1" } }
        : pathname === "/api/websites"
          ? { data: [{ id: "self-site", name: "Self", domain: "self.example" }], count: 1 }
          : pathname.endsWith("/metrics")
            ? []
            : null;
    return { url, status: 200, headers: {}, body: JSON.stringify(body), truncated: false, redirects: [], ms: 1 };
  }),
}));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.SEOPEN_GOOGLE_FIXTURES = "1";
process.env.SEOPEN_POSTHOG_FIXTURES = "1";

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { decrypt } = await import("@/lib/crypto");
const { connectionProblems, syncProblems } = await import("@/lib/admin/health");
const { analyticsData } = await import("@/lib/mcp/data");
const { default: Ga4Page } = await import("@/app/(app)/ga4/page");
const { PageHeader } = await import("@/components/ui/page-header");
const { connectUmami, disconnectUmami, setUmamiSite } = await import("./actions");
const { getUmamiConnectionInfo, saveUmamiAccount } = await import("./account");
const { fixtureUmamiApis, liveUmamiApis } = await import("./api");
const { UMAMI_CLOSED, umamiOpen } = await import("./gate");
const { forgetUmamiSites } = await import("./sites");
const { getUmamiSyncState, syncUmami } = await import("./sync");
const { UmamiNotices, UmamiPanel, UmamiStop } = await import("./ui/panel");
const { setPlausibleSite } = await import("@/modules/plausible/actions");
const { setProjectProperties } = await import("@/modules/google/actions");
const { organicVisits } = await import("@/modules/fixes/visits");
const { resultView } = await import("@/modules/fixes/queries");
const { enqueue } = await import("@/lib/jobs/boss");

const KEY = "umami_made-up-key-789";
const SITE = { id: "4f0c1e2a-0000-4000-8000-00000000abcd", name: "Made Up", domain: "made-up.example" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The live client with no spacing between requests, which in production keeps a sync inside Cloud's rate limit. */
const unpaced = (workspaceId: number) => liveUmamiApis(workspaceId, undefined, 0);

/** Umami Cloud with one website, ten organic visits to /pricing a day, six of them not bounces. */
function stubCloud() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/websites") return json({ data: [SITE], count: 1, page: 1, pageSize: 100 });
    if (path === `/websites/${SITE.id}`) return json(SITE);
    if (path === `/websites/${SITE.id}/metrics`) return json([{ x: "google.com", y: 4 }]);
    if (path === `/websites/${SITE.id}/stats`) return json({ visits: 4 });
    if (path === `/websites/${SITE.id}/metrics/expanded`) return json([{ name: "/pricing", visits: url.searchParams.has("excludeBounce") ? 6 : 10 }]);
    return json({ error: { message: "Not found." } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed(plan: "internal" | "starter", set: { ga4Property?: string; plausibleSite?: string; umamiSite?: string } = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `umami-${randomUUID()}`, plan }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: "Made Up", domain: `made-up-${ws.id}.example`, ...set })
    .returning();
  state.ws = ws.id;
  state.project = project;
  return { ws, project, scope: { workspaceId: ws.id, projectId: project.id } };
}

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const accountRow = async (workspaceId: number) => (await db.select().from(s.umamiAccounts).where(eq(s.umamiAccounts.workspaceId, workspaceId)))[0];
const projectRow = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0];

type Element = ReactElement<{ children?: ReactNode; description?: string }>;
const elementsIn = (node: ReactNode): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elementsIn(element.props.children)];
};
const analyticsPage = async () => elementsIn(await Ga4Page({ searchParams: Promise.resolve({}) } as never));
const shows = (page: Element[], component: unknown) => page.some((e) => e.type === component);
const headerLine = (page: Element[]) => page.find((e) => e.type === PageHeader)?.props.description;

describe("umamiOpen", () => {
  it("is open to the internal plan and no other", () => {
    expect(umamiOpen({ plan: "internal" })).toBe(true);
    for (const plan of ["free", "trial", "starter", "pro", "none", "made-up"]) expect(umamiOpen({ plan })).toBe(false);
  });
});

describe.skipIf(!ready)("Umami", () => {
  beforeEach(() => {
    process.env.SEOPEN_UMAMI_FIXTURES = "0";
    vi.mocked(enqueue).mockClear();
    state.safe = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    forgetUmamiSites(state.ws);
  });

  describe("on any plan but internal", () => {
    it("refuses to connect or map before calling Umami or storing anything", async () => {
      const { ws, project } = await seed("starter");
      const fetchMock = stubCloud();
      await expect(connectUmami(form({ umamiKey: KEY }))).resolves.toEqual({ error: UMAMI_CLOSED });
      await expect(setUmamiSite(project.id, form({ umamiSite: SITE.id }))).resolves.toEqual({ error: UMAMI_CLOSED });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.safe).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(await accountRow(ws.id)).toBeUndefined();
      expect((await projectRow(project.id)).umamiSite).toBeNull();
    });

    it("shows nothing of Umami on the Analytics page", async () => {
      process.env.SEOPEN_UMAMI_FIXTURES = "1";
      await seed("starter");
      const page = await analyticsPage();
      expect(shows(page, UmamiPanel)).toBe(false);
      expect(shows(page, UmamiNotices)).toBe(false);
      expect(shows(page, UmamiStop)).toBe(false);
      expect(headerLine(page)).not.toMatch(/Umami/);
    });

    it("lets a project already on Umami stop using it, and offers only that", async () => {
      process.env.SEOPEN_UMAMI_FIXTURES = "1";
      const { project } = await seed("starter", { umamiSite: SITE.id });
      const page = await analyticsPage();
      expect(shows(page, UmamiPanel)).toBe(false);
      expect(shows(page, UmamiStop)).toBe(true);
      process.env.SEOPEN_UMAMI_FIXTURES = "0";
      const fetchMock = stubCloud();
      await expect(setUmamiSite(project.id, form({ umamiSite: "" }))).resolves.toBeUndefined();
      expect((await projectRow(project.id)).umamiSite).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("keeps syncing and reporting a project already mapped", async () => {
      const { ws, project, scope } = await seed("starter", { umamiSite: SITE.id });
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      stubCloud();
      expect((await syncUmami(scope, unpaced(ws.id))).more).toBe(true);
      expect(await analyticsData({ workspaceId: ws.id }, { project: project.id })).toMatchObject({ source: "umami" });
    });
  });

  describe("on the owner's workspace", () => {
    it("checks an Umami Cloud key, stores it encrypted, and lists the website", async () => {
      const { ws, project, scope } = await seed("internal");
      const fetchMock = stubCloud();
      await expect(connectUmami(form({ umamiServer: "", umamiKey: KEY }))).resolves.toBeUndefined();
      const row = await accountRow(ws.id);
      expect(row).toMatchObject({ baseUrl: null, authType: "api_key", status: "active" });
      expect(row.credentialEnc).not.toContain(KEY);
      expect(decrypt(row.credentialEnc)).toBe(KEY);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.umami\.is\/v1\/websites\?/);
      expect(await getUmamiConnectionInfo(ws.id)).not.toHaveProperty("credentialEnc");

      await expect(setUmamiSite(project.id, form({ umamiSite: SITE.id }))).resolves.toBeUndefined();
      expect((await projectRow(project.id)).umamiSite).toBe(SITE.id);
      expect(enqueue).toHaveBeenCalledWith("umami.sync", scope, { singletonKey: `project:${project.id}` });
    });

    it("refuses a website its own connection can't list", async () => {
      const { ws, project } = await seed("internal");
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      stubCloud();
      await expect(setUmamiSite(project.id, form({ umamiSite: "someone-elses-website" }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace's Umami connection/) });
      expect((await projectRow(project.id)).umamiSite).toBeNull();
    });

    it("says a rate limit is a rate limit, not a website missing from the connection", async () => {
      const { ws, project } = await seed("internal");
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "Too many requests." } }, 429)));
      const result = await setUmamiSite(project.id, form({ umamiSite: SITE.id }));
      expect(result).toEqual({ error: expect.stringMatching(/limiting requests/) });
      expect(result).not.toEqual({ error: expect.stringMatching(/isn't on this workspace's Umami connection/) });
      expect((await projectRow(project.id)).umamiSite).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("lets any other failure to list websites through as a failure", async () => {
      const { ws, project } = await seed("internal");
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "Server error." } }, 500)));
      await expect(setUmamiSite(project.id, form({ umamiSite: SITE.id }))).rejects.toThrow();
      expect((await projectRow(project.id)).umamiSite).toBeNull();
    });

    it("keeps saying the website isn't there when the connection lists none", async () => {
      const { ws, project } = await seed("internal");
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], count: 0, page: 1, pageSize: 100 })));
      await expect(setUmamiSite(project.id, form({ umamiSite: SITE.id }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace's Umami connection/) });
    });

    it("signs in to a self-hosted server once through safeFetch, and keeps the token but never the password", async () => {
      const { ws } = await seed("internal");
      const fetchMock = stubCloud();
      const password = `made-up-password-${randomUUID()}`;
      await expect(connectUmami(form({ umamiServer: "https://stats.madeup-umami.app/", umamiUsername: "me", umamiPassword: password }))).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.safe[0]).toMatchObject({ url: "https://stats.madeup-umami.app/api/auth/login", method: "POST" });
      expect(state.safe[1].headers).toMatchObject({ authorization: "Bearer made-up-login-token" });
      const row = await accountRow(ws.id);
      expect(row).toMatchObject({ baseUrl: "https://stats.madeup-umami.app", authType: "login" });
      expect(decrypt(row.credentialEnc)).toBe("made-up-login-token");
      expect(JSON.stringify(row)).not.toContain(password);
    });

    it("refuses a private or plain-http server before sending anything", async () => {
      await seed("internal");
      for (const server of ["http://stats.madeup-umami.app", "https://localhost", "https://192.168.1.10", "https://stats.madeup-umami.app:3000"]) {
        expect(await connectUmami(form({ umamiServer: server, umamiKey: KEY })), server).toHaveProperty("error");
      }
      expect(state.safe).toEqual([]);
    });

    it("forgets the credential on disconnect", async () => {
      const { ws } = await seed("internal");
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      await disconnectUmami();
      expect(await accountRow(ws.id)).toBeUndefined();
    });

    it("offers its panel on the Analytics page, beside the others", async () => {
      process.env.SEOPEN_UMAMI_FIXTURES = "1";
      await seed("internal");
      const page = await analyticsPage();
      expect(shows(page, UmamiPanel)).toBe(true);
      expect(headerLine(page)).toMatch(/GA4, PostHog, Plausible or Umami/);
    });
  });

  describe("one source at a time", () => {
    it("replaces Plausible and its rows when Umami is picked, and the other way round", async () => {
      const { ws, project, scope } = await seed("internal", { plausibleSite: "made-up.example" });
      await db.insert(s.ga4LandingDaily).values({ ...scope, date: "2026-10-01", hostName: "made-up.example", landingPage: "/old", sessions: 3, engagedSessions: 1, keyEvents: 0, totalRevenue: 0 });
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      stubCloud();
      await setUmamiSite(project.id, form({ umamiSite: SITE.id }));
      expect(await projectRow(project.id)).toMatchObject({ umamiSite: SITE.id, plausibleSite: null });
      expect(await db.$count(s.ga4LandingDaily, eq(s.ga4LandingDaily.projectId, project.id))).toBe(0);

      process.env.SEOPEN_PLAUSIBLE_FIXTURES = "1";
      await setPlausibleSite(project.id, form({ plausibleSite: "alphanote.example" }));
      process.env.SEOPEN_PLAUSIBLE_FIXTURES = "0";
      expect(await projectRow(project.id)).toMatchObject({ umamiSite: null, plausibleSite: "alphanote.example" });
    });

    it("drops Umami when a GA4 property is picked", async () => {
      const { project, scope } = await seed("internal", { umamiSite: SITE.id });
      await db.insert(s.googleSyncState).values({ ...scope, source: "umami", property: SITE.id, status: "ok" });
      await setProjectProperties(project.id, form({ gscProperty: "", ga4Property: "properties/1000001" }));
      expect(await projectRow(project.id)).toMatchObject({ umamiSite: null, ga4Property: "properties/1000001" });
      expect(await getUmamiSyncState(scope)).toBeNull();
    });
  });

  describe("the sync", () => {
    it("fills the shared Analytics table under source umami, a pair of requests a day", async () => {
      const { ws, scope, project } = await seed("internal", { umamiSite: SITE.id });
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      const fetchMock = stubCloud();
      const r = await syncUmami(scope, unpaced(ws.id));
      expect(r.more).toBe(true);
      const rows = await db.select().from(s.ga4LandingDaily).where(eq(s.ga4LandingDaily.projectId, project.id));
      // 28 backfill days and the 3 recent ones.
      expect(rows).toHaveLength(31);
      expect(rows[0]).toMatchObject({ hostName: "made-up.example", landingPage: "/pricing", sessions: 10, engagedSessions: 6, keyEvents: 0 });
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/metrics/expanded"))).toHaveLength(62);
      expect(await getUmamiSyncState(scope)).toMatchObject({ source: "umami", property: SITE.id, status: "ok" });
    });

    it("works on fixtures with no account", async () => {
      const { scope, project } = await seed("internal", { umamiSite: "00000000-0000-4000-8000-000000000001" });
      await syncUmami(scope, fixtureUmamiApis);
      expect(await db.$count(s.ga4LandingDaily, eq(s.ga4LandingDaily.projectId, project.id))).toBeGreaterThan(0);
    });

    it("marks a refused credential for a reconnect, which Admin shows", async () => {
      const { ws, scope } = await seed("internal", { umamiSite: SITE.id });
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: `Unauthorized ${KEY}` } }, 401)));
      await expect(syncUmami(scope, unpaced(ws.id))).rejects.toThrow(/reconnecting/);
      expect(await getUmamiSyncState(scope)).toMatchObject({ status: "reauth" });
      expect((await accountRow(ws.id)).status).toBe("reauth_required");
      expect(await connectionProblems(ws.id)).toEqual([expect.objectContaining({ service: "Umami", account: "Umami Cloud", status: "reauth_required" })]);
      expect(await syncProblems(ws.id)).toEqual([expect.objectContaining({ source: "umami", sourceLabel: "Umami", kind: "reauth" })]);
      expect(JSON.stringify(await getUmamiSyncState(scope))).not.toContain(KEY);
    });

    it("skips a project remapped mid-sync rather than writing under the wrong source", async () => {
      const { ws, scope, project } = await seed("internal", { umamiSite: SITE.id });
      await saveUmamiAccount(ws.id, { baseUrl: null, authType: "api_key", credential: KEY });
      const api = {
        ...fixtureUmamiApis,
        site: async () => SITE,
        organicLandingPages: async () => {
          await db.update(s.projects).set({ umamiSite: null }).where(and(eq(s.projects.id, project.id)));
          return [];
        },
      };
      expect(await syncUmami(scope, api)).toMatchObject({ skipped: expect.stringMatching(/mapping changed/) });
    });
  });

  describe("the fix report", () => {
    it("reads Umami's visits beside Search Console's clicks, named as Umami's", async () => {
      const { scope } = await seed("internal", { umamiSite: SITE.id });
      await db.insert(s.googleSyncState).values({ ...scope, source: "umami", property: SITE.id, status: "ok", latestDate: "2026-10-30", backfillDone: true });
      const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
      await db.insert(s.ga4LandingDaily).values(days.map((date) => ({ ...scope, date, hostName: "made-up.example", landingPage: "/pricing", sessions: 2, engagedSessions: 1, keyEvents: 0, totalRevenue: 0 })));
      const measured = { before: { from: "2026-10-01", to: "2026-10-07", clicks: 40, impressions: 400, ctr: 0.1, position: 5 }, after: { from: "2026-10-08", to: "2026-10-14", clicks: 47, impressions: 410, ctr: 0.11, position: 4.8 }, site: { before: { clicks: 400, impressions: 4000, ctr: 0.1, position: 9 }, after: { clicks: 410, impressions: 4100, ctr: 0.1, position: 9 } }, computedAt: "2026-10-15T00:00:00Z", days: 7 };
      const fix = { id: 1, code: "title-too-long", url: "https://made-up.example/pricing", results: { "7": measured } } as never;
      const { source, visits } = await organicVisits(scope, [fix]);
      expect(source).toBe("umami");
      expect(visits.get(1)).toEqual({ "7": { before: 14, after: 14, over: "page" } });
      const shown = resultView({ results: { "7": measured } } as never, visits.get(1), source);
      expect(shown[0]).toMatchObject({ umami_visits: { before: 14, after: 14, counts: expect.stringMatching(/Umami organic visits/) } });
      expect(shown[0]).not.toHaveProperty("plausible_visits");
    });
  });
});
