import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A project's weekly snapshot after a failed call, against seopen_test: each attempt runs as
 * the worker runs it, and `fetch` is stubbed, so nothing reaches DataForSEO. A retry must pass the
 * billing check again and must not pay twice for an answer it already has.
 */

vi.mock("server-only", () => ({}));
// A 402 here would write the one platform-wide payment row that balance.db.test.ts reads.
vi.mock("@/lib/dataforseo/balance", async (orig) => ({
  ...(await orig<typeof import("@/lib/dataforseo/balance")>()),
  notePaymentRequired: async () => {},
  noteDailyLimit: async () => {},
}));

const ready = await testDb();

const { db } = await import("@/db");
const { apiLedger, backlinksSnapshots, projects, workspaceJobPauses, workspaces, workspaceSettings, workspaceUsage } = await import("@/db/schema");
const { withBillingContext } = await import("@/lib/billing/context");
const { jobs } = await import("./jobs");

const NAME = "backlinks.snapshot";
const job = jobs.find((j) => j.name === NAME)!;
const SUMMARY = { target: "x", rank: 10, backlinks: 50, referring_domains: 7, referring_main_domains: 6, backlinks_spam_score: 3, broken_backlinks: 0, referring_links_attributes: { nofollow: 1 } };
const answer = { status_code: 20000, status_message: "Ok.", cost: 0.02, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, cost: 0.02, result: [SUMMARY] }] };
const ok = () => new Response(JSON.stringify(answer));

async function project() {
  const [ws] = await db.insert(workspaces).values({ name: `snapshot-retry-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  const domain = `${randomUUID().slice(0, 8)}.example.com`;
  const [p] = await db.insert(projects).values({ workspaceId: ws.id, name: "site", domain }).returning();
  return { workspaceId: ws.id, projectId: p.id, domain };
}

/** One attempt, as the worker runs it: in the job's billing context, with its retry count. */
const attempt = (payload: { workspaceId: number; projectId: number }, retryCount: number) =>
  withBillingContext({ job: { name: NAME, data: payload } }, () => job.handler(payload, { retryCount } as never));

const snapshotsOf = (projectId: number) => db.select().from(backlinksSnapshots).where(eq(backlinksSnapshots.projectId, projectId));
const ledgerOf = (workspaceId: number) => db.select().from(apiLedger).where(eq(apiLedger.workspaceId, workspaceId));

describe.skipIf(!ready)("a weekly backlinks snapshot that failed", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("throws on a 402, so pg-boss retries it, and the retry files the snapshot", async () => {
    const p = await project();
    const fetch = vi.fn(async () => new Response("", { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(attempt(p, 0)).rejects.toThrow("HTTP 402");
    expect(await snapshotsOf(p.projectId)).toEqual([]);

    fetch.mockImplementation(async () => ok());
    await attempt(p, 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await snapshotsOf(p.projectId)).toMatchObject([{ backlinks: 50, referringDomains: 7 }]);
    const ledger = await ledgerOf(p.workspaceId);
    expect(ledger.map((r) => Number(r.statusCode)).sort((a, b) => a - b)).toEqual([402, 20000]);
    expect(ledger.find((r) => r.statusCode === 402)?.chargedUsd).toBe(0);
  });

  it("ends a request DataForSEO refused without throwing, so it isn't retried", async () => {
    const p = await project();
    const refused = { ...answer, cost: 0, tasks_error: 1, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'target'.", cost: 0, result: null }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refused))));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(attempt(p, 0)).resolves.toEqual({ failed: "Invalid Field: 'target'." });
    expect(await snapshotsOf(p.projectId)).toEqual([]);
  });

  it("doesn't pay again on a retry after the paid call worked", async () => {
    const p = await project();
    const fetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetch);
    // The call succeeds and its answer is saved, then filing the snapshot fails once.
    const insert = db.insert.bind(db);
    const spy = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      if (table === backlinksSnapshots) throw new Error("connection reset");
      return insert(table);
    }) as typeof db.insert);
    await expect(attempt(p, 0)).rejects.toThrow("connection reset");
    spy.mockRestore();

    await attempt(p, 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await snapshotsOf(p.projectId)).toMatchObject([{ backlinks: 50 }]);
    const charged = (await ledgerOf(p.workspaceId)).reduce((s, r) => s + r.chargedUsd, 0);
    expect(charged).toBeCloseTo(0.02);
  });

  it("checks the workspace's cap again on a retry, and pauses instead of calling", async () => {
    const p = await project();
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(attempt(p, 0)).rejects.toThrow("fetch failed");
    const calls = fetch.mock.calls.length;

    // Before the retry runs, the workspace's other work spends its whole cap.
    await db
      .insert(workspaceUsage)
      .values({ workspaceId: p.workspaceId, month: sql`date_trunc('month', now())::date`, spentUsd: 25 })
      .onConflictDoUpdate({ target: [workspaceUsage.workspaceId, workspaceUsage.month], set: { spentUsd: 25 } });
    expect(await attempt(p, 1)).toMatchObject({ skipped: expect.stringContaining("paused (ceiling)") });
    expect(fetch).toHaveBeenCalledTimes(calls);
    const pauses = await db.select().from(workspaceJobPauses).where(and(eq(workspaceJobPauses.workspaceId, p.workspaceId), eq(workspaceJobPauses.job, NAME)));
    expect(pauses).toHaveLength(1);
  });
});
