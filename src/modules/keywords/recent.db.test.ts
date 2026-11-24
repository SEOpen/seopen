import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Which cached lookups the Overview tab lists, against seopen_test. Nothing here reaches DataForSEO. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { apiCache, apiCacheAccess, workspaces } = await import("@/db/schema");
const { inArray } = await import("drizzle-orm");
const { keywordOverviewSpec } = await import("./requests");
const { recentLookups } = await import("./recent");

const US = { locationCode: 2840, languageCode: "en" } as Parameters<typeof keywordOverviewSpec>[1];
const PATH = keywordOverviewSpec("", US).path;
const DAY = 86_400_000;
const keys: string[] = [];

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: `recent-${randomUUID()}`, plan: "internal" }).returning();
  return ws.id;
}

async function seed(
  workspaceId: number,
  keywords: string[],
  { paidDaysAgo = 1, expiresInDays = 29, location = 2840, endpoint = PATH, item = { keyword_info: { search_volume: 900 }, keyword_properties: { keyword_difficulty: 41 } } as object | null } = {},
) {
  const key = randomUUID();
  keys.push(key);
  const response = {
    tasks: [{ data: { keywords, location_code: location, language_code: "en" }, result: [{ items: item ? [item] : null }] }],
  };
  await db.insert(apiCache).values({ key, endpoint, response, expiresAt: new Date(Date.now() + expiresInDays * DAY) });
  await db.insert(apiCacheAccess).values({ key, workspaceId, paidAt: new Date(Date.now() - paidDaysAgo * DAY) });
}

describe.skipIf(!ready)("recent keyword lookups", () => {
  let A: number;
  let B: number;

  beforeAll(async () => {
    A = await workspace();
    B = await workspace();
  });

  afterAll(async () => {
    await db.delete(apiCacheAccess).where(inArray(apiCacheAccess.key, keys));
    await db.delete(apiCache).where(inArray(apiCache.key, keys));
    await db.delete(workspaces).where(inArray(workspaces.id, [A, B]));
  });

  it("lists a keyword with its metrics, newest first", async () => {
    await seed(A, ["older one"], { paidDaysAgo: 5 });
    await seed(A, ["newer one"], { paidDaysAgo: 1 });
    const rows = await recentLookups(A, US);
    expect(rows.map((r) => r.keyword)).toEqual(["newer one", "older one"]);
    expect(rows[0]).toMatchObject({ volume: 900, kd: 41 });
  });

  it("keeps a keyword that came back with no data, with no numbers", async () => {
    const ws = await workspace();
    await seed(ws, ["no data"], { item: null });
    expect(await recentLookups(ws, US)).toMatchObject([{ keyword: "no data", volume: null, kd: null }]);
    await db.delete(apiCacheAccess).where(inArray(apiCacheAccess.key, keys.slice(-1)));
    await db.delete(workspaces).where(inArray(workspaces.id, [ws]));
  });

  it("reads a difficulty of 0 as unknown, as the keyword tools do", async () => {
    const ws = await workspace();
    await seed(ws, ["unscored"], { item: { keyword_info: { search_volume: 480 }, keyword_properties: { keyword_difficulty: 0 } } });
    expect(await recentLookups(ws, US)).toMatchObject([{ keyword: "unscored", volume: 480, kd: null }]);
    await db.delete(apiCacheAccess).where(inArray(apiCacheAccess.key, keys.slice(-1)));
    await db.delete(workspaces).where(inArray(workspaces.id, [ws]));
  });

  it("never shows another workspace's lookups", async () => {
    const ws = await workspace();
    expect(await recentLookups(ws, US)).toEqual([]);
    expect((await recentLookups(B, US)).length).toBe(0);
    await db.delete(workspaces).where(inArray(workspaces.id, [ws]));
  });

  it("leaves out old, expired, batch, other market and other endpoint rows", async () => {
    await seed(B, ["too old"], { paidDaysAgo: 8 });
    await seed(B, ["expired"], { expiresInDays: -1 });
    await seed(B, ["one", "two"]);
    await seed(B, ["other market"], { location: 2826 });
    await seed(B, ["other endpoint"], { endpoint: "serp/google/organic/live/advanced" });
    expect(await recentLookups(B, US)).toEqual([]);
  });
});
