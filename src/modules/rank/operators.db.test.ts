import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Search operators, against seopen_test with DataForSEO faked: DataForSEO bills a SERP task whose
 * keyword uses one (`site:`) at 5× (docs/dataforseo.md), so rank tracking refuses them when they're
 * added, and a check still prices one stored before that at 5× when it reserves.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const posts: { tasks: { keyword: string }[]; estimateUsd?: number }[] = [];

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { month: 2_592_000 },
  dfsGet: vi.fn(async () => {
    throw new Error("no fetch expected");
  }),
  dfsPost: vi.fn(async (_path: string, tasks: { keyword: string; tag: string }[], opts: { estimateUsd?: number }) => {
    posts.push({ tasks, estimateUsd: opts.estimateUsd });
    return { cost: 0, tasks: tasks.map((t, i) => ({ id: `${randomUUID()}-${i}`, status_code: 20100, status_message: "Task Created", data: { tag: t.tag } })) };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { trackKeywordsOp } = await import("./ops");
const { createRun, postRun } = await import("./tracker");
const { estimateCheckCost } = await import("./metrics");
const { OpError } = await import("@/lib/ops");

const actor = { userId: "test", source: "app" as const };

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `operators-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example` }).returning();
  return { workspaceId: ws.id, projectId: project.id };
}

const tracked = async (scope: { projectId: number }) =>
  (await db.select({ keyword: s.rankKeywords.keyword }).from(s.rankKeywords).where(eq(s.rankKeywords.projectId, scope.projectId))).map((r) => r.keyword).sort();

describe.skipIf(!ready)("search operators in rank tracking", () => {
  it("adds the plain keywords and says which were left out", async () => {
    const scope = await seed();
    const res = await trackKeywordsOp(scope, actor, { keywords: ["coffee beans", "site:rival.example coffee", "intitle:coffee"] });
    expect(res.added).toBe(1);
    expect(res.message).toMatch(/2 keywords with search operators/);
    expect(await tracked(scope)).toEqual(["coffee beans"]);
  });

  it("refuses an add that is only operator keywords, in plain words", async () => {
    const scope = await seed();
    const err = await trackKeywordsOp(scope, actor, { keywords: ["site:rival.example coffee"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpError);
    expect((err as Error).message).toMatch(/search operators/);
    expect(await tracked(scope)).toEqual([]);
  });

  it("reserves 5× for a stored operator keyword when a check posts it", async () => {
    const scope = await seed();
    await db.insert(s.rankKeywords).values([
      { ...scope, keyword: "coffee beans" },
      { ...scope, keyword: "site:rival.example coffee" },
    ]);
    const run = await createRun(scope, "manual", { depth: 200, aiOverview: true });
    posts.length = 0;
    await postRun(scope, run!.id);
    expect(posts).toHaveLength(1);
    // One plain keyword and one at 5×: six keywords' worth, each 20 pages plus the AI Overview and
    // the poisoned-results check.
    expect(posts[0].estimateUsd).toBeCloseTo(estimateCheckCost(6, 200, true), 6);
    expect(posts[0].estimateUsd).toBeCloseTo(6 * 22 * 0.0006, 6);
  });
});
