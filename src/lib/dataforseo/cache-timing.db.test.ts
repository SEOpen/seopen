import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * What a shared cache hit says about other workspaces, against seopen_test: nothing. The time a
 * page shows is the reader's own, and another workspace refreshing a live answer doesn't take the
 * reader's free view away. `fetch` is stubbed, so nothing reaches DataForSEO.
 */

const ready = await testDb();

const { db } = await import("@/db");
const { apiCache, apiCacheAccess, workspaces, workspaceSettings } = await import("@/db/schema");
const { dfsPost, peekCache, workspaceCacheKey } = await import("./client");

const SHARED_PATH = "dataforseo_labs/google/keyword_overview/live";
const DAY = 86_400_000;

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: `timing-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  return ws.id;
}

/** A shared answer `payer` fetched three days ago, live for a day more. */
async function seedOld(payer: number) {
  const body = [{ keywords: [randomUUID()], location_code: 2840, language_code: "en" }];
  const key = workspaceCacheKey(payer, "POST", SHARED_PATH, body);
  const then = new Date(Date.now() - 3 * DAY);
  const response = { status_code: 20000, status_message: "Ok.", cost: 0.05, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, result: ["old"] }] };
  await db.insert(apiCache).values({ key, endpoint: SHARED_PATH, response, expiresAt: new Date(Date.now() + DAY), createdAt: then });
  await db.insert(apiCacheAccess).values({ key, workspaceId: payer, paidAt: then });
  return { body, key, then };
}

/** DataForSEO answering a fresh lookup. */
function answering(result: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.05, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, result: [result] }] }))),
  );
}

const access = (key: string, workspaceId: number) => db.select().from(apiCacheAccess).where(and(eq(apiCacheAccess.key, key), eq(apiCacheAccess.workspaceId, workspaceId)));

describe.skipIf(!ready)("shared cache timing", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  it("shows a workspace the time it paid, never when another workspace fetched", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body, then } = await seedOld(A);
    const before = Date.now();
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 3600 });
    const b = await peekCache(B, "POST", SHARED_PATH, body);
    expect(b!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The workspace that fetched still sees its own time.
    expect((await peekCache(A, "POST", SHARED_PATH, body))!.createdAt.getTime()).toBe(then.getTime());
  });

  it("keeps a payer's free view when another workspace refreshes a live answer", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body, key } = await seedOld(A);
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 3600 });
    const paid = (await peekCache(B, "POST", SHARED_PATH, body))!.createdAt;

    answering("new");
    await dfsPost(SHARED_PATH, body, { workspaceId: A, module: "keywords", ttlSeconds: 3600, force: true });

    const b = await peekCache(B, "POST", SHARED_PATH, body);
    expect(b).not.toBeNull();
    expect(b!.createdAt.getTime()).toBe(paid.getTime());
    // The one that refreshed paid again, at a new time.
    expect((await access(key, A))[0].paidAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("makes everyone pay again once the answer expired", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body, key } = await seedOld(A);
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 3600 });
    await db.update(apiCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiCache.key, key));

    answering("new");
    await dfsPost(SHARED_PATH, body, { workspaceId: A, module: "keywords", ttlSeconds: 3600 });

    expect(await peekCache(B, "POST", SHARED_PATH, body)).toBeNull();
    expect(await peekCache(A, "POST", SHARED_PATH, body)).not.toBeNull();
  });
});
