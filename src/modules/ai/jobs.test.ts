import { describe, expect, it, vi } from "vitest";

/**
 * The ai.poll cron is what reaches a queued run on a plan that can't start another: it must close those before polling.
 * ai.run tells the run whether pg-boss will retry it, so only the last attempt closes it on a throw.
 */

const run = vi.hoisted(() => ({
  closeRefusedRun: vi.fn(),
  closeStaleQueuedRuns: vi.fn(async () => undefined),
  executeRun: vi.fn(),
  pollRun: vi.fn(async () => "done"),
  projectsWithPrompts: vi.fn(),
  runningRuns: vi.fn(async () => [7]),
  startRun: vi.fn(),
}));
vi.mock("./run", () => run);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
const scope = { workspaceId: 1, projectId: 2 };
vi.mock("@/lib/workspace", () => ({ jobScope: vi.fn(async () => ({ ok: true, scope })) }));
vi.mock("@/lib/dataforseo/client", () => ({ BudgetExceededError: class extends Error {} }));

const { jobs } = await import("./jobs");
const { billingContext } = await import("@/lib/billing/context");

describe("ai.poll", () => {
  it("closes lost queued runs on the cron pass, then polls the running ones", async () => {
    const poll = jobs.find((j) => j.name === "ai.poll")!;
    await poll.handler({}, {} as never);
    expect(run.closeStaleQueuedRuns).toHaveBeenCalledOnce();
    expect(run.pollRun).toHaveBeenCalledWith(7);
  });
});

describe("ai.run", () => {
  const job = jobs.find((j) => j.name === "ai.run")!;

  it("tells a run its first attempt will be retried, and its retry that it's the last", async () => {
    await job.handler({ ...scope, runId: 9 }, { retryCount: 0 } as never);
    expect(run.executeRun).toHaveBeenLastCalledWith(scope, 9, { final: false });
    await job.handler({ ...scope, runId: 9 }, { retryCount: 1 } as never);
    expect(run.executeRun).toHaveBeenLastCalledWith(scope, 9, { final: true });
  });

  it("charges a run started by hand to research credits, and the weekly run to the plan", async () => {
    const meters: (string | undefined)[] = [];
    run.executeRun.mockImplementation(async () => void meters.push(billingContext().meter));
    await job.handler({ ...scope, runId: 9 }, { retryCount: 1 } as never);
    run.startRun.mockResolvedValueOnce(10);
    await job.handler(scope, { retryCount: 1 } as never);
    expect(meters).toEqual(["research", undefined]);
    run.executeRun.mockReset();
  });

  it("resumes the weekly run its first attempt started", async () => {
    run.startRun.mockResolvedValueOnce(9);
    await job.handler(scope, { retryCount: 1 } as never);
    expect(run.startRun).toHaveBeenCalledWith(scope, "cron");
    expect(run.executeRun).toHaveBeenLastCalledWith(scope, 9, { final: true });
  });
});
