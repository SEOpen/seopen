import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * What an audited site can do to its own crawl's import, against seopen_test with DataForSEO and the
 * site faked. A NUL byte in its robots.txt or its tags is removed, since Postgres refuses one. And an
 * import that can't be saved ends the crawl as failed instead of being tried again on every poll.
 */

vi.mock("server-only", () => ({}));
const dfsGet = vi.hoisted(() => vi.fn());
const dfsPost = vi.hoisted(() => vi.fn());
const recordLedgerAdjustment = vi.hoisted(() => vi.fn());
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dataforseo/client", async (original) => ({
  ...(await original<typeof import("@/lib/dataforseo/client")>()),
  dfsGet,
  dfsPost,
  recordLedgerAdjustment,
}));
vi.mock("@/lib/web/fetch", async (original) => ({
  ...(await original<typeof import("@/lib/web/fetch")>()),
  safeFetch,
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { pollCrawl, withoutNul } = await import("./crawl");
const { CRAWL_NOT_SAVED } = await import("@/lib/dataforseo/failure-copy");

async function crawling() {
  const [ws] = await db.insert(s.workspaces).values({ name: `import-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `import-${ws.id}.example` }).returning();
  const [row] = await db
    .insert(s.auditCrawls)
    .values({ workspaceId: ws.id, projectId: project.id, status: "crawling", target: project.domain, maxPages: 10, taskId: `task-${randomUUID()}`, costUsd: 0.1, pagesCrawled: 4, startedAt: new Date() })
    .returning();
  return row;
}

const rowOf = async (id: number) => (await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, id)))[0];
const pagesOf = async (crawlId: number) => Number((await db.execute(sql`select count(*)::int as n from audit_pages where crawl_id = ${crawlId}`))[0].n);
const items = (list: unknown[]) => ({ tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ total_items_count: list.length, items: list }] }] });
const finished = { tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ crawl_progress: "finished", crawl_status: { pages_crawled: 4, pages_in_queue: 0 }, domain_info: { extended_crawl_status: "no_errors" } }] }] };
const fetched = (url: string, status: number, body: string, type = "text/html") => ({ status, headers: { "content-type": type }, body, truncated: false, url, redirects: [], ms: 1 });
const home = (target: string, checks: Record<string, boolean> = {}) => ({ url: `https://${target}/`, status_code: 200, resource_type: "html", checks, meta: { title: "Home", htags: { h1: ["Home"] }, content: { plain_text_word_count: 500 } } });

beforeEach(() => {
  dfsGet.mockReset();
  dfsGet.mockResolvedValue(finished);
  dfsPost.mockReset();
  recordLedgerAdjustment.mockReset();
  recordLedgerAdjustment.mockResolvedValue(undefined);
  safeFetch.mockReset();
});

describe("withoutNul", () => {
  it("removes NUL from strings at any depth and leaves the rest as it was", () => {
    const at = new Date();
    expect(withoutNul({ a: "x\u0000y", b: ["\u0000", 1, null, { c: "ok\u0000" }], at, n: 3, t: true, u: undefined })).toEqual({ a: "xy", b: ["", 1, null, { c: "ok" }], at, n: 3, t: true, u: undefined });
  });
});

describe.skipIf(!ready)("a crawl's import", () => {
  it("saves a site whose robots.txt names a sitemap with a NUL byte in it", async () => {
    const row = await crawling();
    dfsPost.mockImplementation(async (path: string) => items(path === "on_page/pages" ? [home(row.target)] : []));
    safeFetch.mockImplementation(async (url: string) =>
      url.endsWith("/robots.txt") ? fetched(url, 200, `User-agent: *\nAllow: /\nSitemap: https://${row.target}/site\u0000map.xml\n`, "text/plain") : fetched(url, 404, ""),
    );

    expect(await pollCrawl(row)).toBe("done");

    const after = await rowOf(row.id);
    expect(after.status).toBe("done");
    expect(JSON.stringify(after.summary)).not.toContain("\\u0000");
    expect(await pagesOf(row.id)).toBe(1);
  });

  it("saves a page whose image address has a NUL byte in it", async () => {
    const row = await crawling();
    const page = home(row.target, { no_image_alt: true });
    dfsPost.mockImplementation(async (path: string) => items(path === "on_page/pages" ? [page] : []));
    safeFetch.mockImplementation(async (url: string) =>
      url.endsWith("/robots.txt")
        ? fetched(url, 200, "User-agent: *\nAllow: /\n", "text/plain")
        : url === page.url
          ? fetched(url, 200, '<html><head><title>Home</title></head><body><h1>Home</h1><img src="/a\u0000.png"></body></html>')
          : fetched(url, 404, ""),
    );

    expect(await pollCrawl(row)).toBe("done");
    expect((await rowOf(row.id)).status).toBe("done");
  });

  it("ends as failed at once when Postgres refuses the data, with the refund taken once", async () => {
    const row = await crawling();
    // A status code no integer column holds: the same rows would fail the same way on every poll.
    dfsPost.mockImplementation(async (path: string) => items(path === "on_page/pages" ? [{ ...home(row.target), status_code: 99_999_999_999 }] : []));
    safeFetch.mockImplementation(async (url: string) => fetched(url, 404, ""));

    expect(await pollCrawl(row)).toBe("failed");

    expect(await rowOf(row.id)).toMatchObject({ status: "failed", error: CRAWL_NOT_SAVED, importAttempts: 1, finishedAt: expect.any(Date) });
    expect(recordLedgerAdjustment).toHaveBeenCalledTimes(1);
  });

  it("gets a few tries at an import that fails for another reason, then ends as failed", async () => {
    const row = await crawling();
    dfsPost.mockRejectedValue(new Error("socket hang up"));

    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(pollCrawl(await rowOf(row.id))).rejects.toThrow("socket hang up");
      expect(await rowOf(row.id)).toMatchObject({ importAttempts: attempt, finishedAt: null });
    }
    expect(await pollCrawl(await rowOf(row.id))).toBe("failed");
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", error: CRAWL_NOT_SAVED, importAttempts: 5 });
    expect(recordLedgerAdjustment).toHaveBeenCalledTimes(1);
  });
});
