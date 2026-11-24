import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Plausible workspace isolation, against seopen_test in the style of
 * src/lib/workspace/isolation.db.test.ts: workspace B must not read, use or change workspace A's key,
 * site or synced rows. The request side is impersonated by mocking `currentWorkspace()`, and Plausible
 * is a fake that says which key asked. Every site and number here is made up.
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

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { decrypt } = await import("@/lib/crypto");
const { jobScope } = await import("@/lib/workspace");
const { connectPlausible, disconnectPlausible, setPlausibleSite } = await import("./actions");
const { getPlausibleConnectionInfo, plausibleKey, savePlausibleAccount } = await import("./account");
const { forgetPlausibleSites, listPlausibleSites } = await import("./sites");
const { getPlausibleSyncState, resetPlausibleData, syncPlausible } = await import("./sync");
const { syncNow } = await import("@/modules/google/actions");

const KEY_A = "made-up-key-of-workspace-a";
const KEY_B = "made-up-key-of-workspace-b";
const SITE_A = "site-a.example";
const SITE_B = "site-b.example";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake Plausible where each key sees only its own team's site, and where calls are recorded by key. */
function stubPlausible() {
  const siteOf: Record<string, string> = { [KEY_A]: SITE_A, [KEY_B]: SITE_B };
  const usedKeys: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      usedKeys.push(key);
      const site = siteOf[key];
      if (!site) return json({ error: "Invalid API key" }, 401);
      const { pathname } = new URL(String(input));
      if (pathname === "/api/v1/sites") return json({ sites: [{ domain: site, timezone: "UTC" }], meta: { after: null } });
      if (pathname.startsWith("/api/v1/sites/")) return decodeURIComponent(pathname.split("/").pop()!) === site ? json({ domain: site, timezone: "UTC" }) : json({ error: "Invalid API key or site ID" }, 401);
      const body = JSON.parse(String(init?.body)) as { site_id: string; dimensions?: string[]; date_range: string | string[] };
      if (body.site_id !== site) return json({ error: "Invalid API key or site ID" }, 401);
      return json({ results: body.dimensions ? [{ dimensions: [body.date_range[0], site, "/"], metrics: [5, 20] }] : [] });
    }),
  );
  return usedKeys;
}

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};

async function seedWorkspace(key: string, site: string) {
  const [ws] = await db.insert(s.workspaces).values({ name: `plausible-iso-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: site, domain: `${randomUUID()}.example`, plausibleSite: site })
    .returning();
  await savePlausibleAccount(ws.id, key);
  return { ws, project, scope: { workspaceId: ws.id, projectId: project.id } };
}

const rowsOf = (projectId: number) => db.select().from(s.ga4LandingDaily).where(eq(s.ga4LandingDaily.projectId, projectId));
const projectOf = async (id: number) => (await db.select().from(s.projects).where(eq(s.projects.id, id)))[0];
const storedKey = async (workspaceId: number) => decrypt((await db.select().from(s.plausibleAccounts).where(eq(s.plausibleAccounts.workspaceId, workspaceId)))[0].apiKeyEnc);

describe.skipIf(!ready)("Plausible workspace isolation", () => {
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let B: Awaited<ReturnType<typeof seedWorkspace>>;

  beforeAll(async () => {
    A = await seedWorkspace(KEY_A, SITE_A);
    B = await seedWorkspace(KEY_B, SITE_B);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPlausibleSites(A.ws.id);
    forgetPlausibleSites(B.ws.id);
  });

  it("gives each workspace its own key, by workspace id alone", async () => {
    expect((await plausibleKey(A.ws.id)).key).toBe(KEY_A);
    expect((await plausibleKey(B.ws.id)).key).toBe(KEY_B);
    expect((await getPlausibleConnectionInfo(A.ws.id))?.workspaceId).toBe(A.ws.id);
  });

  it("lists sites with each workspace's own key, and caches them apart", async () => {
    const used = stubPlausible();
    expect((await listPlausibleSites(A.ws.id)).map((x) => x.domain)).toEqual([SITE_A]);
    expect((await listPlausibleSites(B.ws.id)).map((x) => x.domain)).toEqual([SITE_B]);
    expect(used).toEqual([KEY_A, KEY_B]);
  });

  it("refuses B's actions on A's project: no mapping change, no sync queued", async () => {
    state.ws = B.ws.id;
    stubPlausible();
    await expect(setPlausibleSite(A.project.id, form({ plausibleSite: SITE_B }))).rejects.toThrow();
    await expect(syncNow(A.project.id)).rejects.toThrow();
    expect((await projectOf(A.project.id)).plausibleSite).toBe(SITE_A);
  });

  it("won't let B map its own project to A's site, because B's key can't read it", async () => {
    state.ws = B.ws.id;
    stubPlausible();
    await expect(setPlausibleSite(B.project.id, form({ plausibleSite: SITE_A }))).resolves.toEqual({ error: expect.stringMatching(/isn't on this workspace/) });
    expect((await projectOf(B.project.id)).plausibleSite).toBe(SITE_B);
  });

  it("connecting and disconnecting in B touches only B's row", async () => {
    state.ws = B.ws.id;
    stubPlausible();
    await connectPlausible(form({ plausibleKey: KEY_B }));
    expect(await storedKey(A.ws.id)).toBe(KEY_A);
    await disconnectPlausible();
    expect(await getPlausibleConnectionInfo(B.ws.id)).toBeNull();
    expect(await storedKey(A.ws.id)).toBe(KEY_A);
    await savePlausibleAccount(B.ws.id, KEY_B);
  });

  it("syncs with the project's own workspace's key, and rows land under that project", async () => {
    const used = stubPlausible();
    await syncPlausible(A.scope);
    expect(new Set(used)).toEqual(new Set([KEY_A]));
    expect((await rowsOf(A.project.id)).every((r) => r.workspaceId === A.ws.id && r.hostName === SITE_A)).toBe(true);
    expect(await rowsOf(B.project.id)).toEqual([]);
  });

  it("a scope pairing B's workspace with A's project reaches nothing", async () => {
    const used = stubPlausible();
    const mixed = { workspaceId: B.ws.id, projectId: A.project.id };
    expect(await syncPlausible(mixed)).toEqual({ more: false, skipped: "no Plausible site mapped" });
    expect(used).toEqual([]);
    expect(await getPlausibleSyncState(mixed)).toBeNull();
    const before = (await rowsOf(A.project.id)).length;
    expect(before).toBeGreaterThan(0);
    await resetPlausibleData(mixed);
    expect((await rowsOf(A.project.id)).length).toBe(before);
    expect((await jobScope(mixed)).ok).toBe(false);
  });

  it("a database rule keeps a landing row from pointing at another workspace's project", async () => {
    await expect(db.insert(s.ga4LandingDaily).values({ workspaceId: B.ws.id, projectId: A.project.id, date: "2026-10-01", hostName: "x.example", landingPage: "/", sessions: 1, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 })).rejects.toThrow();
  });

  it("deleting a workspace takes its key and leaves the other's", async () => {
    const C = await seedWorkspace("made-up-key-of-workspace-c", SITE_A);
    await db.delete(s.workspaces).where(eq(s.workspaces.id, C.ws.id));
    expect(await db.$count(s.plausibleAccounts, eq(s.plausibleAccounts.workspaceId, C.ws.id))).toBe(0);
    expect(await storedKey(A.ws.id)).toBe(KEY_A);
  });
});
