import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Tracking a city, against seopen_test with DataForSEO faked: the city's code reaches task_post, a
 * project that never picked one keeps searching its country, Labs never gets a city code, and
 * results from two places are never compared while both stay readable.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const posts: { path: string; tasks: Record<string, unknown>[]; estimateUsd?: number }[] = [];

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { month: 2_592_000 },
  taskResults: (res: { tasks: { result: unknown[] }[] }) => res.tasks[0].result,
  dfsGet: vi.fn(async () => {
    throw new Error("no API call expected: the city list is seeded");
  }),
  dfsPost: vi.fn(async (path: string, tasks: Record<string, unknown>[], opts: { estimateUsd?: number }) => {
    posts.push({ path, tasks, estimateUsd: opts.estimateUsd });
    if (path.endsWith("task_post")) {
      return { cost: 0.001, tasks: tasks.map((t, i) => ({ id: `${randomUUID()}-${i}`, status_code: 20100, status_message: "Task Created", data: { tag: t.tag } })) };
    }
    if (path.includes("google_ads")) {
      return { cost: 0.09, tasks: [{ status_code: 20000, result: (tasks[0].keywords as string[]).map((keyword) => ({ keyword, search_volume: 390 })) }] };
    }
    return { cost: 0.012, tasks: [{ status_code: 20000, result: [{ items: (tasks[0].keywords as string[]).map((keyword) => ({ keyword, keyword_info: { search_volume: 9000, cpc: 4 }, keyword_properties: { keyword_difficulty: 30 } })) }] }] };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { createRun, fetchVolumes, postRun, storeResult } = await import("./tracker");
const { keywordHistory, loadResults, loadTracker, resolveWindow } = await import("./queries");
const { rankPlaceChanged } = await import("./ops");
const { projectCity, projectInput } = await import("@/lib/ops/projects");
const { OpError } = await import("@/lib/ops");
const { researchCity } = await import("@/modules/keywords/city");

const US = 2840;
const SALEM = { code: 1099001, name: "Salem, New Hampshire" };
const ILLINOIS = { code: 1099002, name: "Salem, Illinois" };
const BERLIN = { code: 1003854, name: "Berlin" };

async function seed(city?: { code: number; name: string }) {
  const [ws] = await db.insert(s.workspaces).values({ name: `place-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example`, cityCode: city?.code ?? null, cityName: city?.name ?? null })
    .returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "salem seo" }).returning();
  return { scope, project, keyword };
}

const result = (x: Awaited<ReturnType<typeof seed>>, date: string, position: number, locationCode: number | null) =>
  db.insert(s.rankResults).values({ ...x.scope, keywordId: x.keyword.id, date, depth: 20, position, locationCode, checkedAt: new Date(`${date}T06:00:00Z`) });

const parsed = (position: number) => ({
  position,
  rankAbsolute: position,
  url: null,
  ownUrls: [],
  serpFeatures: [],
  ownedFeatures: [],
  aiOverview: false,
  aiOverviewCited: false,
  domains: {},
  top: [],
  seResultsCount: 10,
  checkedAt: new Date(),
});

describe.skipIf(!ready)("tracking a city", () => {
  beforeAll(async () => {
    await db
      .insert(s.dfsPlaces)
      .values([
        { ...SALEM, countryIso: "us" },
        { ...ILLINOIS, countryIso: "us" },
        { ...BERLIN, countryIso: "de" },
      ])
      .onConflictDoUpdate({ target: s.dfsPlaces.code, set: { updatedAt: new Date() } });
  });
  beforeEach(() => {
    posts.length = 0;
  });

  it("sends the city's code to task_post and notes it on the run", async () => {
    const x = await seed(SALEM);
    const run = await createRun(x.scope, "manual", { depth: 10, aiOverview: false });
    await postRun(x.scope, run!.id);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("serp/google/organic/task_post");
    expect(posts[0].tasks[0]).toMatchObject({ keyword: "salem seo", location_code: SALEM.code, language_code: "en" });
    const [saved] = await db.select().from(s.rankRuns).where(eq(s.rankRuns.id, run!.id));
    expect(saved.locationCode).toBe(SALEM.code);
  });

  it("keeps searching the country for a project that never picked a city", async () => {
    const x = await seed();
    const run = await createRun(x.scope, "manual", { depth: 10, aiOverview: false });
    await postRun(x.scope, run!.id);
    expect(posts[0].tasks[0]).toMatchObject({ location_code: US });
  });

  it("keeps a run on its place when the project moves before a retry", async () => {
    const x = await seed();
    const run = await createRun(x.scope, "manual", { depth: 10, aiOverview: false });
    await db.update(s.rankRuns).set({ locationCode: US }).where(eq(s.rankRuns.id, run!.id));
    await db.update(s.projects).set({ cityCode: SALEM.code, cityName: SALEM.name }).where(eq(s.projects.id, x.project.id));
    await postRun(x.scope, run!.id);
    expect(posts[0].tasks[0]).toMatchObject({ location_code: US });
  });

  it("gets a city's volume from Google Ads, and never sends Labs a city code", async () => {
    const x = await seed(SALEM);
    await fetchVolumes(x.scope);
    const labs = posts.find((p) => p.path.startsWith("dataforseo_labs/"));
    const ads = posts.find((p) => p.path.includes("google_ads"));
    expect(labs?.tasks[0].location_code).toBe(US);
    expect(ads?.tasks[0].location_code).toBe(SALEM.code);
    const [kw] = await db.select().from(s.rankKeywords).where(eq(s.rankKeywords.id, x.keyword.id));
    expect(kw).toMatchObject({ searchVolume: 390, difficulty: 30, cpc: 4 });
  });

  it("keeps the country's volume and makes no Google Ads call without a city", async () => {
    const x = await seed();
    await fetchVolumes(x.scope);
    expect(posts.some((p) => p.path.includes("google_ads"))).toBe(false);
    const [kw] = await db.select().from(s.rankKeywords).where(eq(s.rankKeywords.id, x.keyword.id));
    expect(kw.searchVolume).toBe(9000);
  });

  it("reserves Labs' price for each batch of volumes: $0.012 a call plus $0.00012 a keyword", async () => {
    const x = await seed();
    await db.insert(s.rankKeywords).values(Array.from({ length: 700 }, (_, i) => ({ ...x.scope, keyword: `kw ${String(i).padStart(3, "0")}` })));
    await fetchVolumes(x.scope);
    const labs = posts.filter((p) => p.path.startsWith("dataforseo_labs/"));
    expect(labs.map((p) => (p.tasks[0].keywords as string[]).length)).toEqual([700, 1]);
    expect(labs[0].estimateUsd).toBeCloseTo(0.012 + 700 * 0.00012, 6);
    expect(labs[1].estimateUsd).toBeCloseTo(0.012 + 0.00012, 6);
  });

  it("reloads volumes after a move", async () => {
    const x = await seed();
    await fetchVolumes(x.scope);
    await rankPlaceChanged(x.scope);
    const [kw] = await db.select().from(s.rankKeywords).where(eq(s.rankKeywords.id, x.keyword.id));
    expect(kw.volumeUpdatedAt).toBeNull();
  });

  it("treats a project's results as one place until it moves", async () => {
    const x = await seed();
    await result(x, "2026-10-20", 40, US);
    await result(x, "2026-10-27", 30, null);
    const state = await loadTracker(x.scope);
    expect(state.place).toMatchObject({ code: US, name: "United States", current: true, checks: 2 });
    expect(state.places).toHaveLength(1);
    expect(state.dates).toEqual(["2026-10-27", "2026-10-20"]);
  });

  it("starts a new baseline after a move and keeps the earlier place readable", async () => {
    const x = await seed();
    await result(x, "2026-10-20", 40, US);
    await result(x, "2026-10-27", 30, US);
    await db.update(s.projects).set({ cityCode: SALEM.code, cityName: SALEM.name }).where(eq(s.projects.id, x.project.id));

    // Moved, nothing checked from there yet: no numbers rather than the old place's.
    const waiting = await loadTracker(x.scope);
    expect(waiting.place).toMatchObject({ code: SALEM.code, name: SALEM.name, current: true, checks: 0 });
    expect(waiting.dates).toEqual([]);

    await result(x, "2026-10-28", 3, SALEM.code);
    await result(x, "2026-10-29", 2, SALEM.code);
    const now = await loadTracker(x.scope);
    expect(now.places.map((p) => p.code)).toEqual([SALEM.code, US]);
    expect(now.dates).toEqual(["2026-10-29", "2026-10-28"]);
    const win = resolveWindow(now.dates, 30)!;
    expect(win).toEqual({ start: "2026-10-28", end: "2026-10-29" });
    expect((await loadResults(x.scope, win.start, win.end, now.place)).map((r) => r.position)).toEqual([3, 2]);

    const earlier = await loadTracker(x.scope, String(US));
    expect(earlier.place).toMatchObject({ code: US, name: "United States", current: false, first: "2026-10-20", last: "2026-10-27" });
    expect(earlier.dates).toEqual(["2026-10-27", "2026-10-20"]);
    expect((await keywordHistory(x.keyword, "2000-01-01", earlier.place)).map((r) => r.position)).toEqual([40, 30]);

    // A place it has no results from falls back to the current one.
    expect((await loadTracker(x.scope, "12345")).place.code).toBe(SALEM.code);
  });

  it("lets a result from a new place replace the day's row, even a deeper one", async () => {
    const x = await seed();
    const run = await createRun(x.scope, "manual", { depth: 100, aiOverview: false });
    const task = { ...x.scope, keywordId: x.keyword.id, runId: run!.id, date: "2026-11-03" };
    await storeResult({ ...task, depth: 100, locationCode: US }, parsed(40));
    await storeResult({ ...task, depth: 10, locationCode: SALEM.code }, parsed(3));
    const [row] = await db
      .select()
      .from(s.rankResults)
      .where(and(eq(s.rankResults.keywordId, x.keyword.id), eq(s.rankResults.date, task.date)));
    expect(row).toMatchObject({ position: 3, depth: 10, locationCode: SALEM.code });
    // Within one place, the deeper check still wins.
    await storeResult({ ...task, depth: 100, locationCode: SALEM.code }, parsed(4));
    await storeResult({ ...task, depth: 10, locationCode: SALEM.code }, parsed(9));
    const [again] = await db.select().from(s.rankResults).where(eq(s.rankResults.keywordId, x.keyword.id));
    expect(again).toMatchObject({ position: 4, depth: 100 });
  });
});

describe.skipIf(!ready)("a project's city", () => {
  const usProject = { locationCode: US, cityCode: null, cityName: null };

  it("reads the form's values", () => {
    const base = { domain: "example.com", locationCode: "2840", languageCode: "en" };
    expect(projectInput.parse({ ...base, cityCode: "" }).cityCode).toBeNull();
    expect(projectInput.parse({ ...base, cityCode: String(SALEM.code) }).cityCode).toBe(SALEM.code);
    expect(projectInput.parse(base).cityCode).toBeUndefined();
    expect(projectInput.safeParse({ ...base, cityCode: "-3" }).success).toBe(false);
  });

  it("takes a city of the project's country, with its stored name", async () => {
    expect(await projectCity({ locationCode: US, cityCode: SALEM.code }, usProject)).toEqual({ cityCode: SALEM.code, cityName: SALEM.name });
  });

  it("refuses a city of another country, or an unknown one", async () => {
    await expect(projectCity({ locationCode: US, cityCode: BERLIN.code }, usProject)).rejects.toBeInstanceOf(OpError);
    await expect(projectCity({ locationCode: US, cityCode: 999 }, usProject)).rejects.toBeInstanceOf(OpError);
  });

  it("keeps the city when the form doesn't mention one, and drops it with the country", async () => {
    const inSalem = { locationCode: US, cityCode: SALEM.code, cityName: SALEM.name };
    expect(await projectCity({ locationCode: US }, inSalem)).toEqual({ cityCode: SALEM.code, cityName: SALEM.name });
    expect(await projectCity({ locationCode: 2276 }, inSalem)).toEqual({ cityCode: null, cityName: null });
    expect(await projectCity({ locationCode: US, cityCode: null }, inSalem)).toEqual({ cityCode: null, cityName: null });
  });
});

describe.skipIf(!ready)("the city of a keyword lookup", () => {
  const m = { locationCode: US, languageCode: "en" };
  const project = { locationCode: US, cityCode: SALEM.code, cityName: SALEM.name };

  it("starts on the project's city", async () => {
    expect(await researchCity(undefined, m, project)).toEqual({ city: SALEM, param: SALEM.code });
  });
  it("can be turned off, and stays off in links", async () => {
    expect(await researchCity("0", m, project)).toEqual({ city: null, param: 0 });
  });
  it("takes another city of the market, not one elsewhere", async () => {
    expect((await researchCity(String(ILLINOIS.code), m, project)).city).toEqual(ILLINOIS);
    expect((await researchCity(String(BERLIN.code), m, project)).city).toBeNull();
  });
  it("doesn't use the project's city in another market", async () => {
    expect((await researchCity(undefined, { locationCode: 2276, languageCode: "de" }, project)).city).toBeNull();
  });
  it("has no city for a project without one", async () => {
    expect(await researchCity(undefined, m, { locationCode: US, cityCode: null, cityName: null })).toEqual({ city: null, param: undefined });
  });
});
