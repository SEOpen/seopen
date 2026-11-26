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
// The life these lookups ask for: longer than the seeded answer is old, so it is still theirs to read.
const WEEK = 7 * 86_400;

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
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: WEEK });
    const b = await peekCache(B, "POST", SHARED_PATH, body);
    expect(b!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The workspace that fetched still sees its own time.
    expect((await peekCache(A, "POST", SHARED_PATH, body))!.createdAt.getTime()).toBe(then.getTime());
  });

  it("keeps a payer's free view when another workspace refreshes a live answer", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body, key } = await seedOld(A);
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: WEEK });
    const paid = (await peekCache(B, "POST", SHARED_PATH, body))!.createdAt;

    answering("new");
    await dfsPost(SHARED_PATH, body, { workspaceId: A, module: "keywords", ttlSeconds: WEEK, force: true });

    const b = await peekCache(B, "POST", SHARED_PATH, body);
    expect(b).not.toBeNull();
    expect(b!.createdAt.getTime()).toBe(paid.getTime());
    // The one that refreshed paid again, at a new time.
    expect((await access(key, A))[0].paidAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("fetches again for a call that asks for a shorter life than the saved answer is old", async () => {
    const [A, B] = [await workspace(), await workspace()];
    // Three days old, kept by a call that asked for longer.
    const { body, key, then } = await seedOld(A);
    const fetched = () => vi.mocked(fetch).mock.calls.length;

    answering("new");
    // Too old for a day-long lookup, from another workspace or the one that paid for it.
    expect(await peekCache(A, "POST", SHARED_PATH, body, 86_400)).toBeNull();
    expect(await peekCache(B, "POST", SHARED_PATH, body, 86_400)).toBeNull();
    const res = await dfsPost<string>(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 86_400 });
    expect(fetched()).toBe(1);
    expect(res.tasks?.[0].result).toEqual(["new"]);
    const [row] = await db.select().from(apiCache).where(eq(apiCache.key, key));
    expect(row.createdAt.getTime()).toBeGreaterThan(then.getTime());

    // The new answer serves the next day-long lookup, and a week-long one, without another fetch.
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: 86_400 });
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: WEEK });
    expect(fetched()).toBe(1);
    expect(await peekCache(B, "POST", SHARED_PATH, body, 86_400)).not.toBeNull();
  });

  it("still serves a saved answer to a call whose life covers its age", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body } = await seedOld(A);
    answering("new");
    const res = await dfsPost<string>(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: WEEK });
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
    expect(res.tasks?.[0].result).toEqual(["old"]);
    expect(await peekCache(A, "POST", SHARED_PATH, body, WEEK)).not.toBeNull();
  });

  it("makes everyone pay again once the answer expired", async () => {
    const [A, B] = [await workspace(), await workspace()];
    const { body, key } = await seedOld(A);
    await dfsPost(SHARED_PATH, body, { workspaceId: B, module: "keywords", ttlSeconds: WEEK });
    await db.update(apiCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiCache.key, key));

    answering("new");
    await dfsPost(SHARED_PATH, body, { workspaceId: A, module: "keywords", ttlSeconds: WEEK });

    expect(await peekCache(B, "POST", SHARED_PATH, body)).toBeNull();
    expect(await peekCache(A, "POST", SHARED_PATH, body)).not.toBeNull();
  });
});
