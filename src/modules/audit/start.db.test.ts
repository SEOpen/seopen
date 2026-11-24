import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * What posts a queued crawl, against seopen_test: audit.start, and the poller when that job was
 * lost. Both check the project and plan first, close a refused crawl so nothing posts it later, and
 * post at most the pages the plan allows now. dfsPost is a stub, so nothing reaches DataForSEO.
 */

vi.mock("server-only", () => ({}));
const dfsPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dataforseo/client", async (original) => ({ ...(await original<typeof import("@/lib/dataforseo/client")>()), dfsPost }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { jobs } = await import("./jobs");
const { startLostCrawl } = await import("./crawl");
const { estimateCrawlCost } = await import("./transform");
const { CRAWL_NOT_STARTED } = await import("@/lib/dataforseo/failure-copy");
const { LOCKED_REFUSAL } = await import("@/lib/billing/workspace");

const start = jobs.find((j) => j.name === "audit.start")!;

/** A workspace on `plan` with a verified owner, and a queued crawl on its newest project. */
async function seed(plan: string, opts: { projects?: number; maxPages?: number; enableJavascript?: boolean } = {}) {
  const email = `start-${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await db.insert(s.users).values({ id: randomUUID(), email, emailVerified: true }).returning();
  const [ws] = await db.insert(s.workspaces).values({ name: email, plan }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  let project!: typeof s.projects.$inferSelect;
  for (let i = 0; i < (opts.projects ?? 1); i++) {
    [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: `p${i}`, domain: `${randomUUID().slice(0, 8)}.example.com`, createdAt: new Date(Date.now() - (10 - i) * 60_000) }).returning();
  }
  const maxPages = opts.maxPages ?? 100;
  const enableJavascript = opts.enableJavascript ?? false;
  const [crawl] = await db
    .insert(s.auditCrawls)
    .values({ workspaceId: ws.id, projectId: project.id, status: "queued", target: project.domain, maxPages, enableJavascript, loadResources: true, estimatedCostUsd: estimateCrawlCost({ maxPages, enableJavascript, loadResources: true }) })
    .returning();
  return { scope: { workspaceId: ws.id, projectId: project.id }, project, crawl };
}

const crawlRow = async (id: number) => (await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, id)))[0];
const posts = () => dfsPost.mock.calls.filter(([path]) => path === "on_page/task_post");

beforeEach(() => {
  dfsPost.mockReset();
  dfsPost.mockResolvedValue({ tasks: [{ id: `task-${randomUUID()}`, status_code: 20100, cost: 0.01 }] });
});

describe.skipIf(!ready)("posting a queued crawl", () => {
  it("closes a crawl whose project was archived before audit.start ran", async () => {
    const { scope, project, crawl } = await seed("starter");
    await db.update(s.projects).set({ archived: true }).where(eq(s.projects.id, project.id));
    await start.handler({ ...scope, crawlId: crawl.id }, {} as never);
    expect(posts()).toEqual([]);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "failed", error: CRAWL_NOT_STARTED });
  });

  it.skipIf(!rules.hasPlans)("closes a crawl of a read-only project with the reason the customer can act on", async () => {
    // Free allows one project: the newer of two is read-only after a downgrade.
    const { scope, crawl } = await seed("free", { projects: 2 });
    await start.handler({ ...scope, crawlId: crawl.id }, {} as never);
    expect(posts()).toEqual([]);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "failed", error: LOCKED_REFUSAL.message });
  });

  it("closes a lost start job's crawl the same way when the poller picks it up", async () => {
    const { scope, project, crawl } = await seed("starter");
    await db.update(s.projects).set({ archived: true }).where(eq(s.projects.id, project.id));
    await startLostCrawl({ ...scope, id: crawl.id });
    expect(posts()).toEqual([]);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "failed", error: CRAWL_NOT_STARTED });
  });

  it.skipIf(!rules.hasPlans)("posts a crawl queued before a downgrade to Free at Free's 100 pages, without JavaScript", async () => {
    const { scope, crawl } = await seed("starter", { maxPages: 500, enableJavascript: true });
    await db.update(s.workspaces).set({ plan: "free" }).where(eq(s.workspaces.id, scope.workspaceId));
    await startLostCrawl({ ...scope, id: crawl.id });
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1][0]).toMatchObject({ max_crawl_pages: 100, enable_javascript: false });
    const row = await crawlRow(crawl.id);
    expect(row).toMatchObject({ status: "crawling", maxPages: 100, enableJavascript: false });
    expect(row.estimatedCostUsd).toBeCloseTo(estimateCrawlCost({ maxPages: 100, enableJavascript: false, loadResources: true }));
    expect(posts()[0][2]).toMatchObject({ estimateUsd: row.estimatedCostUsd });
  });

  it.skipIf(!rules.hasPlans)("posts a crawl the plan still allows as it was asked for", async () => {
    const { scope, crawl } = await seed("starter", { maxPages: 300 });
    await start.handler({ ...scope, crawlId: crawl.id }, {} as never);
    expect(posts()[0][1][0]).toMatchObject({ max_crawl_pages: 300 });
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", maxPages: 300 });
  });
});
