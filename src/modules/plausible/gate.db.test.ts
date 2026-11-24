import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Plausible stays on the owner's workspace until the privacy page names it (gate.ts). Against
 * seopen_test with faked Plausible responses and fixture connections. Every site and number is made up.
 */

const state = vi.hoisted(() => ({ ws: 0, project: null as unknown }));

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
vi.mock("@/lib/projects", async (original) => ({ ...(await original<typeof import("@/lib/projects")>()), getCurrentProject: async () => state.project }));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.SEOPEN_GOOGLE_FIXTURES = "1";
process.env.SEOPEN_POSTHOG_FIXTURES = "1";

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { analyticsData } = await import("@/lib/mcp/data");
const { default: Ga4Page } = await import("@/app/(app)/ga4/page");
const { PageHeader } = await import("@/components/ui/page-header");
const { connectPlausible, setPlausibleSite } = await import("./actions");
const { savePlausibleAccount } = await import("./account");
const { PLAUSIBLE_CLOSED, plausibleOpen } = await import("./gate");
const { forgetPlausibleSites } = await import("./sites");
const { syncPlausible } = await import("./sync");
const { PlausibleNotices, PlausiblePanel, PlausibleStop } = await import("./ui/panel");
const { enqueue } = await import("@/lib/jobs/boss");

const KEY = "made-up-stats-key-789";
const SITE = "made-up.example";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function stubPlausible() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname === "/api/v1/sites") return json({ sites: [{ domain: SITE, timezone: "UTC" }], meta: { after: null } });
    if (pathname === `/api/v1/sites/${SITE}`) return json({ domain: SITE, timezone: "UTC" });
    const body = JSON.parse(String(init?.body)) as { dimensions?: string[]; date_range: string | string[] };
    const day = Array.isArray(body.date_range) ? body.date_range[0] : "";
    return json({ results: body.dimensions ? [{ dimensions: [day, SITE, "/pricing"], metrics: [10, 40] }] : [{ dimensions: [], metrics: [10] }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed(plan: "internal" | "starter", set: { plausibleSite?: string } = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `plausible-gate-${randomUUID()}`, plan }).returning();
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

const accountCount = (workspaceId: number) => db.$count(s.plausibleAccounts, eq(s.plausibleAccounts.workspaceId, workspaceId));
const mappedSite = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0].plausibleSite;

/** The page's own elements, unrendered: enough to say what it chose to show, without a browser. */
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

describe("plausibleOpen", () => {
  it("is open to the internal plan and no other", () => {
    expect(plausibleOpen({ plan: "internal" })).toBe(true);
    for (const plan of ["free", "trial", "starter", "pro", "none", "made-up"]) expect(plausibleOpen({ plan })).toBe(false);
  });
});

describe.skipIf(!ready)("Plausible on the owner's workspace only", () => {
  beforeEach(() => {
    process.env.SEOPEN_PLAUSIBLE_FIXTURES = "0";
    vi.mocked(enqueue).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPlausibleSites(state.ws);
  });

  describe("the actions", () => {
    it("refuse a Starter workspace before calling Plausible or storing anything", async () => {
      const { ws, project } = await seed("starter");
      const fetchMock = stubPlausible();
      await expect(connectPlausible(form({ plausibleKey: KEY }))).resolves.toEqual({ error: PLAUSIBLE_CLOSED });
      await expect(setPlausibleSite(project.id, form({ plausibleSite: SITE }))).resolves.toEqual({ error: PLAUSIBLE_CLOSED });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(await accountCount(ws.id)).toBe(0);
      expect(await mappedSite(project.id)).toBeNull();
    });

    it("let a Starter project already on Plausible stop using it", async () => {
      const { project } = await seed("starter", { plausibleSite: SITE });
      const fetchMock = stubPlausible();
      await expect(setPlausibleSite(project.id, form({ plausibleSite: "" }))).resolves.toBeUndefined();
      expect(await mappedSite(project.id)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("let an internal workspace connect and pick a site", async () => {
      const { ws, project, scope } = await seed("internal");
      stubPlausible();
      await expect(connectPlausible(form({ plausibleKey: KEY }))).resolves.toBeUndefined();
      expect(await accountCount(ws.id)).toBe(1);
      await expect(setPlausibleSite(project.id, form({ plausibleSite: SITE }))).resolves.toBeUndefined();
      expect(await mappedSite(project.id)).toBe(SITE);
      expect(enqueue).toHaveBeenCalledWith("plausible.sync", scope, { singletonKey: `project:${project.id}` });
    });
  });

  describe("picking a site when the site list fails", () => {
    const failWith = (status: number, body: unknown) =>
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

    it("says a rate limit is a rate limit, not a site missing from the connection", async () => {
      const { ws, project } = await seed("internal");
      await savePlausibleAccount(ws.id, KEY);
      failWith(429, { error: "Too many requests." });
      const result = await setPlausibleSite(project.id, form({ plausibleSite: SITE }));
      expect(result).toEqual({ error: expect.stringMatching(/limiting requests/) });
      expect(result).not.toEqual({ error: expect.stringMatching(/isn't on this workspace's Plausible connection/) });
      expect(await mappedSite(project.id)).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("lets any other failure to list sites through as a failure", async () => {
      const { ws, project } = await seed("internal");
      await savePlausibleAccount(ws.id, KEY);
      failWith(500, { error: "Server error." });
      await expect(setPlausibleSite(project.id, form({ plausibleSite: SITE }))).rejects.toThrow();
      expect(await mappedSite(project.id)).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("keeps saying the site isn't there when the key lists none", async () => {
      const { ws, project } = await seed("internal");
      await savePlausibleAccount(ws.id, KEY);
      vi.stubGlobal("fetch", vi.fn(async () => json({ sites: [], meta: { after: null } })));
      await expect(setPlausibleSite(project.id, form({ plausibleSite: SITE }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace's Plausible connection/) });
      expect(await mappedSite(project.id)).toBeNull();
    });
  });

  describe("the Analytics page, on fixtures", () => {
    beforeEach(() => {
      process.env.SEOPEN_PLAUSIBLE_FIXTURES = "1";
    });

    it("offers a Starter workspace GA4 and PostHog, with nothing of Plausible", async () => {
      await seed("starter");
      const page = await analyticsPage();
      expect(shows(page, PlausiblePanel)).toBe(false);
      expect(shows(page, PlausibleNotices)).toBe(false);
      expect(headerLine(page)).toMatch(/from GA4 or PostHog,/);
      expect(headerLine(page)).not.toMatch(/Plausible/);
    });

    it("offers an internal workspace all three", async () => {
      await seed("internal");
      const page = await analyticsPage();
      expect(shows(page, PlausiblePanel)).toBe(true);
      expect(headerLine(page)).toMatch(/GA4, PostHog, Plausible or Umami/);
    });

    it("gives no connect form or site picker to a Starter project that's already mapped", async () => {
      await seed("starter", { plausibleSite: SITE });
      const page = await analyticsPage();
      expect(shows(page, PlausiblePanel)).toBe(false);
      expect(shows(page, PlausibleNotices)).toBe(false);
      expect(headerLine(page)).toMatch(/in Plausible/);
    });

    it("gives that project only a way to stop using Plausible", async () => {
      await seed("starter", { plausibleSite: SITE });
      expect(shows(await analyticsPage(), PlausibleStop)).toBe(true);
      await seed("starter");
      expect(shows(await analyticsPage(), PlausibleStop)).toBe(false);
      await seed("internal", { plausibleSite: SITE });
      expect(shows(await analyticsPage(), PlausibleStop)).toBe(false);
    });
  });

  it("keeps syncing and reporting a project already mapped, whatever the plan", async () => {
    const { ws, project, scope } = await seed("starter", { plausibleSite: SITE });
    await savePlausibleAccount(ws.id, KEY);
    stubPlausible();
    expect((await syncPlausible(scope)).more).toBe(true);
    expect(await analyticsData({ workspaceId: ws.id }, { project: project.id })).toMatchObject({ source: "plausible" });
  });
});
