import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A keyword past the top 20, from the schedule to what's read back, against seopen_test with
 * DataForSEO faked. Every SERP here is made up, on `.example` domains. It proves what SEOpen asks for
 * and what it does with an answer, not that Google or DataForSEO answer this way.
 */

vi.mock("server-only", () => ({}));

/** What each task id's task_get answers; a missing id means "not ready". */
const answers = new Map<string, { status_code: number; status_message: string; result: unknown[] | null }>();
const posts: Record<string, unknown>[][] = [];
const PREFIX = randomUUID();
let nextId = 0;

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { month: 2_592_000 },
  dfsGet: vi.fn(async (path: string) => {
    if (path.endsWith("tasks_ready")) return { tasks: [{ result: [...answers.keys()].map((id) => ({ id })) }] };
    const id = path.split("/").pop()!;
    return { tasks: [answers.get(id) ?? { status_code: 40602, status_message: "In queue", result: null }] };
  }),
  dfsPost: vi.fn(async (_path: string, tasks: { tag: string }[]) => {
    posts.push(tasks);
    return { cost: 0, tasks: tasks.map((t) => ({ id: `${PREFIX}-${++nextId}`, status_code: 20100, status_message: "Task Created", data: { tag: t.tag } })) };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { pollOnce, postRun, scheduleProject } = await import("./tracker");
const { loadResultsToCarry, loadTracker, resolveWindow } = await import("./queries");
const { buildOverview } = await import("./overview");
const { bucketOf } = await import("./metrics");
const { rankingsData } = await import("@/lib/mcp/data");

const GERMANY = 2276;
const SUNDAY = new Date("2026-11-01T06:00:00Z");
const MONDAY = new Date("2026-11-02T06:00:00Z");

/** `results` organic rows under two SERP features, so an organic position and an absolute one differ, with the project at `own`. */
function serp(domain: string, results: number, own: number | null) {
  const items: Record<string, unknown>[] = [
    { type: "ai_overview", rank_group: 1, rank_absolute: 1 },
    { type: "people_also_ask", rank_group: 1, rank_absolute: 2 },
  ];
  for (let p = 1; p <= results; p++) {
    const ours = p === own;
    items.push({ type: "organic", rank_group: p, rank_absolute: p + 2, domain: ours ? domain : `rival-${p}.example`, url: ours ? `https://${domain}/deep-page` : `https://rival-${p}.example/` });
  }
  return { status_code: 20000, status_message: "Ok.", result: [{ keyword: "made up keyword", datetime: "2026-11-01 06:00:00 +00:00", se_results_count: 1000, item_types: ["organic"], items }] };
}

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `depth-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example`, locationCode: GERMANY, languageCode: "de" }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "made up keyword" }).returning();
  await db.insert(s.rankSettings).values({ ...scope, dailyDepth: 20, sweepDepth: 100, sweepWeekday: SUNDAY.getUTCDay() });
  return { ws, project, scope, keyword };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Schedules the day's check, posts it, and answers its one task with this SERP. */
async function check(x: Seeded, now: Date, answer: ReturnType<typeof serp>) {
  const run = await scheduleProject(x.scope, now);
  await postRun(x.scope, run!.id);
  const [task] = await db.select().from(s.rankTasks).where(and(eq(s.rankTasks.runId, run!.id), eq(s.rankTasks.status, "pending")));
  answers.set(task.id, answer);
  await pollOnce();
  answers.delete(task.id);
  return run!;
}

describe.skipIf(!ready)("a keyword at #40", () => {
  beforeEach(async () => {
    posts.length = 0;
    // Rows outlive a run, and pollOnce takes 200 due tasks in no set order, so orphans can crowd out this test's. Others running now are newer than this.
    await db.update(s.rankTasks).set({ status: "done" }).where(and(eq(s.rankTasks.status, "pending"), lt(s.rankTasks.postedAt, new Date(Date.now() - 20 * 60_000))));
  });

  it("is asked for at the sweep's depth, with the project's location and language", async () => {
    const x = await seed();
    const run = await check(x, SUNDAY, serp(x.project.domain, 60, 40));
    const [saved] = await db.select().from(s.rankRuns).where(eq(s.rankRuns.id, run.id));
    expect([saved.kind, saved.depth, saved.aiOverview, saved.locationCode]).toEqual(["sweep", 100, true, GERMANY]);
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toMatchObject({ keyword: "made up keyword", location_code: GERMANY, language_code: "de", device: "desktop", depth: 100, load_async_ai_overview: true });
  });

  it("is stored as an organic #40, with the place and depth it was seen at", async () => {
    const x = await seed();
    await check(x, SUNDAY, serp(x.project.domain, 60, 40));
    const [row] = await db.select().from(s.rankResults).where(eq(s.rankResults.keywordId, x.keyword.id));
    expect([row.position, row.rankAbsolute, row.url, row.depth, row.locationCode, row.date]).toEqual([40, 42, `https://${x.project.domain}/deep-page`, 100, GERMANY, "2026-11-01"]);
    // Only the first 20 items are kept for the snapshot, so #40 isn't in it. The position doesn't come from there.
    expect(row.top).toHaveLength(20);
    expect(row.domains[x.project.domain]?.p).toBe(40);
  });

  it("takes one look on the next day's top 20 and still reads as #40, in the app and over MCP", async () => {
    const x = await seed();
    await check(x, SUNDAY, serp(x.project.domain, 60, 40));
    posts.length = 0;
    const monday = await check(x, MONDAY, serp(x.project.domain, 20, null));
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toMatchObject({ location_code: GERMANY, language_code: "de", depth: 20 });
    expect(posts[0][0]).not.toHaveProperty("load_async_ai_overview");
    expect(monday.depth).toBe(20);

    const rows = await db.select().from(s.rankResults).where(eq(s.rankResults.keywordId, x.keyword.id)).orderBy(s.rankResults.date);
    expect(rows.map((r) => [r.date, r.position, r.depth])).toEqual([
      ["2026-11-01", 40, 100],
      ["2026-11-02", null, 20],
    ]);

    const tracker = await loadTracker(x.scope);
    expect(tracker.place.code).toBe(GERMANY);
    const win = resolveWindow(tracker.dates, 7)!;
    const o = buildOverview(tracker.keywords, await loadResultsToCarry(x.scope, win.start, win.end, tracker.place), {}, undefined, win.start);
    const r = o.rows[0];
    expect([r.position, r.change, r.delta, r.deeperCheckDate, r.url]).toEqual([40, "unchanged", 0, "2026-11-01", `https://${x.project.domain}/deep-page`]);
    expect(bucketOf(r.position)).toBe("21-100");
    expect([o.end!.top20, o.end!.top100, o.end!.avgPosition]).toEqual([0, 1, 40]);

    const mcp = await rankingsData({ workspaceId: x.ws.id }, { project: x.project.id });
    expect(mcp).toMatchObject({ keywords: [{ position: 40, change: "unchanged", from_deeper_check: "2026-11-01" }] });
  });

  it("gets a recheck in the same place and language, and at the same depth, when the sweep misses it", async () => {
    const x = await seed();
    await check(x, SUNDAY, serp(x.project.domain, 60, 40));
    posts.length = 0;
    const next = new Date("2026-11-08T06:00:00Z");
    const run = await check(x, next, serp(x.project.domain, 60, null));
    expect(posts).toHaveLength(2);
    expect(posts[1][0]).toMatchObject({ location_code: GERMANY, language_code: "de", depth: 100, load_async_ai_overview: true });
    const tasks = await db.select().from(s.rankTasks).where(eq(s.rankTasks.runId, run.id)).orderBy(s.rankTasks.attempt);
    expect(tasks.map((t) => t.attempt)).toEqual([1, 2]);
  });
});
