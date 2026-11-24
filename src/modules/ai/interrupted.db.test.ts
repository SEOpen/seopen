import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * An AI run that throws partway, against seopen_test with DataForSEO faked. Answers that
 * came back are paid for, so they stay in the run, and posted AI Overview checks are still read.
 * A throw the job will retry leaves the rest pending, and the retry asks only what's missing.
 */

const enqueued: { name: string; data: unknown }[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({
  enqueue: vi.fn(async (name: string, data: unknown) => {
    enqueued.push({ name, data });
    return "job";
  }),
}));

/** What the fake DataForSEO does on each call. */
const fake = {
  /** Live answers asked, counted as each call starts. */
  liveAsked: 0,
  /** Live answers that came back. */
  liveAnswered: 0,
  /** The live call (1-based) that the client refuses on the month's cap, or 0 for none. */
  refuseLive: 0,
  /** AI Overview posts that throw a network error before anything is posted. */
  aioPostThrows: 0,
};

vi.mock("@/lib/dataforseo/client", async () => {
  const { BudgetExceededError } = await import("@/lib/billing/errors");
  return {
    BudgetExceededError,
    TTL: { week: 604_800 },
    monthToDateSpendUsd: vi.fn(async () => 0),
    recordLedgerAdjustment: vi.fn(async () => {}),
    taskResults: (res: { tasks: { result: unknown[] | null }[] }) => res.tasks[0]?.result ?? [],
    dfsGet: vi.fn(async () => {
      throw new Error("no fetch expected");
    }),
    dfsPost: vi.fn(async (path: string, tasks: { tag?: string }[]) => {
      if (path === "serp/google/organic/task_post") {
        if (fake.aioPostThrows > 0) {
          fake.aioPostThrows--;
          throw new Error("socket hang up");
        }
        return {
          cost: 0.002 * tasks.length,
          tasks: tasks.map((t) => ({ id: randomUUID(), status_code: 20100, status_message: "Task Created.", cost: 0.002, data: { tag: t.tag }, result: null })),
        };
      }
      if (path.endsWith("llm_responses/live")) {
        const n = ++fake.liveAsked;
        if (n === fake.refuseLive) throw new BudgetExceededError(24.99, 25, 0.03);
        // Answers take a moment, so the refused call lands while others are still in flight.
        await new Promise((r) => setTimeout(r, 20));
        fake.liveAnswered++;
        return {
          cost: 0.01,
          tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, result: [{ model_name: "m", items: [{ type: "message", sections: [{ text: "Try Example Coffee." }] }] }] }],
        };
      }
      if (path.includes("llm_mentions")) return { cost: 0.01, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, result: [{ aggregated_metrics: {} }] }] };
      throw new Error(`unexpected post ${path}`);
    }),
  };
});

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { executeRun } = await import("./run");

const PLATFORMS = ["chat_gpt", "gemini", "claude", "perplexity"] as const;

/** A project with three prompts on four platforms (twelve answers) and three AI Overview checks, and a queued run. */
async function setup() {
  const [ws] = await db.insert(s.workspaces).values({ name: `ai-interrupted-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID()}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  for (const prompt of ["best coffee", "coffee near me", "coffee beans"]) {
    await db.insert(s.aiPrompts).values({ ...scope, prompt, keyword: prompt, platforms: [...PLATFORMS] });
  }
  const [run] = await db.insert(s.aiRuns).values({ ...scope, status: "queued", estimatedCostUsd: 0.5 }).returning();
  return { scope, runId: run.id };
}

const runOf = async (runId: number) => (await db.select().from(s.aiRuns).where(eq(s.aiRuns.id, runId)))[0];
const resultsOf = (runId: number) => db.select().from(s.aiResults).where(eq(s.aiResults.runId, runId));
const overviewsOf = (runId: number) => db.select().from(s.aiOverviews).where(eq(s.aiOverviews.runId, runId));

beforeEach(() => {
  Object.assign(fake, { liveAsked: 0, liveAnswered: 0, refuseLive: 0, aioPostThrows: 0 });
  enqueued.length = 0;
});

describe.skipIf(!ready)("an AI run that throws partway", () => {
  it("keeps every answer that came back and still reads the posted AI Overview checks", async () => {
    const { scope, runId } = await setup();
    // The cap is reached on the fifth answer, while others are still being asked.
    fake.refuseLive = 5;

    await executeRun(scope, runId);

    const results = await resultsOf(runId);
    expect(results).toHaveLength(12);
    // Every answer DataForSEO returned (and charged for) is stored, including ones in flight at the refusal.
    expect(results.filter((r) => r.status === "done")).toHaveLength(fake.liveAnswered);
    expect(fake.liveAnswered).toBeGreaterThan(0);
    expect(results.filter((r) => r.status === "pending")).toHaveLength(0);

    // The AI Overview checks were posted and paid for, so the run stays open for its poll to read them.
    const overviews = await overviewsOf(runId);
    expect(overviews).toHaveLength(3);
    expect(overviews.every((o) => o.status === "pending" && o.taskId)).toBe(true);
    const run = await runOf(runId);
    expect(run.status).toBe("running");
    expect(run.error).toMatch(/monthly cap/);
    expect(enqueued.some((j) => j.name === "ai.poll")).toBe(true);
  });

  it("closes as done with what came back when nothing posted is left to read", async () => {
    const { scope, runId } = await setup();
    await db.update(s.aiPrompts).set({ keyword: null }).where(eq(s.aiPrompts.projectId, scope.projectId));
    fake.refuseLive = 5;

    await executeRun(scope, runId);

    const run = await runOf(runId);
    expect(run.status).toBe("done");
    expect(run.error).toMatch(/monthly cap/);
    expect(run.finishedAt).not.toBeNull();
    expect(enqueued.some((j) => j.name === "ai.poll")).toBe(false);
  });

  it("closes on a cap refusal even when the job would be retried, since a retry can't help", async () => {
    const { scope, runId } = await setup();
    await db.update(s.aiPrompts).set({ keyword: null }).where(eq(s.aiPrompts.projectId, scope.projectId));
    fake.refuseLive = 5;

    // A weekly job's first attempt: pg-boss would retry a throw, so none comes back.
    await executeRun(scope, runId, { final: false });

    const results = await resultsOf(runId);
    expect(results.filter((r) => r.status === "done")).toHaveLength(fake.liveAnswered);
    expect(results.filter((r) => r.status === "pending")).toHaveLength(0);
    expect(await runOf(runId)).toMatchObject({ status: "done", error: expect.stringMatching(/monthly cap/) });
  });

  it("leaves the rest for a retry, which asks only what's missing", async () => {
    const { scope, runId } = await setup();
    fake.aioPostThrows = 1;

    await expect(executeRun(scope, runId, { final: false })).rejects.toThrow("socket hang up");
    const between = await runOf(runId);
    expect(between.status).toBe("running");
    expect((await resultsOf(runId)).every((r) => r.status === "pending")).toBe(true);

    // pg-boss's retry runs the same job again.
    await executeRun(scope, runId);

    const results = await resultsOf(runId);
    expect(results.filter((r) => r.status === "done")).toHaveLength(12);
    expect(fake.liveAsked).toBe(12);
    expect((await overviewsOf(runId)).every((o) => o.taskId)).toBe(true);
  });

  it("on its last attempt, fails the run with the error when nothing came back", async () => {
    const { scope, runId } = await setup();
    fake.aioPostThrows = 1;

    await expect(executeRun(scope, runId)).rejects.toThrow("socket hang up");

    const run = await runOf(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("socket hang up");
    expect(fake.liveAsked).toBe(0);
    const open = await db
      .select()
      .from(s.aiOverviews)
      .where(and(eq(s.aiOverviews.runId, runId), eq(s.aiOverviews.status, "pending")));
    expect(open).toHaveLength(0);
    expect((await resultsOf(runId)).every((r) => r.status === "failed")).toBe(true);
    expect(enqueued.some((j) => j.name === "ai.poll")).toBe(false);
  });
});
