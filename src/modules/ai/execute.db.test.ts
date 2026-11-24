import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * What each paid call of an AI run reserves, against seopen_test with DataForSEO faked. The first
 * call carries the whole run's estimate, so a run that would cross the ceiling is refused before
 * anything is asked; every other call reserves its own price, so answers asked at once can't
 * overrun the ceiling by reserving nothing.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

interface Call {
  path: string;
  estimateUsd: number | undefined;
  body?: unknown;
  /** Other calls that were in flight while this one was. */
  overlapped: boolean;
}

const calls: Call[] = [];
const inFlight = new Set<Call>();

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
    dfsPost: vi.fn(async (path: string, tasks: unknown[], opts: { estimateUsd?: number }) => {
      const call: Call = { path, estimateUsd: opts.estimateUsd, overlapped: inFlight.size > 0, body: tasks[0] };
      for (const other of inFlight) other.overlapped = true;
      calls.push(call);
      inFlight.add(call);
      await new Promise((r) => setTimeout(r, 10));
      inFlight.delete(call);
      const result = path.includes("llm_mentions") ? { aggregated_metrics: {} } : { model_name: "m", items: [{ type: "message", sections: [{ text: "Try Example Coffee." }] }] };
      return { cost: 0.01, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, result: [result] }] };
    }),
  };
});

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { executeRun } = await import("./run");
const { LLM_MENTIONS_COST_USD, platformDef } = await import("./platforms");

const PLATFORMS = ["chat_gpt", "gemini", "claude", "perplexity"] as const;
const RUN_ESTIMATE = 0.5;

describe.skipIf(!ready)("an AI run's reservations", () => {
  it("each live answer reserves its own price, and the run's estimate goes on a call asked alone", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `ai-run-${randomUUID()}`, plan: "internal" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID()}.example` }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    // Three prompts on four platforms: twelve answers, more than are asked at once.
    for (const prompt of ["best coffee", "coffee near me", "coffee beans"]) {
      await db.insert(s.aiPrompts).values({ ...scope, prompt, platforms: [...PLATFORMS] });
    }
    const [run] = await db.insert(s.aiRuns).values({ ...scope, status: "queued", estimatedCostUsd: RUN_ESTIMATE }).returning();

    calls.length = 0;
    await executeRun(scope, run.id);

    const live = calls.filter((c) => c.path.endsWith("llm_responses/live"));
    expect(live).toHaveLength(12);
    const carrier = live.filter((c) => c.estimateUsd === RUN_ESTIMATE);
    expect(carrier).toHaveLength(1);
    expect(carrier[0].overlapped).toBe(false);
    for (const c of live) {
      const platform = PLATFORMS.find((p) => c.path.includes(`/${p}/`))!;
      // A workspace with no answers yet is estimated at each platform's default.
      expect(c.estimateUsd).toBeGreaterThanOrEqual(platformDef(platform)!.defaultCostUsd);
    }
    expect(live.some((c) => c.overlapped)).toBe(true);
    // Every answer asks for at most MAX_OUTPUT_TOKENS, so DataForSEO's default can't move the estimate.
    for (const c of live) expect(c.body).toMatchObject({ max_output_tokens: 2048 });

    const mentions = calls.filter((c) => c.path.includes("llm_mentions"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].estimateUsd).toBeCloseTo(LLM_MENTIONS_COST_USD, 6);
  });
});
