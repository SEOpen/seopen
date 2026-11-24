import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A crawl whose post never got its answer back, against seopen_test: DataForSEO charged for the
 * task, so adopting it charges the workspace once, and the lookup finds it among a Monday's worth
 * of other crawls instead of paying for a second one. `fetch` is stubbed, so nothing reaches DataForSEO.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { crawlTag, postCrawl, recoverPosting } = await import("./crawl");
const { estimateCrawlCost } = await import("./transform");
const { monthUsage } = await import("@/lib/billing/usage");

type Route = (endpoint: string, body: unknown) => Response | Promise<Response>;
const ok = (tasks: object[]) => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0, tasks_count: tasks.length, tasks_error: 0, tasks }));

/** DataForSEO as `route` answers it. Returns the endpoints called, in order. */
function dataforseo(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      const endpoint = url.replace("https://api.dataforseo.com/v3/", "");
      calls.push(endpoint);
      return route(endpoint, init.body ? JSON.parse(init.body) : undefined);
    }),
  );
  return calls;
}

// The seopen_test database outlives a run, and a task id another crawl has stored is skipped, so each test's ids are new.
const [taskA, taskB, taskC, taskD, taskE, taskF, taskG] = Array.from({ length: 7 }, () => `task-${randomUUID()}`);
const ESTIMATE = estimateCrawlCost({ maxPages: 500, enableJavascript: false, loadResources: true });

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `posting-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `posting-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [crawl] = await db
    .insert(s.auditCrawls)
    .values({ ...scope, status: "queued", target: project.domain, maxPages: 500, loadResources: true, estimatedCostUsd: ESTIMATE })
    .returning();
  return { scope, crawl };
}

const crawlRow = async (id: number) => (await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, id)))[0];
const ledgerOf = (workspaceId: number) => db.select().from(s.apiLedger).where(and(eq(s.apiLedger.workspaceId, workspaceId), eq(s.apiLedger.endpoint, "on_page/task_post")));
const spent = async (workspaceId: number) => (await ledgerOf(workspaceId)).reduce((n, r) => n + r.chargedUsd, 0);

/** Puts a stuck post past the timeout, so recoverPosting picks it up. */
const backdate = (id: number) => db.update(s.auditCrawls).set({ startedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(s.auditCrawls.id, id));

const posted = (id: string, minutesAgo: number) => ({ id, url: "https://api.dataforseo.com/v3/on_page/task_post", datetime_posted: new Date(Date.now() - minutesAgo * 60_000).toISOString() });

/** id_list with these tasks, and each task's summary carrying the tag in `tags`. */
function lookup(list: ReturnType<typeof posted>[], tags: Record<string, string>): Route {
  return (endpoint) => {
    if (endpoint === "on_page/id_list") return ok([{ status_code: 20000, result: list }]);
    const summary = endpoint.match(/^on_page\/summary\/(.+)$/);
    if (summary) return ok([{ status_code: 20000, data: { tag: tags[summary[1]] ?? "someone-else" }, result: [] }]);
    throw new Error(`unexpected call to ${endpoint}`);
  };
}

describe.skipIf(!ready)("a crawl post whose answer was lost", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  it("charges the adopted task once after a network error", async () => {
    const { scope, crawl } = await seed();
    dataforseo(() => {
      throw new TypeError("fetch failed");
    });
    await expect(postCrawl(scope, crawl.id)).rejects.toThrow("fetch failed");
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "posting", taskId: null });
    expect(await spent(scope.workspaceId)).toBe(0);

    await backdate(crawl.id);
    dataforseo(lookup([posted(taskA, 12)], { [taskA]: crawlTag(crawl.id) }));
    await recoverPosting(crawl.id);

    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskA });
    expect((await crawlRow(crawl.id)).costUsd).toBeCloseTo(ESTIMATE);
    expect(await spent(scope.workspaceId)).toBeCloseTo(ESTIMATE);
    expect((await monthUsage(scope.workspaceId)).spentUsd).toBeCloseTo(ESTIMATE);
  });

  it("keeps a 5xx crawl for the lookup instead of failing it, and charges it once", async () => {
    const { scope, crawl } = await seed();
    dataforseo(() => new Response("Bad gateway", { status: 502 }));
    await expect(postCrawl(scope, crawl.id)).rejects.toThrow("HTTP 502");
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "posting", taskId: null, error: null });

    await backdate(crawl.id);
    dataforseo(lookup([posted(taskB, 12)], { [taskB]: crawlTag(crawl.id) }));
    await recoverPosting(crawl.id);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskB });
    expect(await spent(scope.workspaceId)).toBeCloseTo(ESTIMATE);
  });

  it("doesn't charge again for a post that was charged but whose row couldn't be updated", async () => {
    const { scope, crawl } = await seed();
    await db.update(s.auditCrawls).set({ status: "posting" }).where(eq(s.auditCrawls.id, crawl.id));
    // What send() wrote when the answer came back.
    await db.insert(s.apiLedger).values({ ...scope, endpoint: "on_page/task_post", module: "audit", costUsd: 0.2, chargedUsd: 0.2, tasks: 1, statusCode: 20000 });
    await backdate(crawl.id);
    dataforseo(lookup([posted(taskC, 12)], { [taskC]: crawlTag(crawl.id) }));
    await recoverPosting(crawl.id);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskC });
    expect((await crawlRow(crawl.id)).costUsd).toBeCloseTo(0.2);
    expect(await ledgerOf(scope.workspaceId)).toHaveLength(1);
  });

  it("finds its task among the many other crawls posted after it, without posting again", async () => {
    const { scope, crawl } = await seed();
    await db.update(s.auditCrawls).set({ status: "posting" }).where(eq(s.auditCrawls.id, crawl.id));
    await backdate(crawl.id);
    // Monday's fan-out: 30 crawls of other projects posted after ours, each with its task id stored.
    const others = Array.from({ length: 30 }, (_, i) => `fanout-${randomUUID()}-${i}`);
    const other = await seed();
    await db.insert(s.auditCrawls).values(others.map((taskId) => ({ ...other.scope, status: "done", target: "other.example", maxPages: 10, taskId })));
    const calls = dataforseo(lookup([posted(taskD, 13), ...others.map((id, i) => posted(id, 12 - i * 0.1))], { [taskD]: crawlTag(crawl.id) }));
    await recoverPosting(crawl.id);

    expect(calls).not.toContain("on_page/task_post");
    expect(calls.filter((c) => c.startsWith("on_page/summary/"))).toEqual([`on_page/summary/${taskD}`]);
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskD });
    expect(await spent(scope.workspaceId)).toBeCloseTo(ESTIMATE);
  });

  it("doesn't post again when the task list is too full to be sure", async () => {
    const { crawl } = await seed();
    await db.update(s.auditCrawls).set({ status: "posting" }).where(eq(s.auditCrawls.id, crawl.id));
    await backdate(crawl.id);
    const full = Array.from({ length: 1000 }, (_, i) => posted(`full-${randomUUID()}-${i}`, 12));
    const calls = dataforseo(lookup(full, {}));
    await expect(recoverPosting(crawl.id)).rejects.toThrow();
    expect(calls).not.toContain("on_page/task_post");
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "posting", taskId: null });
  });

  it("posts again when the task isn't there", async () => {
    const { scope, crawl } = await seed();
    await db.update(s.auditCrawls).set({ status: "posting" }).where(eq(s.auditCrawls.id, crawl.id));
    await backdate(crawl.id);
    const look = lookup([], {});
    const calls = dataforseo((endpoint, body) =>
      endpoint === "on_page/task_post"
        ? new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: ESTIMATE, tasks_count: 1, tasks_error: 0, tasks: [{ id: taskE, status_code: 20100, cost: ESTIMATE }] }))
        : look(endpoint, body),
    );
    await recoverPosting(crawl.id);
    expect(calls).toContain("on_page/task_post");
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskE });
    expect(await spent(scope.workspaceId)).toBeCloseTo(ESTIMATE);
  });

  it("never adopts a task another database posted for the same crawl id", async () => {
    const { crawl } = await seed();
    await db.update(s.auditCrawls).set({ status: "posting" }).where(eq(s.auditCrawls.id, crawl.id));
    await backdate(crawl.id);
    expect(crawlTag(crawl.id)).toMatch(new RegExp(`^seopen-audit-[0-9a-f]{10}-${crawl.id}$`));
    // Production's task for its own crawl with this id, under the old tag and under another database's.
    const look = lookup([posted(taskF, 12), posted(`${taskF}-b`, 12)], { [taskF]: `seopen-audit-${crawl.id}`, [`${taskF}-b`]: `seopen-audit-0123456789-${crawl.id}` });
    const calls = dataforseo((endpoint, body) =>
      endpoint === "on_page/task_post"
        ? new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: ESTIMATE, tasks_count: 1, tasks_error: 0, tasks: [{ id: taskG, status_code: 20100, cost: ESTIMATE }] }))
        : look(endpoint, body),
    );
    await recoverPosting(crawl.id);
    expect(calls).toContain("on_page/task_post");
    expect(await crawlRow(crawl.id)).toMatchObject({ status: "crawling", taskId: taskG });
  });
});
