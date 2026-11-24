import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { billingContext } from "@/lib/billing/context";

/**
 * Rechecks end to end against seopen_test, with DataForSEO faked: a miss of a ranking keyword posts
 * another look instead of being stored, the best look wins, real cost lands on the run, and a
 * same-day miss can't erase a position.
 */

vi.mock("server-only", () => ({}));

/** What each task id's task_get answers; a missing id means "not ready". */
const answers = new Map<string, { status_code: number; status_message: string; result: unknown[] | null }>();
const posts: { tag: string }[][] = [];
const postSources: (string | undefined)[] = [];
const PREFIX = randomUUID();
let nextId = 0;
let refuse = false;

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { month: 2_592_000 },
  dfsGet: vi.fn(async (path: string) => {
    if (path.endsWith("tasks_ready")) return { tasks: [{ result: [...answers.keys()].map((id) => ({ id })) }] };
    const id = path.split("/").pop()!;
    return { tasks: [answers.get(id) ?? { status_code: 40602, status_message: "In queue", result: null }] };
  }),
  dfsPost: vi.fn(async (_path: string, tasks: { tag: string }[]) => {
    if (refuse) throw new Error("spending limit");
    posts.push(tasks);
    postSources.push(billingContext().source);
    return {
      cost: tasks.length * 0.001,
      tasks: tasks.map((t) => ({ id: `${PREFIX}-${++nextId}`, status_code: 20100, status_message: "Task Created", data: { tag: t.tag } })),
    };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { pollOnce, storeResult } = await import("./tracker");

const DATE = "2026-11-03";
const LOCATION = 2840;

/** A SERP with the project at `position`, or without it. */
function serp(domain: string, position: number | null) {
  const items = [{ type: "organic", rank_group: 1, rank_absolute: 1, domain: "rival.example", url: "https://rival.example/" }];
  if (position != null) items.push({ type: "organic", rank_group: position, rank_absolute: position, domain, url: `https://${domain}/page` });
  return { status_code: 20000, status_message: "Ok.", result: [{ keyword: "kw", datetime: `${DATE} 06:00:00 +00:00`, se_results_count: 100, item_types: ["organic"], items }] };
}

async function seed(history: { date: string; position: number | null; notChecked?: boolean }[]) {
  const [ws] = await db.insert(s.workspaces).values({ name: `rank-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "kw" }).returning();
  const [run] = await db.insert(s.rankRuns).values({ ...scope, kind: "daily", date: DATE, depth: 20, status: "pending", tasksTotal: 1, locationCode: LOCATION }).returning();
  for (const h of history) {
    await db.insert(s.rankResults).values({
      ...scope,
      keywordId: keyword.id,
      date: h.date,
      depth: 20,
      locationCode: LOCATION,
      position: h.position,
      url: h.position == null ? null : `https://${project.domain}/old`,
      checkedAt: new Date(`${h.date}T06:00:00Z`),
      notChecked: h.notChecked ?? false,
    });
  }
  const firstTask = `${PREFIX}-${++nextId}`;
  await db.insert(s.rankTasks).values({ id: firstTask, workspaceId: ws.id, runId: run.id, keywordId: keyword.id });
  return { scope, project, keyword, run, firstTask };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const tasksOf = (x: Seeded) => db.select().from(s.rankTasks).where(eq(s.rankTasks.runId, x.run.id)).orderBy(s.rankTasks.attempt);
const dayRow = async (x: Seeded, date = DATE) => (await db.select().from(s.rankResults).where(eq(s.rankResults.keywordId, x.keyword.id))).find((r) => r.date === date);
const runOf = async (x: Seeded) => (await db.select().from(s.rankRuns).where(eq(s.rankRuns.id, x.run.id)))[0];

/** Answers the keyword's open task with this position and polls. Other seeded tasks stay untouched: their answers are spent. */
async function answer(x: Seeded, position: number | null) {
  const open = (await tasksOf(x)).filter((t) => t.status === "pending");
  expect(open).toHaveLength(1);
  answers.set(open[0].id, serp(x.project.domain, position));
  await pollOnce();
  answers.delete(open[0].id);
}

describe.skipIf(!ready)("rechecks", () => {
  beforeEach(async () => {
    posts.length = 0;
    refuse = false;
    // Rows outlive a run, and pollOnce takes 200 due tasks in no set order, so old ones can crowd out this test's. Other files' running now are newer than this, as in depth.db.test.ts.
    await db.update(s.rankTasks).set({ status: "done" }).where(and(eq(s.rankTasks.status, "pending"), lt(s.rankTasks.postedAt, new Date(Date.now() - 20 * 60_000))));
  });

  it("posts a recheck under the source of whoever started the run", async () => {
    const agent = await seed([{ date: "2026-11-02", position: 5 }]);
    await db.update(s.rankRuns).set({ source: "mcp" }).where(eq(s.rankRuns.id, agent.run.id));
    postSources.length = 0;
    await answer(agent, null);
    expect(postSources).toEqual(["mcp"]);

    const app = await seed([{ date: "2026-11-02", position: 5 }]);
    postSources.length = 0;
    await answer(app, null);
    expect(postSources).toEqual([undefined]);
  });

  it("stores a believable first look with no recheck", async () => {
    const x = await seed([{ date: "2026-11-02", position: 5 }]);
    await answer(x, 6);
    expect((await dayRow(x))?.position).toBe(6);
    expect(await tasksOf(x)).toHaveLength(1);
    const run = await runOf(x);
    expect(run.status).toBe("done");
    expect(run.rechecks).toBe(0);
  });

  it("posts another look at a miss, holds the result back, and stores the look that finds it", async () => {
    const x = await seed([{ date: "2026-11-02", position: 5 }]);
    await answer(x, null);
    expect(await dayRow(x)).toBeUndefined();
    expect(posts).toHaveLength(1);
    let tasks = await tasksOf(x);
    expect(tasks.map((t) => [t.attempt, t.status])).toEqual([[1, "done"], [2, "pending"]]);
    expect(tasks[0].look).not.toBeNull();
    expect((await runOf(x)).status).toBe("pending");
    expect((await runOf(x)).tasksDone).toBe(1);

    await answer(x, 4);
    expect((await dayRow(x))?.position).toBe(4);
    tasks = await tasksOf(x);
    expect(tasks.every((t) => t.look === null)).toBe(true);
    const run = await runOf(x);
    expect(run.status).toBe("done");
    expect(run.tasksDone).toBe(1);
    expect(run.rechecks).toBe(1);
    expect(run.costUsd).toBeCloseTo(0.001);
  });

  it("looks again at a keyword with no history when Search Console has it in the depth", async () => {
    const x = await seed([]);
    await db.insert(s.gscQueries).values([
      { ...x.scope, date: "2026-11-01", query: "kw", clicks: 0, impressions: 3, ctr: 0, position: 2 },
      { ...x.scope, date: "2026-10-31", query: "kw", clicks: 0, impressions: 1, ctr: 0, position: 10 },
    ]);
    await answer(x, null);
    expect(posts).toHaveLength(1);
    expect(await dayRow(x)).toBeUndefined();
    await answer(x, 4);
    expect((await dayRow(x))?.position).toBe(4);
    expect((await runOf(x)).rechecks).toBe(1);
  });

  it("looks again at a new keyword with nothing to go on, then records the miss", async () => {
    const x = await seed([]);
    await answer(x, null);
    expect(posts).toHaveLength(1);
    await answer(x, null);
    await answer(x, null);
    expect((await dayRow(x))?.position).toBeNull();
    expect(await tasksOf(x)).toHaveLength(3);
  });

  it("records not ranking after three misses when only Search Console suggested it", async () => {
    const x = await seed([]);
    await db.insert(s.gscQueries).values({ ...x.scope, date: "2026-11-01", query: "kw", clicks: 0, impressions: 3, ctr: 0, position: 4 });
    await answer(x, null);
    await answer(x, null);
    await answer(x, null);
    const row = await dayRow(x);
    expect([row?.position, row?.notChecked]).toEqual([null, false]);
    expect(await tasksOf(x)).toHaveLength(3);
    expect((await runOf(x)).status).toBe("done");
  });

  it("takes no extra looks from a Search Console position beyond the depth, or another project's", async () => {
    const x = await seed([]);
    const other = await seed([]);
    await db.insert(s.gscQueries).values([
      { ...x.scope, date: "2026-11-01", query: "kw", clicks: 0, impressions: 3, ctr: 0, position: 45 },
      { ...other.scope, date: "2026-11-01", query: "kw", clicks: 0, impressions: 3, ctr: 0, position: 2 },
    ]);
    await answer(x, null);
    expect(posts).toHaveLength(0);
    expect(await tasksOf(x)).toHaveLength(1);
  });

  it("stops the extra looks once the keyword has missed for three days from this place", async () => {
    const x = await seed([
      { date: "2026-11-02", position: null },
      { date: "2026-11-01", position: null },
      { date: "2026-10-31", position: null },
    ]);
    await db.insert(s.gscQueries).values({ ...x.scope, date: "2026-11-01", query: "kw", clicks: 0, impressions: 3, ctr: 0, position: 4 });
    await answer(x, null);
    expect(posts).toHaveLength(0);
    expect(await tasksOf(x)).toHaveLength(1);
  });

  it("keeps the best of three when it stays far below its recent best", async () => {
    const x = await seed([{ date: "2026-11-02", position: 3 }]);
    await answer(x, 18);
    await answer(x, 15);
    await answer(x, 19);
    expect((await dayRow(x))?.position).toBe(15);
    expect(await tasksOf(x)).toHaveLength(3);
    const run = await runOf(x);
    expect(run.rechecks).toBe(2);
    expect(run.notChecked).toBe(0);
    expect(run.costUsd).toBeCloseTo(0.002);
  });

  it("marks a ranking keyword not checked when every look misses, and keeps its last result", async () => {
    const x = await seed([{ date: "2026-11-02", position: 5 }]);
    await answer(x, null);
    await answer(x, null);
    await answer(x, null);
    const row = await dayRow(x);
    expect(row?.position).toBe(5);
    expect(row?.notChecked).toBe(true);
    expect(row?.url).toContain("/old");
    expect(row?.checkedAt.toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(row?.runId).toBe(x.run.id);
    const run = await runOf(x);
    expect(run.status).toBe("done");
    expect(run.notChecked).toBe(1);
    expect(await tasksOf(x)).toHaveLength(3);
  });

  it("records it as not ranking after three days of not checked", async () => {
    const x = await seed([
      { date: "2026-10-31", position: 5, notChecked: true },
      { date: "2026-11-01", position: 5, notChecked: true },
      { date: "2026-11-02", position: 5, notChecked: true },
    ]);
    await answer(x, null);
    await answer(x, null);
    await answer(x, null);
    const row = await dayRow(x);
    expect(row?.position).toBeNull();
    expect(row?.notChecked).toBe(false);
  });

  it("settles on what it has when the spending limit refuses the recheck", async () => {
    const x = await seed([{ date: "2026-11-02", position: 5 }]);
    refuse = true;
    await answer(x, null);
    const row = await dayRow(x);
    expect(row?.position).toBe(5);
    expect(row?.notChecked).toBe(true);
    expect(await tasksOf(x)).toHaveLength(1);
    expect((await runOf(x)).status).toBe("done");
  });

  it("settles on the earlier looks when a recheck fails", async () => {
    const x = await seed([{ date: "2026-11-02", position: 3 }]);
    await answer(x, 18);
    const open = (await tasksOf(x)).find((t) => t.status === "pending")!;
    answers.set(open.id, { status_code: 40401, status_message: "Task Not Found.", result: null });
    await pollOnce();
    answers.delete(open.id);
    expect((await dayRow(x))?.position).toBe(18);
    expect((await runOf(x)).status).toBe("done");
  });

  it("keeps the position from a partial result (40106)", async () => {
    const x = await seed([{ date: "2026-11-02", position: 4 }]);
    answers.set(x.firstTask, { ...serp(x.project.domain, 4), status_code: 40106, status_message: "Partial results." });
    await pollOnce();
    answers.delete(x.firstTask);
    expect((await dayRow(x))?.position).toBe(4);
    expect((await runOf(x)).status).toBe("done");
  });

  it.each([
    [40101, "Task failed."],
    [40106, "Partial results."],
  ])("gives up at once on a first look with no result (%i), so the run doesn't wait 6 hours", async (code, message) => {
    const x = await seed([{ date: "2026-11-02", position: 4 }]);
    answers.set(x.firstTask, { status_code: code, status_message: message, result: null });
    await pollOnce();
    answers.delete(x.firstTask);
    const [task] = await tasksOf(x);
    expect(task.status).toBe("failed");
    expect(task.error).toBe(`${code} ${message}`);
    expect((await runOf(x)).status).not.toBe("pending");
  });

  it("settles on the earlier look when a recheck comes back with 40101", async () => {
    const x = await seed([{ date: "2026-11-02", position: 3 }]);
    await answer(x, 18);
    const open = (await tasksOf(x)).find((t) => t.status === "pending")!;
    answers.set(open.id, { status_code: 40101, status_message: "Task failed.", result: null });
    await pollOnce();
    answers.delete(open.id);
    expect((await dayRow(x))?.position).toBe(18);
    expect((await runOf(x)).status).toBe("done");
  });

  it("doesn't recheck a keyword that has missed for days with nothing to go on", async () => {
    const x = await seed([
      { date: "2026-11-02", position: null },
      { date: "2026-11-01", position: null },
      { date: "2026-10-31", position: null },
    ]);
    await answer(x, null);
    expect((await dayRow(x))?.position).toBeNull();
    expect(posts).toHaveLength(0);
  });
});

describe.skipIf(!ready)("storeResult on the same day", () => {
  const parsed = (position: number | null, depthUrl = "https://site.example/new") => ({
    position,
    rankAbsolute: position,
    url: position == null ? null : depthUrl,
    ownUrls: [],
    serpFeatures: [],
    ownedFeatures: [],
    aiOverview: false,
    aiOverviewCited: false,
    domains: {},
    top: [],
    seResultsCount: 100,
    checkedAt: new Date(),
  });
  const task = (x: Seeded, depth = 20) => ({ ...x.scope, keywordId: x.keyword.id, runId: x.run.id, date: DATE, depth, locationCode: LOCATION });

  it("keeps a found position when an equal check misses", async () => {
    const x = await seed([]);
    await storeResult(task(x), parsed(5));
    await storeResult(task(x), parsed(null));
    expect((await dayRow(x))?.position).toBe(5);
  });

  it("keeps a found position when a deeper check misses", async () => {
    const x = await seed([]);
    await storeResult(task(x), parsed(5));
    await storeResult(task(x, 100), parsed(null));
    expect((await dayRow(x))?.position).toBe(5);
  });

  it("lets an equal check replace a miss or update a position", async () => {
    const x = await seed([]);
    await storeResult(task(x), parsed(null));
    await storeResult(task(x), parsed(7));
    expect((await dayRow(x))?.position).toBe(7);
    await storeResult(task(x), parsed(9));
    expect((await dayRow(x))?.position).toBe(9);
  });

  it("lets a deeper check win, and a shallower one lose", async () => {
    const x = await seed([]);
    await storeResult(task(x, 100), parsed(40));
    await storeResult(task(x), parsed(3));
    expect((await dayRow(x))?.position).toBe(40);
    await storeResult(task(x, 100), parsed(30));
    expect((await dayRow(x))?.position).toBe(30);
  });

  it("replaces a not-checked row with any real result", async () => {
    const x = await seed([{ date: DATE, position: 5, notChecked: true }]);
    await storeResult(task(x), parsed(null));
    const row = await dayRow(x);
    expect(row?.position).toBeNull();
    expect(row?.notChecked).toBe(false);
  });
});
