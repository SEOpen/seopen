import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * What a shown price promises, against seopen_test: a lookup never charges more than its button
 * said, whatever DataForSEO bills, and the same lookup run twice at once is charged once. The real
 * cost stays on record for the platform cap. `fetch` is stubbed, so nothing reaches DataForSEO.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { apiLedger, workspaces, workspaceSettings } = await import("@/db/schema");
const { dfsPost, monthToDateSpendUsd } = await import("./client");
const { load } = await import("@/modules/keywords/dfs");
const { monthUsage } = await import("@/lib/billing/usage");

const PATH = "dataforseo_labs/google/domain_rank_overview/live";

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: `ceiling-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  return ws.id;
}

const ledgerOf = (workspaceId: number) => db.select().from(apiLedger).where(eq(apiLedger.workspaceId, workspaceId));
const task = () => ({ target: `${randomUUID()}.example`, location_code: 2840, language_code: "en" });

/** DataForSEO answering with this cost, after `waitFor` if given. */
function billing(cost: number, waitFor?: Promise<unknown>) {
  const spy = vi.fn(async () => {
    await waitFor;
    return new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, result: [] }] }));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe.skipIf(!ready)("what a shown price promises", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  it("charges the real cost when it's under the price shown", async () => {
    const ws = await workspace();
    billing(0.02);
    await load({ path: PATH, task: task(), ttlSeconds: 3600, estUsd: 0.05, module: "domains" }, { run: true, workspaceId: ws });
    expect(await ledgerOf(ws)).toMatchObject([{ costUsd: 0.02, chargedUsd: 0.02 }]);
  });

  it("charges only the price shown when DataForSEO bills more, and keeps the real cost on record", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ws = await workspace();
    billing(0.5);
    await load({ path: PATH, task: task(), ttlSeconds: 3600, estUsd: 0.05, module: "domains" }, { run: true, workspaceId: ws });
    expect(await ledgerOf(ws)).toMatchObject([{ costUsd: 0.5, chargedUsd: 0.05 }]);
    expect(await monthToDateSpendUsd(ws)).toBeCloseTo(0.05);
    expect((await monthUsage(ws)).spentUsd).toBeCloseTo(0.05);
    // So the wrong estimate gets noticed.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("more than the $0.05 shown"));
    log.mockRestore();
  });

  it("doesn't cap a call that wasn't shown a price", async () => {
    const ws = await workspace();
    billing(0.5);
    await dfsPost(PATH, [task()], { workspaceId: ws, module: "domains", ttlSeconds: 3600, estimateUsd: 0.05 });
    expect(await ledgerOf(ws)).toMatchObject([{ costUsd: 0.5, chargedUsd: 0.5 }]);
  });

  it("caps a shared cached response another workspace paid more for", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const [payer, reader] = [await workspace(), await workspace()];
    const body = task();
    billing(0.5);
    await dfsPost(PATH, [body], { workspaceId: payer, module: "domains", ttlSeconds: 3600, estimateUsd: 0.5 });
    const fetched = billing(0);
    await dfsPost(PATH, [body], { workspaceId: reader, module: "domains", ttlSeconds: 3600, estimateUsd: 0.05, maxChargeUsd: 0.05 });
    expect(fetched).not.toHaveBeenCalled();
    expect(await ledgerOf(reader)).toMatchObject([{ costUsd: 0, chargedUsd: 0.05 }]);
    log.mockRestore();
  });

  it("charges the same lookup once when it runs twice at the same time", async () => {
    const ws = await workspace();
    let answer = () => {};
    const bothSent = new Promise<void>((r) => (answer = r));
    const spy = billing(0.03, bothSent);
    const spec = { path: PATH, task: task(), ttlSeconds: 3600, estUsd: 0.05, module: "domains" as const };
    const runs = [load(spec, { run: true, workspaceId: ws }), load(spec, { run: true, workspaceId: ws })];
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    // Time for the second to reach the first one's claim and wait (single-flight.db.test.ts).
    await new Promise((r) => setTimeout(r, 300));
    answer();
    await Promise.all(runs);

    // The second waited for the first one's answer, so DataForSEO billed once and the customer pays once.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await ledgerOf(ws)).toMatchObject([{ costUsd: 0.03, chargedUsd: 0.03 }]);
    expect(await monthToDateSpendUsd(ws)).toBeCloseTo(0.03);
    expect((await monthUsage(ws)).spentUsd).toBeCloseTo(0.03);
    expect((await monthUsage(ws)).reservedUsd).toBeCloseTo(0);
  });

  it("charges a later lookup again once the saved one has expired", async () => {
    const ws = await workspace();
    const spec = { path: PATH, task: task(), ttlSeconds: 3600, estUsd: 0.05, module: "domains" as const };
    billing(0.03);
    await load(spec, { run: true, workspaceId: ws });
    // force is how a call goes past a saved response, as an expired one does.
    await dfsPost(PATH, [spec.task], { workspaceId: ws, module: "domains", ttlSeconds: 3600, force: true, estimateUsd: 0.05, maxChargeUsd: 0.05 });
    expect((await ledgerOf(ws)).map((r) => r.chargedUsd)).toEqual([0.03, 0.03]);
  });
});
