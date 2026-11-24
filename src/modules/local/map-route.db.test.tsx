import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The Local SEO map's Google image against seopen_test. A signed Maps Static URL loads forever for
 * anyone who has it, so the page must never carry one: it points at /local/[businessId]/map, which
 * signs and fetches on the server, and only for a signed-in caller's own business. The request side
 * is impersonated as in src/lib/workspace/isolation.db.test.ts. Google is never called: fetch is stubbed.
 */

const state = vi.hoisted(() => ({ ws: 0, user: null as { id: string } | null, cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => state.user,
  requireSession: async () => {
    if (!state.user) throw new Error("signed out");
    return state.user;
  },
}));
vi.mock("@/lib/workspace/current", async () => {
  const { db } = await import("@/db");
  const { workspaces } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const currentWorkspace = async () => {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, state.ws));
    if (!ws) throw new Error("no workspace");
    return ws;
  };
  return { currentWorkspace, currentTimeZone: async () => "America/New_York", workspaceScope: async () => ({ workspaceId: (await currentWorkspace()).id }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void state.cookies.set(name, String(value)),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));

const ready = await testDb();

// Imported after the mocks above.
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { PROJECT_COOKIE } = await import("@/lib/projects");
const { gridPoints } = await import("./grid");
const { GET } = await import("@/app/(app)/local/[businessId]/map/route");
const { default: LocalBusinessPage } = await import("@/app/(app)/local/[businessId]/page");

// A made-up key and a made-up 20-byte secret in Google's URL-safe base64 form.
const KEY = "test-maps-key";
const SECRET = "vNIXE0xscrmjlyV-12Nj_BvUPaw="; // gitleaks:allow (made up)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function seed(tag: string) {
  const [ws] = await db.insert(s.workspaces).values({ name: `local-map-${tag}-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: `${tag} shop`, domain: `${tag}-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [business] = await db
    .insert(s.localBusinesses)
    .values({ ...scope, query: `${tag} shop`, city: "Salem, NH", title: `${tag} shop`, cid: "1", lat: 42.7885, lng: -71.2009 })
    .returning();
  const [keyword] = await db.insert(s.localKeywords).values({ workspaceId: ws.id, businessId: business.id, keyword: `${tag} plumber` }).returning();
  const [check] = await db
    .insert(s.localChecks)
    .values({ ...scope, businessId: business.id, kind: "manual", gridSize: 3, radiusMiles: 2, zoom: 13, lat: 42.7885, lng: -71.2009, status: "done", finishedAt: new Date() })
    .returning();
  await db.insert(s.localPoints).values(
    gridPoints(42.7885, -71.2009, 3, 2).map((p) => ({ workspaceId: ws.id, checkId: check.id, keywordId: keyword.id, row: p.row, col: p.col, lat: p.lat, lng: p.lng, status: "done" as const, rank: 2 })),
  );
  return { ws, project, business, keyword, check };
}

type Seeded = Awaited<ReturnType<typeof seed>>;
let A: Seeded;
let B: Seeded;

function as(w: Seeded) {
  state.ws = w.ws.id;
  state.user = { id: `user-${w.ws.id}` };
  state.cookies.clear();
  state.cookies.set(PROJECT_COOKIE, String(w.project.id));
}

const mapRequest = (w: Seeded, query = `check=${w.check.id}&k=${w.keyword.id}`) =>
  GET(new Request(`http://local/local/${w.business.id}/map?${query}`), { params: Promise.resolve({ businessId: String(w.business.id) }) });

describe.skipIf(!ready)("the Local SEO map image", () => {
  const fetchMock = vi.fn(async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }));

  beforeAll(async () => {
    A = await seed("a");
    B = await seed("b");
  });
  afterEach(() => {
    state.ws = 0;
    state.user = null;
    state.cookies.clear();
    fetchMock.mockClear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function withGoogle() {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", KEY);
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", SECRET);
    vi.stubGlobal("fetch", fetchMock);
  }

  it("never puts a signed Google URL in the page, only SEOpen's own route", async () => {
    withGoogle();
    as(A);
    const html = renderToStaticMarkup(await LocalBusinessPage({ params: Promise.resolve({ businessId: String(A.business.id) }), searchParams: Promise.resolve({}) } as never));
    expect(html).toContain(`/local/${A.business.id}/map?check=${A.check.id}&amp;k=${A.keyword.id}`);
    expect(html).not.toContain("maps.googleapis.com");
    expect(html).not.toContain("signature=");
    expect(html).not.toContain(KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws OpenStreetMap and links no route without the Google key and secret", async () => {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", "");
    as(A);
    const html = renderToStaticMarkup(await LocalBusinessPage({ params: Promise.resolve({ businessId: String(A.business.id) }), searchParams: Promise.resolve({}) } as never));
    expect(html).toContain("tile.openstreetmap.org");
    expect(html).not.toContain(`/local/${A.business.id}/map`);
    const res = await mapRequest(A);
    expect(res.status).toBe(404);
  });

  it("serves the image to the business's own workspace, signed on the server, with private caching", async () => {
    withGoogle();
    as(A);
    const res = await mapRequest(A);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/staticmap");
    expect(url.searchParams.get("center")).toBe("42.788500,-71.200900");
    expect(url.searchParams.get("signature")).toBeTruthy();
  });

  it("refuses a signed-out caller without calling Google", async () => {
    withGoogle();
    const res = await mapRequest(A);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses another workspace's business, check or keyword without calling Google", async () => {
    withGoogle();
    as(B);
    // A's business, check and keyword, asked for by B.
    expect((await mapRequest(A)).status).toBe(404);
    // B's own business with A's check, and B's check with A's keyword.
    const b = (query: string) => GET(new Request(`http://local/local/${B.business.id}/map?${query}`), { params: Promise.resolve({ businessId: String(B.business.id) }) });
    expect((await b(`check=${A.check.id}&k=${B.keyword.id}`)).status).toBe(404);
    expect((await b(`check=${B.check.id}&k=${A.keyword.id}`)).status).toBe(404);
    expect((await b("check=99999999999&k=1")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    // The same request from B's own ids works.
    expect((await mapRequest(B)).status).toBe(200);
  });

  it("answers 502 when Google fails, so the page falls back to OpenStreetMap", async () => {
    withGoogle();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("The provided API key is invalid.", { status: 403, headers: { "Content-Type": "text/plain" } })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    as(A);
    const res = await mapRequest(A);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
