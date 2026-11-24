import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import type { FixResult } from "@/db/schema/fixes";

/** Plausible's visits beside a fix's Search Console clicks, against seopen_test. Every number here is made up. */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/modules/google/apis", () => ({ googleApis: vi.fn() }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { plausibleVisits } = await import("./visits");
const { fixDetail } = await import("./queries");

const SITE = "made-up.example";
const PAGE = "https://www.made-up.example/pricing/";

const metrics = { clicks: 40, impressions: 800, position: 8 };
const result: FixResult = {
  days: 7,
  before: { from: "2026-10-01", to: "2026-10-07", ...metrics },
  after: { from: "2026-10-09", to: "2026-10-15", ...metrics, clicks: 47 },
  site: { before: metrics, after: metrics },
  computedAt: "2026-10-20T00:00:00Z",
};
const results = { "7": result };
const fix = { id: 1, code: "title-too-long", url: PAGE, results };

async function seed(set: { plausibleSite?: string | null; ga4Property?: string; state?: Partial<typeof s.googleSyncState.$inferInsert> | null } = {}) {
  const { plausibleSite = SITE, ga4Property, state } = set;
  const [ws] = await db.insert(s.workspaces).values({ name: `visits-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Made up", domain: SITE, plausibleSite, ga4Property }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  if (state !== null) await db.insert(s.googleSyncState).values({ ...scope, source: "plausible", property: SITE, backfillStart: "2025-01-01", backfillDone: true, latestDate: "2026-11-01", ...state });
  return { scope, project };
}

const visit = (scope: { workspaceId: number; projectId: number }, date: string, sessions: number, landingPage = "/pricing", hostName = SITE) => db.insert(s.ga4LandingDaily).values({ ...scope, date, hostName, landingPage, sessions, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 });

describe.skipIf(!ready)("plausibleVisits", () => {
  it("sums the fixed page's visits over the same days as the clicks, however its address is spelled", async () => {
    const { scope } = await seed();
    await visit(scope, "2026-10-01", 10);
    await visit(scope, "2026-10-07", 5, "/pricing/");
    await visit(scope, "2026-10-08", 99); // The day itself counts for neither side.
    await visit(scope, "2026-10-09", 12, "/pricing", `www.${SITE}`);
    await visit(scope, "2026-10-15", 3);
    await visit(scope, "2026-10-16", 99); // After the window.
    await visit(scope, "2026-10-09", 77, "/other"); // Another page.
    expect((await plausibleVisits(scope, [fix])).get(1)).toEqual({ "7": { before: 15, after: 15, over: "page" } });
  });

  it("reads the whole site for a site-wide fix", async () => {
    const { scope } = await seed();
    await visit(scope, "2026-10-01", 10);
    await visit(scope, "2026-10-02", 1, "/other");
    await visit(scope, "2026-10-10", 4, "/third");
    const wide = { id: 2, code: "no-sitemap", url: `https://${SITE}/`, results };
    expect((await plausibleVisits(scope, [wide])).get(2)).toEqual({ "7": { before: 11, after: 4, over: "site" } });
  });

  it("reports nothing unless Plausible is the project's source", async () => {
    const { scope } = await seed({ plausibleSite: null, ga4Property: "properties/1" });
    await visit(scope, "2026-10-01", 10);
    expect((await plausibleVisits(scope, [fix])).size).toBe(0);
  });

  it("leaves a checkpoint out when the sync hasn't reached it", async () => {
    const { scope } = await seed({ state: { latestDate: "2026-10-12" } });
    await visit(scope, "2026-10-01", 10);
    expect((await plausibleVisits(scope, [fix])).size).toBe(0);
  });

  it("leaves a checkpoint out while the backfill is short of it, and shows it once passed", async () => {
    const short = await seed({ state: { backfillDone: false, backfillCursor: "2026-10-10" } });
    await visit(short.scope, "2026-10-01", 10);
    expect((await plausibleVisits(short.scope, [fix])).size).toBe(0);
    const past = await seed({ state: { backfillDone: false, backfillCursor: "2026-10-16" } });
    await visit(past.scope, "2026-10-01", 10);
    expect((await plausibleVisits(past.scope, [fix])).get(1)).toEqual({ "7": { before: 10, after: 0, over: "page" } });
  });

  it("leaves a checkpoint out when the site's history starts after its first day, since those days aren't zeros", async () => {
    const { scope } = await seed();
    await visit(scope, "2026-10-05", 10);
    expect((await plausibleVisits(scope, [fix])).size).toBe(0);
  });

  it("gives fixes with no results nothing, without a query for them", async () => {
    const { scope } = await seed();
    await visit(scope, "2026-10-01", 10);
    expect((await plausibleVisits(scope, [{ ...fix, results: null }])).size).toBe(0);
  });

  it("reads only the scope's own project", async () => {
    const A = await seed();
    const B = await seed();
    await visit(A.scope, "2026-10-01", 10);
    await visit(B.scope, "2026-10-01", 1);
    expect((await plausibleVisits(A.scope, [fix])).get(1)?.["7"].before).toBe(10);
    expect((await plausibleVisits(B.scope, [fix])).get(1)?.["7"].before).toBe(1);
    expect((await plausibleVisits({ workspaceId: B.scope.workspaceId, projectId: A.scope.projectId }, [fix])).size).toBe(0);
  });

  it("puts the visits and what they count into get_fix's results, only when reports show", async () => {
    const { scope } = await seed();
    await visit(scope, "2026-10-01", 10);
    const [row] = await db.insert(s.fixes).values({ ...scope, source: "audit", code: "title-too-long", url: PAGE, status: "live", results }).returning();
    const shown = await fixDetail(scope, row, { showResults: true });
    expect(shown.results?.[0]).toMatchObject({ days: 7, before: { clicks: 40 }, after: { clicks: 47 }, plausible_visits: { before: 10, after: 0, over: "page", counts: expect.stringMatching(/Organic Search/) } });
    expect((await fixDetail(scope, row, { showResults: false })).results).toBeUndefined();
  });
});
