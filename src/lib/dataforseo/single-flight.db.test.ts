import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * One lookup, one fetch, against seopen_test: calls that share a cache key while one of
 * them is fetching wait for its answer instead of paying DataForSEO again, and are charged as a
 * double click always was. A claim whose caller died lapses, and a failed fetch lets the next call
 * try. `fetch` is stubbed, so nothing reaches DataForSEO.
 */

const ready = await testDb();

const { db } = await import("@/db");
const { apiCacheClaims, apiLedger, workspaces, workspaceSettings } = await import("@/db/schema");
const { DataForSEOError, dfsPost, LookupInFlightError, monthToDateSpendUsd, workspaceCacheKey } = await import("./client");
const { purgeExpiredClaims } = await import("./claims");
const { monthUsage } = await import("@/lib/billing/usage");

// A shared endpoint, so calls from two workspaces share one key.
const PATH = "dataforseo_labs/google/domain_rank_overview/live";

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: `single-flight-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  return ws.id;
}

const ledgerOf = (ids: number[]) => db.select().from(apiLedger).where(inArray(apiLedger.workspaceId, ids));
const claimOn = async (key: string) => (await db.select().from(apiCacheClaims).where(eq(apiCacheClaims.key, key)))[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new lookup: the target is random, so no other test or file has its key. */
function lookup() {
  const body = [{ target: `${randomUUID()}.example`, location_code: 2840, language_code: "en" }];
  return { body, key: workspaceCacheKey(0, "POST", PATH, body) };
}

const call = (workspaceId: number, body: object[]) =>
  dfsPost(PATH, body, { workspaceId, module: "domains", ttlSeconds: 3600, estimateUsd: 0.05, maxChargeUsd: 0.05, retries: 0 });

function gate() {
  let open = () => {};
  const shut = new Promise<void>((r) => (open = r));
  return { shut, open };
}

const okBody = (cost: number) =>
  JSON.stringify({ status_code: 20000, status_message: "Ok.", cost, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, result: [] }] });

/** DataForSEO answering each request with this cost, once `waitFor` has resolved. */
function dataforseo(cost: number, waitFor?: Promise<unknown>) {
  const spy = vi.fn(async () => {
    await waitFor;
    return new Response(okBody(cost));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** A claim held by a caller that isn't this test's, ending `seconds` from now (negative: already lapsed). */
async function foreignClaim(key: string, seconds: number) {
  const token = randomUUID();
  await db.insert(apiCacheClaims).values({ key, token, expiresAt: sql`now() + make_interval(secs => ${seconds})` });
  return token;
}

describe.skipIf(!ready)("one fetch per lookup in flight", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("fetches once and charges once when the same new lookup runs five times at once", async () => {
    const ws = await workspace();
    const { body, key } = lookup();
    const { shut, open } = gate();
    const spy = dataforseo(0.03, shut);
    const runs = Array.from({ length: 5 }, () => call(ws, body));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    // Time for the other four to reach the claim. Without the claim they would all have fetched by now.
    await sleep(500);
    open();
    const results = await Promise.all(runs);

    expect(spy).toHaveBeenCalledTimes(1);
    // DataForSEO billed once, and the workspace pays once.
    expect(await ledgerOf([ws])).toMatchObject([{ costUsd: 0.03, chargedUsd: 0.03 }]);
    expect(await monthToDateSpendUsd(ws)).toBeCloseTo(0.03);
    expect((await monthUsage(ws)).spentUsd).toBeCloseTo(0.03);
    expect((await monthUsage(ws)).reservedUsd).toBeCloseTo(0);
    // The four that waited read the answer the workspace had just paid for.
    expect(results.filter((r) => r.cached)).toHaveLength(4);
    expect(await claimOn(key)).toBeUndefined();
  });

  it("charges a second workspace waiting on the same shared lookup as a shared cache hit", async () => {
    const [a, b] = [await workspace(), await workspace()];
    const { body } = lookup();
    const { shut, open } = gate();
    const spy = dataforseo(0.03, shut);
    const runs = [call(a, body), call(b, body)];
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await sleep(500);
    open();
    const results = await Promise.all(runs);

    expect(spy).toHaveBeenCalledTimes(1);
    // One paid DataForSEO; the other is charged the original price, as for any shared hit, and told nothing.
    const rows = await ledgerOf([a, b]);
    expect(rows.map((r) => [r.costUsd, r.chargedUsd]).sort()).toEqual([
      [0, 0.03],
      [0.03, 0.03],
    ]);
    expect(results.every((r) => !r.cached)).toBe(true);
  });

  it("takes over a claim whose caller died", async () => {
    const ws = await workspace();
    const { body, key } = lookup();
    await foreignClaim(key, -5);
    const spy = dataforseo(0.03);
    await call(ws, body);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await ledgerOf([ws])).toMatchObject([{ costUsd: 0.03, chargedUsd: 0.03 }]);
    expect(await claimOn(key)).toBeUndefined();
  });

  it("waits for a live claim to lapse, then fetches", async () => {
    const ws = await workspace();
    const { body, key } = lookup();
    await foreignClaim(key, 1.5);
    const spy = dataforseo(0.03);
    const run = call(ws, body);
    await sleep(700);
    expect(spy).not.toHaveBeenCalled();
    await run;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await claimOn(key)).toBeUndefined();
  });

  it("lets the next call try once a fetch has failed", async () => {
    const ws = await workspace();
    const { body, key } = lookup();
    const { shut, open } = gate();
    let firstFailed = false;
    const startedAfterFailure: boolean[] = [];
    const spy = vi.fn(async () => {
      startedAfterFailure.push(firstFailed);
      if (spy.mock.calls.length > 1) return new Response(okBody(0.03));
      await shut;
      firstFailed = true;
      return new Response("upstream down", { status: 500 });
    });
    vi.stubGlobal("fetch", spy);

    const runs = [call(ws, body), call(ws, body)].map((p) => p.then((r) => r, (e: unknown) => e));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await sleep(500);
    open();
    const [first, second] = await Promise.all(runs);

    expect(spy).toHaveBeenCalledTimes(2);
    // The second fetch waited for the first to fail instead of running beside it.
    expect(startedAfterFailure).toEqual([false, true]);
    expect([first, second].filter((r) => r instanceof DataForSEOError && r.statusCode === 500)).toHaveLength(1);
    const rows = await ledgerOf([ws]);
    expect(rows.map((r) => [r.statusCode, r.chargedUsd]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([
      [500, 0],
      [20000, 0.03],
    ]);
    expect((await monthUsage(ws)).reservedUsd).toBeCloseTo(0);
    expect(await claimOn(key)).toBeUndefined();
  });

  it("gives up with a clear error, without fetching, when another call still holds the claim", async () => {
    const ws = await workspace();
    const { body, key } = lookup();
    const token = await foreignClaim(key, 600);
    const spy = dataforseo(0.03);
    // Only the clock the wait reads moves; the claim's own expiry is the database's.
    vi.useFakeTimers({ toFake: ["Date"] });
    const run = call(ws, body).then((r) => r, (e: unknown) => e);
    await sleep(300);
    vi.setSystemTime(Date.now() + 3_600_000);
    const outcome = await run;
    vi.useRealTimers();

    expect(outcome).toBeInstanceOf(LookupInFlightError);
    expect(spy).not.toHaveBeenCalled();
    expect(await ledgerOf([ws])).toEqual([]);
    expect((await claimOn(key))?.token).toBe(token);
  });

  it("purges claims that have lapsed and keeps live ones", async () => {
    const [dead, live] = [lookup().key, lookup().key];
    await foreignClaim(dead, -60);
    await foreignClaim(live, 600);
    expect(await purgeExpiredClaims()).toBeGreaterThanOrEqual(1);
    expect(await claimOn(dead)).toBeUndefined();
    expect(await claimOn(live)).toBeDefined();
    await db.delete(apiCacheClaims).where(eq(apiCacheClaims.key, live));
  });
});
