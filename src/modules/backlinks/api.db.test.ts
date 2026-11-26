import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * When a project's backlink snapshot is filed, against seopen_test: under the day the numbers were
 * fetched, and a saved response never pretends to be a new reading. `fetch` is stubbed, so nothing
 * reaches DataForSEO.
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
const { apiCache, apiCacheAccess, apiLedger, backlinksSnapshots, projects, workspaces, workspaceSettings } = await import("@/db/schema");
const { workspaceCacheKey } = await import("@/lib/dataforseo/client");
const { getNewLost, getSummary, isPending, snapshotFailures } = await import("./api");
const { estimateCostUsd } = await import("./logic");

const PATH = "backlinks/summary/live";
const DAY = 86_400_000;
// How long ago the saved summary was fetched: inside the day a summary is kept for, so it is still read.
const EARLIER = 20 * 3_600_000;
const SUMMARY = { target: "x", rank: 10, backlinks: 50, referring_domains: 7, referring_main_domains: 6, backlinks_spam_score: 3, broken_backlinks: 0, referring_links_attributes: { nofollow: 1 } };
const answer = { status_code: 20000, status_message: "Ok.", cost: 0.02, tasks_count: 1, tasks_error: 0, tasks: [{ status_code: 20000, cost: 0.02, result: [SUMMARY] }] };
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

async function project() {
  const [ws] = await db.insert(workspaces).values({ name: `snapshot-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  const domain = `${randomUUID().slice(0, 8)}.example.com`;
  const [p] = await db.insert(projects).values({ workspaceId: ws.id, name: "site", domain }).returning();
  return { workspaceId: ws.id, projectId: p.id, domain };
}

/** The summary as the cache holds it after a fetch on `fetchedAt`. */
async function cached(workspaceId: number, target: string, fetchedAt: Date) {
  const task = { target, include_subdomains: true, backlinks_status_type: "live", internal_list_limit: 10 };
  const key = workspaceCacheKey(workspaceId, "POST", PATH, [task]);
  await db.insert(apiCache).values({ key, endpoint: PATH, response: answer, createdAt: fetchedAt, expiresAt: new Date(Date.now() + DAY) });
  await db.insert(apiCacheAccess).values({ key, workspaceId, paidAt: fetchedAt });
}

const snapshotsOf = (projectId: number) => db.select().from(backlinksSnapshots).where(eq(backlinksSnapshots.projectId, projectId));

describe.skipIf(!ready)("backlink snapshots", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
    vi.stubEnv("SEOPEN_HAS_SITE", "1"); // the hosted service's words
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  const noCalls = () => {
    const spy = vi.fn(async () => {
      throw new Error("DataForSEO must not be called");
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("doesn't re-date a snapshot when a page reads the saved response hours later", async () => {
    const p = await project();
    const fetchedAt = new Date(Date.now() - EARLIER);
    await cached(p.workspaceId, p.domain, fetchedAt);
    const filedAt = new Date(fetchedAt.getTime() + 1000);
    await db.insert(backlinksSnapshots).values({ workspaceId: p.workspaceId, projectId: p.projectId, date: utcDay(fetchedAt), target: p.domain, backlinks: 50, referringDomains: 7, createdAt: filedAt });
    const spy = noCalls();

    const res = await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, run: false });
    expect(isPending(res)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const rows = await snapshotsOf(p.projectId);
    expect(rows.map((r) => r.date)).toEqual([utcDay(fetchedAt)]);
    expect(rows[0].createdAt).toEqual(filedAt);
  });

  it("files a saved response under the day it was fetched when it has no snapshot yet", async () => {
    const p = await project();
    const fetchedAt = new Date(Date.now() - EARLIER);
    await cached(p.workspaceId, p.domain, fetchedAt);
    noCalls();
    await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, run: false });
    expect((await snapshotsOf(p.projectId)).map((r) => r.date)).toEqual([utcDay(fetchedAt)]);
  });

  it("gives a run's saved response its fetch date too, and doesn't pay for it", async () => {
    const p = await project();
    const fetchedAt = new Date(Date.now() - EARLIER);
    await cached(p.workspaceId, p.domain, fetchedAt);
    const spy = noCalls();
    const res = await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId });
    expect(spy).not.toHaveBeenCalled();
    expect(!isPending(res) && res.meta).toMatchObject({ cached: true, fetchedAt });
    expect((await snapshotsOf(p.projectId)).map((r) => r.date)).toEqual([utcDay(fetchedAt)]);
  });

  it("charges no more than the price shown when DataForSEO bills more", async () => {
    const p = await project();
    const dear = { ...answer, cost: 5, tasks: [{ ...answer.tasks[0], cost: 5 }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(dear))));
    const res = await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true });
    const [row] = await db.select().from(apiLedger).where(eq(apiLedger.workspaceId, p.workspaceId));
    expect(Number(row.costUsd)).toBe(5);
    expect(Number(row.chargedUsd)).toBeCloseTo(estimateCostUsd(1), 6);
    // The page shows what was charged, not what DataForSEO billed.
    expect(!isPending(res) && res.meta.costUsd).toBeCloseTo(estimateCostUsd(1), 6);
  });

  it("files fresh numbers under today and overwrites today's earlier reading", async () => {
    const p = await project();
    await db.insert(backlinksSnapshots).values({ workspaceId: p.workspaceId, projectId: p.projectId, date: utcDay(new Date()), target: p.domain, backlinks: 1, referringDomains: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer))));
    await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true });
    expect(await snapshotsOf(p.projectId)).toMatchObject([{ date: utcDay(new Date()), backlinks: 50, referringDomains: 7 }]);
  });

  describe("a weekly snapshot that couldn't run", () => {
    const TZ = "America/New_York";
    const earlier = async (p: Awaited<ReturnType<typeof project>>) =>
      db.insert(backlinksSnapshots).values({ workspaceId: p.workspaceId, projectId: p.projectId, date: utcDay(new Date(Date.now() - 2 * DAY)), target: p.domain, backlinks: 50, referringDomains: 7, createdAt: new Date(Date.now() - 2 * DAY) });
    const refused = () => vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 402 })));

    it("is read from the call the ledger kept, newer than the stored numbers", async () => {
      const p = await project();
      await earlier(p);
      refused();
      await expect(getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true })).rejects.toThrow();
      const failure = (await snapshotFailures(p.workspaceId, [p.projectId], TZ)).get(p.projectId);
      expect(failure).toMatchObject({
        kind: "failed",
        noun: "check",
        reason: "Backlink data isn't available right now. It's a problem on our side, and there's nothing for you to fix.",
        retry: false,
        next: { label: "View", href: "/backlinks" },
      });
    });

    it("clears once fresh numbers load", async () => {
      const p = await project();
      await earlier(p);
      refused();
      await expect(getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true })).rejects.toThrow();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer))));
      await getSummary(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true });
      expect((await snapshotFailures(p.workspaceId, [p.projectId], TZ)).size).toBe(0);
    });

    it("isn't raised by another backlinks call, or with nothing tried", async () => {
      const p = await project();
      await earlier(p);
      expect((await snapshotFailures(p.workspaceId, [p.projectId], TZ)).size).toBe(0);
      refused();
      await expect(getNewLost(p.domain, { workspaceId: p.workspaceId, projectId: p.projectId, force: true })).rejects.toThrow();
      expect((await snapshotFailures(p.workspaceId, [p.projectId], TZ)).size).toBe(0);
    });
  });
});
