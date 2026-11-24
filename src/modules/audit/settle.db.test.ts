import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Every path that ends a crawl records DataForSEO's refund for the pages it didn't crawl, against
 * seopen_test with DataForSEO faked. A refund that fails to record leaves the crawl open,
 * so the next poll records it, rather than closing it with the refund lost.
 */

vi.mock("server-only", () => ({}));
const dfsGet = vi.hoisted(() => vi.fn());
const dfsPost = vi.hoisted(() => vi.fn());
const recordLedgerAdjustment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dataforseo/client", async (original) => ({
  ...(await original<typeof import("@/lib/dataforseo/client")>()),
  dfsGet,
  dfsPost,
  recordLedgerAdjustment,
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { pollCrawl } = await import("./crawl");
const { DataForSEOError } = await import("@/lib/dataforseo/client");

/** Charged $0.10 up front for 10 pages; the last poll saw 4 crawled. */
async function crawling(values: Partial<typeof s.auditCrawls.$inferInsert> = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `settle-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `settle-${ws.id}.example` }).returning();
  const [row] = await db
    .insert(s.auditCrawls)
    .values({ workspaceId: ws.id, projectId: project.id, status: "crawling", target: project.domain, maxPages: 10, taskId: `task-${randomUUID()}`, costUsd: 0.1, pagesCrawled: 4, startedAt: new Date(), ...values })
    .returning();
  return row;
}

const rowOf = async (id: number) => (await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, id)))[0];
const summary = (result: object) => ({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [result] }] });
const refunds = () => recordLedgerAdjustment.mock.calls.map(([adj]) => adj.deltaUsd as number);

beforeEach(() => {
  dfsGet.mockReset();
  dfsPost.mockReset();
  dfsPost.mockResolvedValue({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ total_items_count: 0, items: [] }] }] });
  recordLedgerAdjustment.mockReset();
  recordLedgerAdjustment.mockResolvedValue(undefined);
});

describe.skipIf(!ready)("a crawl's refund", () => {
  it("is recorded when a crawl past 12 hours is stopped, from the pages it got to", async () => {
    const row = await crawling({ startedAt: new Date(Date.now() - 13 * 3600_000) });
    dfsGet.mockResolvedValue(summary({ crawl_progress: "in_progress", crawl_status: { pages_crawled: 5, pages_in_queue: 3 } }));

    expect(await pollCrawl(row)).toBe("failed");

    expect(dfsPost.mock.calls.some(([path]) => path === "on_page/force_stop")).toBe(true);
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toBeCloseTo(-0.05, 6);
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", costUsd: expect.closeTo(0.05, 6) });
  });

  it("is recorded from the last poll's count when a stopped crawl's summary can't be read", async () => {
    const row = await crawling({ startedAt: new Date(Date.now() - 13 * 3600_000) });
    dfsGet.mockRejectedValue(new Error("socket hang up"));

    expect(await pollCrawl(row)).toBe("failed");

    expect(refunds()[0]).toBeCloseTo(-0.06, 6);
    expect((await rowOf(row.id)).status).toBe("failed");
  });

  it("is recorded from the last poll's count when DataForSEO no longer has the task", async () => {
    const row = await crawling();
    dfsGet.mockRejectedValue(new DataForSEOError("Task Not Found.", 40401, "on_page/summary"));

    expect(await pollCrawl(row)).toBe("failed");

    expect(refunds()[0]).toBeCloseTo(-0.06, 6);
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", costUsd: expect.closeTo(0.04, 6) });
  });

  it("that fails to record leaves a failed crawl open, and the next poll records it once", async () => {
    const row = await crawling();
    dfsGet.mockResolvedValue(summary({ crawl_progress: "finished", crawl_status: { pages_crawled: 0 }, domain_info: { extended_crawl_status: "site_unreachable" } }));
    recordLedgerAdjustment.mockRejectedValueOnce(new Error("connection reset"));

    await expect(pollCrawl(row)).rejects.toThrow("connection reset");
    expect((await rowOf(row.id)).status).toBe("crawling");

    expect(await pollCrawl(await rowOf(row.id))).toBe("failed");
    expect(refunds()).toEqual([expect.closeTo(-0.1, 6), expect.closeTo(-0.1, 6)]);
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", costUsd: 0 });
  });

  it("that fails to record leaves a finished crawl open instead of done", async () => {
    const row = await crawling();
    dfsGet.mockResolvedValue(summary({ crawl_progress: "finished", crawl_status: { pages_crawled: 3 }, domain_info: { extended_crawl_status: "no_errors" } }));
    recordLedgerAdjustment.mockRejectedValueOnce(new Error("connection reset"));

    await expect(pollCrawl(row)).rejects.toThrow("connection reset");
    expect((await rowOf(row.id)).status).toBe("crawling");

    expect(await pollCrawl(await rowOf(row.id))).toBe("done");
    expect(await rowOf(row.id)).toMatchObject({ status: "done", costUsd: expect.closeTo(0.03, 6) });
  });
});
