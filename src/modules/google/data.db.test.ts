import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Against seopen_test: counting what fell out of a period, the rows the query and page lists can't
 * see, and those lists with the compare period's numbers joined in.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { gscBreakdownRows, gscByPage, gscByQuery, gscGoneCount, gscLikelyBotTotals, gscSeries, gscStrikingPages, gscTotals } = await import("./data");
const { isLikelyBotQuery, LIKELY_BOT_PATTERN } = await import("./bot-queries");

const PREVIOUS = { start: "2026-09-01", end: "2026-09-28" };
const CURRENT = { start: "2026-09-29", end: "2026-10-26" };

async function project(name: string) {
  const [ws] = await db.insert(s.workspaces).values({ name: `${name}-${Date.now()}`, plan: "internal" }).returning();
  const [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name, domain: `${name}-${ws.id}.example` }).returning();
  return { workspaceId: ws.id, projectId: p.id };
}

const metrics = (clicks: number) => ({ clicks, impressions: 10, ctr: clicks / 10, position: 5 });

describe.skipIf(!ready)("gscGoneCount", () => {
  it("counts pages with clicks then and no row now, and only this project's", async () => {
    const scope = await project("gone-pages");
    const other = await project("gone-pages-other");
    const page = (date: string, name: string, clicks: number) => ({ ...scope, date, page: name, ...metrics(clicks) });
    await db.insert(s.gscPages).values([
      page("2026-09-10", "/gone", 4),
      page("2026-09-11", "/gone", 2),
      page("2026-09-10", "/stayed", 4),
      page("2026-10-10", "/stayed", 1),
      page("2026-09-10", "/never-clicked", 0), // no clicks to lose
      page("2026-10-10", "/new", 3), // only in this period
      page("2026-08-10", "/older", 9), // before the compare period
      { ...other, date: "2026-09-10", page: "/elsewhere", ...metrics(5) },
    ]);
    expect(await gscGoneCount(scope, "page", CURRENT, PREVIOUS)).toBe(1);
  });

  it("does the same for queries, and a page with a row but no clicks hasn't gone", async () => {
    const scope = await project("gone-queries");
    const query = (date: string, name: string, clicks: number) => ({ ...scope, date, query: name, ...metrics(clicks) });
    await db.insert(s.gscQueries).values([query("2026-09-10", "gone one", 3), query("2026-09-10", "gone two", 1), query("2026-09-10", "still shown", 3), query("2026-10-10", "still shown", 0)]);
    expect(await gscGoneCount(scope, "query", CURRENT, PREVIOUS)).toBe(2);
  });

  it("is zero with nothing stored", async () => {
    expect(await gscGoneCount(await project("gone-empty"), "page", CURRENT, PREVIOUS)).toBe(0);
  });
});

describe.skipIf(!ready)("gscByQuery and gscByPage with a compare period", () => {
  const row = (date: string, clicks: number, impressions: number, position: number) => ({ date, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

  async function seeded() {
    const scope = await project("by-dimension");
    const other = await project("by-dimension-other");
    const q = (query: string, r: ReturnType<typeof row>) => ({ ...scope, query, ...r });
    await db.insert(s.gscQueries).values([
      q("alpha", row("2026-10-01", 10, 100, 4)),
      q("alpha", row("2026-10-02", 5, 50, 7)),
      q("alpha", row("2026-09-10", 8, 80, 6)),
      q("beta", row("2026-10-03", 6, 60, 3)), // nothing in the compare period
      q("alpha shoes", row("2026-10-04", 2, 20, 8)),
      q("alpha shoes", row("2026-09-12", 4, 20, 9)),
      q("gamma", row("2026-10-05", 1, 40, 12)),
      q("gamma", row("2026-09-14", 3, 30, 10)),
      q("gamma", row("2026-08-20", 100, 100, 1)), // before the compare period
      q("gone", row("2026-09-15", 9, 90, 2)), // only in the compare period, so on no list
      { ...other, query: "alpha", ...row("2026-09-10", 50, 500, 1) }, // another project's
    ]);
    return scope;
  }

  const alpha = { key: "alpha", clicks: 15, impressions: 150, ctr: 0.1, position: 5, prevClicks: 8, prevImpressions: 80, prevPosition: 6, clicksDelta: 7, impressionsDelta: 70, positionDelta: 1 };
  const beta = { key: "beta", clicks: 6, impressions: 60, ctr: 0.1, position: 3, prevClicks: 0, prevImpressions: 0, prevPosition: null, clicksDelta: 6, impressionsDelta: 60, positionDelta: null };
  const alphaShoes = { key: "alpha shoes", clicks: 2, impressions: 20, ctr: 0.1, position: 8, prevClicks: 4, prevImpressions: 20, prevPosition: 9, clicksDelta: -2, impressionsDelta: 0, positionDelta: 1 };
  const gamma = { key: "gamma", clicks: 1, impressions: 40, ctr: 0.025, position: 12, prevClicks: 3, prevImpressions: 30, prevPosition: 10, clicksDelta: -2, impressionsDelta: 10, positionDelta: -2 };

  it("joins each row's compare-period numbers, from this project's rows in that period only", async () => {
    const scope = await seeded();
    expect(await gscByQuery(scope, CURRENT, PREVIOUS)).toEqual([alpha, beta, alphaShoes, gamma]);
  });

  it("keeps the same numbers under a limit and a filter", async () => {
    const scope = await seeded();
    expect(await gscByQuery(scope, CURRENT, PREVIOUS, { limit: 2 })).toEqual([alpha, beta]);
    expect(await gscByQuery(scope, CURRENT, PREVIOUS, { contains: "alpha" })).toEqual([alpha, alphaShoes]);
    expect(await gscByQuery(scope, CURRENT, PREVIOUS, { contains: "gone" })).toEqual([]);
  });

  it("leaves the compare fields empty with no compare period", async () => {
    const scope = await seeded();
    const none = { prevClicks: null, prevImpressions: null, prevPosition: null, clicksDelta: null, impressionsDelta: null, positionDelta: null };
    expect(await gscByQuery(scope, CURRENT, null, { limit: 1 })).toEqual([{ ...alpha, ...none }]);
  });

  it("does the same for pages", async () => {
    const scope = await project("by-dimension-pages");
    const p = (page: string, r: ReturnType<typeof row>) => ({ ...scope, page, ...r });
    await db.insert(s.gscPages).values([p("/a", row("2026-10-01", 4, 40, 2)), p("/a", row("2026-09-01", 6, 40, 4)), p("/a", row("2026-09-28", 2, 10, 4)), p("/b", row("2026-10-26", 1, 10, 5)), p("/c", row("2026-09-20", 5, 10, 1))]);
    expect(await gscByPage(scope, CURRENT, PREVIOUS)).toEqual([
      { key: "/a", clicks: 4, impressions: 40, ctr: 0.1, position: 2, prevClicks: 8, prevImpressions: 50, prevPosition: 4, clicksDelta: -4, impressionsDelta: -10, positionDelta: 2 },
      { key: "/b", clicks: 1, impressions: 10, ctr: 0.1, position: 5, prevClicks: 0, prevImpressions: 0, prevPosition: null, clicksDelta: 1, impressionsDelta: 10, positionDelta: null },
    ]);
  });
});

describe.skipIf(!ready)("gscStrikingPages", () => {
  it("averages each search over the period, keeps the range and groups by page, for this project only", async () => {
    const scope = await project("striking");
    const other = await project("striking-other");
    const pair = (date: string, query: string, page: string, impressions: number, position: number, where = scope) => ({ ...where, date, query, page, clicks: 1, impressions, ctr: 1 / impressions, position });
    await db.insert(s.gscQueryPages).values([
      // 100 at 2 and 300 at 8 average 6.5: in range, though one day was in the top three.
      pair("2026-10-01", "plumber", "https://x.example/a", 100, 2),
      pair("2026-10-02", "plumber", "https://x.example/a", 300, 8),
      pair("2026-10-01", "plumber near me", "https://x.example/a", 200, 15),
      pair("2026-10-01", "drain", "https://x.example/b", 500, 3), // top three
      pair("2026-10-01", "boiler", "https://x.example/c", 400, 25), // too far down
      pair("2026-09-01", "old", "https://x.example/d", 900, 10), // before the period
      pair("2026-10-01", "theirs", "https://x.example/e", 900, 10, other),
    ]);
    const { pages, pairsRead, truncated } = await gscStrikingPages(scope, CURRENT);
    expect({ pairsRead, truncated }).toEqual({ pairsRead: 2, truncated: false });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: "https://x.example/a", queries: 2, impressions: 600, bestPosition: 6.5, topQuery: { query: "plumber", position: 6.5, impressions: 400 } });
    // 400 × 14.5 ÷ 17 + 200 × 6 ÷ 17
    expect(pages[0].score).toBe(411.8);
    expect((await gscStrikingPages(scope, CURRENT, { positions: { min: 1, max: 5 } })).pages.map((p) => p.page)).toEqual(["https://x.example/b"]);
  });
});

describe.skipIf(!ready)("gscBreakdownRows", () => {
  it("orders countries by clicks, then impressions", async () => {
    const scope = await project("countries");
    const day = (key: string, clicks: number, impressions: number) => ({ ...scope, date: "2026-10-01", kind: "country", key, clicks, impressions, ctr: clicks / impressions, position: 8 });
    await db.insert(s.gscBreakdown).values([day("tur", 0, 3), day("usa", 0, 431), day("esp", 0, 40), day("gbr", 2, 20)]);
    const rows = await gscBreakdownRows(scope, "country", CURRENT, null);
    expect(rows.map((r) => r.key)).toEqual(["gbr", "usa", "esp", "tur"]);
  });
});

describe.skipIf(!ready)("searches that look like rank checks", () => {
  it("are taken off the daily totals at read time, flagged in the query list, and left in the stored rows", async () => {
    const scope = await project("bot-queries");
    const day = (date: string, clicks: number, impressions: number, position: number) => ({ ...scope, date, clicks, impressions, ctr: clicks / impressions, position });
    // 2 Oct: a real search (10 clicks, 900 impressions at 4) and a rank check (0 clicks, 100 at 13), so the day averages 4.9.
    await db.insert(s.gscDaily).values([day("2026-10-01", 5, 500, 6), day("2026-10-02", 10, 1000, 4.9)]);
    await db.insert(s.gscQueries).values([
      { ...scope, date: "2026-10-01", query: "garden design", ...metrics(5), impressions: 500, position: 6 },
      { ...scope, date: "2026-10-02", query: "garden design", clicks: 10, impressions: 900, ctr: 10 / 900, position: 4 },
      { ...scope, date: "2026-10-02", query: "5196: daily keyword rank tracking", clicks: 0, impressions: 100, ctr: 0, position: 13 },
    ]);
    const series = await gscSeries(scope, CURRENT);
    expect(series.map((r) => [r.date, r.clicks, r.impressions, Math.round(r.position * 10) / 10])).toEqual([
      ["2026-10-01", 5, 500, 6],
      ["2026-10-02", 10, 900, 4],
    ]);
    const totals = await gscTotals(scope, CURRENT);
    expect(totals).toMatchObject({ clicks: 15, impressions: 1400 });
    expect(totals.position).toBeCloseTo((6 * 500 + 4 * 900) / 1400);
    expect(await gscLikelyBotTotals(scope, CURRENT)).toEqual({ clicks: 0, impressions: 100 });
    const rows = await gscByQuery(scope, CURRENT, null);
    expect(rows.map((r) => [r.key, r.likelyBot ?? false])).toEqual([
      ["garden design", false],
      ["5196: daily keyword rank tracking", true],
    ]);
    // The stored day still has them.
    const [stored] = await db.select().from(s.gscDaily).where(and(eq(s.gscDaily.projectId, scope.projectId), eq(s.gscDaily.date, "2026-10-02")));
    expect(stored.impressions).toBe(1000);
  });

  it("match the same searches in Postgres as in JavaScript", async () => {
    const searches = [
      "5196: daily keyword rank tracking",
      "327: google online rank tracker",
      "404: page not found meaning",
      'vacuform,7,70,i,"images, knowledge panel, ai overview, related searches",6,0.44,0.85',
      "1,000,000",
      "genesis 1,2,3",
      "website page optimization, derry nh",
      "how much does seo cost in salem, nh",
      "web design salem nh. my location is salem, new hampshire, united states, usa.",
      "garden design",
    ];
    for (const q of searches) {
      const [row] = await db.execute<{ hit: boolean }>(sql`select ${q} ~ ${LIKELY_BOT_PATTERN} as hit`);
      expect(row.hit, q).toBe(isLikelyBotQuery(q));
    }
  });
});
