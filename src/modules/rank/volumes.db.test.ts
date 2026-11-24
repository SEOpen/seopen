import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Filling search volumes against seopen_test, with DataForSEO faked. Each stale keyword gets its
 * own volume, CPC and difficulty; a city project takes its volume from Google Ads for that city;
 * fresh, paused and other workspaces' keywords are not written.
 */

vi.mock("server-only", () => ({}));

/** Labs data by keyword. A keyword missing here comes back with no data. */
const labs = new Map<string, { volume: number; cpc: number; difficulty: number }>();
/** Google Ads volumes by keyword, for a city project. */
const ads = new Map<string, number>();
const paths: string[] = [];

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { month: 2_592_000 },
  taskResults: (res: { tasks: { result: unknown[] | null }[] }) => res.tasks[0]?.result ?? [],
  dfsGet: vi.fn(async () => {
    throw new Error("no fetch expected");
  }),
  dfsPost: vi.fn(async (path: string, tasks: { keywords: string[] }[]) => {
    paths.push(path);
    const keywords = tasks[0].keywords;
    if (path.includes("google_ads/search_volume")) {
      return { tasks: [{ result: keywords.filter((k) => ads.has(k)).map((k) => ({ keyword: k, search_volume: ads.get(k) })) }] };
    }
    const items = keywords
      .filter((k) => labs.has(k))
      .map((k) => {
        const d = labs.get(k)!;
        return { keyword: k, keyword_info: { search_volume: d.volume, cpc: d.cpc }, keyword_properties: { keyword_difficulty: d.difficulty } };
      });
    return { tasks: [{ result: [{ items }] }] };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { asc, eq } = await import("drizzle-orm");
const { fetchVolumes } = await import("./tracker");

const LONG_AGO = new Date(Date.now() - 60 * 86_400_000);
const RECENT = new Date(Date.now() - 86_400_000);
/** What a keyword held before: wrong on purpose, so a write shows. */
const STALE = { searchVolume: 1, cpc: 9, difficulty: 99, volumeUpdatedAt: LONG_AGO };

async function seed(cityCode: number | null = null) {
  const [ws] = await db.insert(s.workspaces).values({ name: `rank-vol-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example`, cityCode }).returning();
  return { workspaceId: ws.id, projectId: project.id };
}

type Scope = Awaited<ReturnType<typeof seed>>;

const keyword = async (scope: Scope, kw: string, extra: Partial<typeof s.rankKeywords.$inferInsert> = {}) => {
  const [k] = await db.insert(s.rankKeywords).values({ ...scope, keyword: kw, ...STALE, ...extra }).returning();
  return k.id;
};

const row = async (id: number) => {
  const [k] = await db.select().from(s.rankKeywords).where(eq(s.rankKeywords.id, id));
  return k;
};

describe.skipIf(!ready)("fetchVolumes", () => {
  it("writes each stale keyword's own Labs data, and nothing to fresh or paused ones", async () => {
    labs.clear();
    labs.set("coffee beans", { volume: 5400, cpc: 1.25, difficulty: 41 });
    labs.set("espresso", { volume: 880, cpc: 0.5, difficulty: 12 });
    labs.set("fresh one", { volume: 10, cpc: 0.25, difficulty: 3 });
    const scope = await seed();
    const beansDesktop = await keyword(scope, "coffee beans");
    const beansMobile = await keyword(scope, "coffee beans", { device: "mobile" });
    const espresso = await keyword(scope, "espresso", { volumeUpdatedAt: null });
    const noData = await keyword(scope, "no data kw");
    const fresh = await keyword(scope, "fresh one", { volumeUpdatedAt: RECENT });
    const paused = await keyword(scope, "espresso", { device: "mobile", active: false });
    const before = Date.now();

    expect(await fetchVolumes(scope)).toBe(3);

    for (const id of [beansDesktop, beansMobile]) expect(await row(id)).toMatchObject({ searchVolume: 5400, cpc: 1.25, difficulty: 41 });
    expect(await row(espresso)).toMatchObject({ searchVolume: 880, cpc: 0.5, difficulty: 12 });
    expect(await row(noData)).toMatchObject({ searchVolume: null, cpc: null, difficulty: null });
    for (const id of [beansDesktop, beansMobile, espresso, noData]) {
      expect((await row(id)).volumeUpdatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(await row(fresh)).toMatchObject({ ...STALE, volumeUpdatedAt: RECENT });
    expect(await row(paused)).toMatchObject(STALE);
  });

  it("a city project takes its volume from Google Ads, and CPC and difficulty from Labs", async () => {
    labs.clear();
    ads.clear();
    labs.set("roaster", { volume: 9000, cpc: 2.75, difficulty: 30 });
    labs.set("cold brew", { volume: 4000, cpc: 1.5, difficulty: 20 });
    ads.set("roaster", 320);
    const scope = await seed(1_014_895);
    const roaster = await keyword(scope, "roaster");
    const coldBrew = await keyword(scope, "cold brew");

    await fetchVolumes(scope);

    expect(await row(roaster)).toMatchObject({ searchVolume: 320, cpc: 2.75, difficulty: 30 });
    // Not in the city's Ads data: no volume, though Labs has a national one.
    expect(await row(coldBrew)).toMatchObject({ searchVolume: null, cpc: 1.5, difficulty: 20 });
  });

  it("never writes another workspace's keywords", async () => {
    labs.clear();
    labs.set("coffee beans", { volume: 5400, cpc: 1.25, difficulty: 41 });
    const scope = await seed();
    const other = await seed();
    const mine = await keyword(scope, "coffee beans");
    const theirs = await keyword(other, "coffee beans");

    await fetchVolumes(scope);

    expect(await row(mine)).toMatchObject({ searchVolume: 5400, cpc: 1.25, difficulty: 41 });
    expect(await row(theirs)).toMatchObject(STALE);
  });

  it("stores a difficulty of 0 as unknown, since Labs sends 0 for a keyword it hasn't scored", async () => {
    labs.clear();
    labs.set("unscored kw", { volume: 480, cpc: 1.5, difficulty: 0 });
    const scope = await seed();
    const id = await keyword(scope, "unscored kw");

    await fetchVolumes(scope);

    expect(await row(id)).toMatchObject({ searchVolume: 480, cpc: 1.5, difficulty: null });
  });

  it("writes every keyword of a project with more than one statement takes", async () => {
    labs.clear();
    paths.length = 0;
    const scope = await seed();
    // 1,200 keywords: two Labs calls (700 and 500), the first past a chunk edge.
    const words = Array.from({ length: 1200 }, (_, i) => `kw ${String(i).padStart(4, "0")}`);
    words.forEach((w, i) => labs.set(w, { volume: i, cpc: 0.25 * (i % 8), difficulty: i % 100 }));
    await db.insert(s.rankKeywords).values(words.map((w) => ({ ...scope, keyword: w, ...STALE })));

    expect(await fetchVolumes(scope)).toBe(1200);
    expect(paths.filter((p) => p.includes("keyword_overview"))).toHaveLength(2);

    const rows = await db
      .select({ keyword: s.rankKeywords.keyword, searchVolume: s.rankKeywords.searchVolume, cpc: s.rankKeywords.cpc, difficulty: s.rankKeywords.difficulty })
      .from(s.rankKeywords)
      .where(eq(s.rankKeywords.projectId, scope.projectId))
      .orderBy(asc(s.rankKeywords.keyword));
    // i % 100 is 0 every hundredth keyword: an unscored difficulty, stored as null.
    expect(rows).toEqual(words.map((w, i) => ({ keyword: w, searchVolume: i, cpc: 0.25 * (i % 8), difficulty: i % 100 || null })));
  });
});
