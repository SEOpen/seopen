import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The shared response cache, against seopen_test: a workspace that didn't pay for a shared hit is
 * charged its original cost (never served it for free), and a private endpoint's cache is never
 * shared. Nothing here reaches DataForSEO: `fetch` is stubbed to fail the test if it's called.
 */

const ready = await testDb();

const { db } = await import("@/db");
const { apiCache, apiCacheAccess, apiLedger, workspaces, workspaceSettings } = await import("@/db/schema");
const { BudgetExceededError, dfsPost, monthToDateSpendUsd, peekCache, workspaceCacheKey } = await import("./client");

const SHARED_PATH = "dataforseo_labs/google/keyword_overview/live";
const PRIVATE_PATH = "ai_optimization/chat_gpt/llm_responses/live";

async function workspace(cap: number) {
  const [ws] = await db.insert(workspaces).values({ name: `cache-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: cap });
  return ws.id;
}

/** A cached response that `payer` paid for. The body is random so each test owns its row. */
async function seedCache(path: string, payer: number, tasks: unknown[] = []) {
  const body = [{ keywords: [randomUUID()], location_code: 2840, language_code: "en" }];
  const key = workspaceCacheKey(payer, "POST", path, body);
  const response = { status_code: 20000, status_message: "Ok.", cost: 0.05, tasks_count: 1, tasks_error: 0, tasks };
  await db.insert(apiCache).values({ key, endpoint: path, response, expiresAt: new Date(Date.now() + 86_400_000) });
  await db.insert(apiCacheAccess).values({ key, workspaceId: payer });
  return { body, key };
}

const ledgerOf = (workspaceId: number) => db.select().from(apiLedger).where(eq(apiLedger.workspaceId, workspaceId));

describe.skipIf(!ready)("shared cache charging", () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error("DataForSEO must not be called");
  });
  let A: number;
  let B: number;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    A = await workspace(25);
    B = await workspace(25);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("treats a saved response whose task failed as a miss, so a retry asks DataForSEO again", async () => {
    // DataForSEO said 20000 and tasks_error 0 around a task that failed (Nov 16 2026).
    const { body } = await seedCache(SHARED_PATH, A, [{ id: "t", status_code: 40101, status_message: "Internal SE Server Error.", cost: 0, path: [], data: {}, result: null }]);
    expect(await peekCache(A, "POST", SHARED_PATH, body)).toBeNull();
  });

  it("charges a workspace that didn't pay for a shared hit, once", async () => {
    const { body, key } = await seedCache(SHARED_PATH, A);
    const before = await monthToDateSpendUsd(A);

    // Peeking is free, so it only shows what the workspace already paid for.
    expect(await peekCache(B, "POST", SHARED_PATH, body)).toBeNull();
    expect((await peekCache(A, "POST", SHARED_PATH, body))?.response.cost).toBe(0.05);

    // B is charged like a fresh lookup and told nothing else: "cached" would say someone else looked it up.
    const res = await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 3600 });
    expect(res.cached).toBe(false);
    expect(res.chargedUsd).toBe(0.05);
    const rows = await ledgerOf(B);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costUsd: 0, chargedUsd: 0.05, endpoint: SHARED_PATH });

    // Now B has paid: the next hit is B's own, free, cached and not recorded again.
    const again = await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 3600 });
    expect(again.cached).toBe(true);
    expect(again.chargedUsd).toBeUndefined();
    expect(await ledgerOf(B)).toHaveLength(1);
    expect(await peekCache(B, "POST", SHARED_PATH, body)).not.toBeNull();
    const access = await db.select().from(apiCacheAccess).where(eq(apiCacheAccess.key, key));
    expect(access.map((r) => r.workspaceId).sort()).toEqual([A, B].sort());

    expect(await monthToDateSpendUsd(B)).toBeCloseTo(0.05);
    expect(await monthToDateSpendUsd(A)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the payer's own repeat lookup as cached and free", async () => {
    const { body } = await seedCache(SHARED_PATH, A);
    const res = await dfsPost(SHARED_PATH, body, { workspaceId: A, module: "keywords", ttlSeconds: 3600 });
    expect(res.cached).toBe(true);
    expect(res.chargedUsd).toBeUndefined();
    expect(await ledgerOf(A)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a shared hit that would pass the workspace's cap, and records nothing", async () => {
    const poor = await workspace(0.01);
    const { body, key } = await seedCache(SHARED_PATH, A);
    await expect(dfsPost(SHARED_PATH, body, { workspaceId: poor, module: "keywords", ttlSeconds: 3600 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await ledgerOf(poor)).toEqual([]);
    expect(await db.select().from(apiCacheAccess).where(and(eq(apiCacheAccess.key, key), eq(apiCacheAccess.workspaceId, poor)))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a private endpoint's cache per workspace", async () => {
    const { body, key } = await seedCache(PRIVATE_PATH, A);
    expect(key.startsWith(`w${A}:`)).toBe(true);
    expect(workspaceCacheKey(B, "POST", PRIVATE_PATH, body)).not.toBe(key);
    expect(await peekCache(B, "POST", PRIVATE_PATH, body)).toBeNull();
    expect((await peekCache(A, "POST", PRIVATE_PATH, body))?.response.cost).toBe(0.05);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
