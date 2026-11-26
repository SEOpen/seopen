import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Starting a run by hand, many times at once, against seopen_test. The one-run-per-project rule and
 * the plan's runs a week are both counted before the run is made, so without a lock every start at
 * once read "none yet" and each made, queued and paid for its own run.
 */

vi.mock("server-only", () => ({}));
const enqueue = vi.hoisted(() => vi.fn(async () => "job"));
vi.mock("@/lib/jobs/boss", () => ({ enqueue }));
// One run by hand a week, whatever plan rules this copy has.
vi.mock("@/plan-policy/rules", async (original) => {
  const m = await original<typeof import("@/plan-policy/rules")>();
  return {
    ...m,
    rules: {
      ...m.rules,
      limitsFor: (ws: Parameters<typeof m.rules.limitsFor>[0]) => ({ ...m.rules.limitsFor(ws), manualAiRunsPerWeek: 1 }),
      canStartManualAiRun: (_ws: unknown, used: number) => (used >= 1 ? { ok: false as const, message: "This week's run is used." } : { ok: true as const }),
    },
  };
});

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { startAiRunOp } = await import("./ops");
const { startRun } = await import("./run");

async function project() {
  const [ws] = await db.insert(s.workspaces).values({ name: `start-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 25 });
  const [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID()}.example` }).returning();
  await db.insert(s.aiPrompts).values({ workspaceId: ws.id, projectId: p.id, prompt: "best coffee", platforms: ["chatgpt"] });
  return { workspaceId: ws.id, projectId: p.id };
}

const runsOf = (projectId: number) => db.select().from(s.aiRuns).where(eq(s.aiRuns.projectId, projectId));

describe.skipIf(!ready)("starting an AI visibility run", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
  });
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => enqueue.mockClear());

  it("makes one run and one job from many starts at once", async () => {
    const scope = await project();

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => startAiRunOp(scope)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason.message)).toMatch(/already in progress|Not started/);
    expect(await runsOf(scope.projectId)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("holds the week's limit once the first run is done, however many starts follow at once", async () => {
    const scope = await project();
    await startAiRunOp(scope);
    await db.update(s.aiRuns).set({ status: "done", finishedAt: new Date() }).where(eq(s.aiRuns.projectId, scope.projectId));
    enqueue.mockClear();

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => startAiRunOp(scope)));

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await runsOf(scope.projectId)).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("gives the weekly job the run already in progress instead of a second one", async () => {
    const scope = await project();
    const [first, second] = await Promise.all([startRun(scope, "cron"), startRun(scope, "cron")]);
    expect(first).toBe(second);
    expect(await db.select().from(s.aiRuns).where(and(eq(s.aiRuns.projectId, scope.projectId), inArray(s.aiRuns.status, ["queued", "running"])))).toHaveLength(1);
  });

  it("the database refuses a second run in progress for a project", async () => {
    const scope = await project();
    await db.insert(s.aiRuns).values({ ...scope, status: "running" });
    await expect(db.insert(s.aiRuns).values({ ...scope, status: "queued" })).rejects.toThrow();
    // A finished run is no bar to the next.
    await db.update(s.aiRuns).set({ status: "done" }).where(eq(s.aiRuns.projectId, scope.projectId));
    await db.insert(s.aiRuns).values({ ...scope, status: "queued" });
  });
});
