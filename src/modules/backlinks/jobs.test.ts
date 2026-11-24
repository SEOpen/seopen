import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The weekly backlinks snapshot: the cron fan-out runs once, and each project's own job is
 * sent with retries, which only failures a retry can fix use.
 */

const { enqueue, getSummary } = vi.hoisted(() => ({ enqueue: vi.fn(), getSummary: vi.fn() }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue }));
vi.mock("./api", () => ({ getSummary }));
const scope = { workspaceId: 1, projectId: 2 };
vi.mock("@/lib/workspace", () => ({
  activeProjects: vi.fn(async () => [scope, { workspaceId: 1, projectId: 3 }]),
  jobScope: vi.fn(async () => ({ ok: true, scope, project: { domain: "example.com" } })),
}));

const { DataForSEOError, LookupInFlightError, BudgetExceededError, SpendRefusedError } = await import("@/lib/dataforseo/client");
const { jobs, retryable, SNAPSHOT_RETRY } = await import("./jobs");
const job = jobs.find((j) => j.name === "backlinks.snapshot")!;
const http = (status: number) => new DataForSEOError(`DataForSEO HTTP ${status} on backlinks/summary/live`, status, "backlinks/summary/live");

beforeEach(() => {
  enqueue.mockReset();
  getSummary.mockReset();
});

describe("backlinks.snapshot", () => {
  it("runs the fan-out once, and sends each project's job with retries", async () => {
    expect(job.retryLimit).toBe(0);
    await job.handler({}, {} as never);
    expect(enqueue.mock.calls).toEqual([
      ["backlinks.snapshot", scope, { singletonKey: "backlinks.snapshot:2", ...SNAPSHOT_RETRY }],
      ["backlinks.snapshot", { workspaceId: 1, projectId: 3 }, { singletonKey: "backlinks.snapshot:3", ...SNAPSHOT_RETRY }],
    ]);
  });

  it("retries 3 times with backoff from 30 minutes, all within the 24 h the answer stays cached", () => {
    expect(SNAPSHOT_RETRY).toEqual({ retryLimit: 3, retryDelay: 1800, retryBackoff: true, retryDelayMax: 14_400 });
    // pg-boss waits at most retryDelay * 2^(n+1) before retry n+1, capped at retryDelayMax.
    const longest = [0, 1, 2].reduce((s, n) => s + Math.min(SNAPSHOT_RETRY.retryDelayMax, SNAPSHOT_RETRY.retryDelay * 2 ** (n + 1)), 0);
    expect(longest).toBeLessThan(24 * 3600);
  });

  it("throws a 402 so pg-boss retries it", async () => {
    getSummary.mockRejectedValueOnce(http(402));
    await expect(job.handler(scope, { retryCount: 0 } as never)).rejects.toThrow("HTTP 402");
  });

  it("ends a request DataForSEO refused without a retry", async () => {
    getSummary.mockRejectedValueOnce(new DataForSEOError("Invalid Field: 'target'.", 40501, "backlinks/summary/live"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await expect(job.handler(scope, { retryCount: 0 } as never)).resolves.toEqual({ failed: "Invalid Field: 'target'." });
  });

  it("leaves a billing refusal to the worker, which records the pause", async () => {
    const refusal = new SpendRefusedError(1, { code: "ceiling", message: "limit", upgradable: false });
    getSummary.mockRejectedValueOnce(refusal);
    await expect(job.handler(scope, { retryCount: 0 } as never)).rejects.toBe(refusal);
  });
});

describe("retryable", () => {
  it("retries what may work in an hour", () => {
    for (const code of [402, 429, 500, 502, 503, 40200, 40210, 50000, 50401]) expect(retryable(new DataForSEOError("x", code, "e")), String(code)).toBe(true);
    expect(retryable(new TypeError("fetch failed"))).toBe(true);
    expect(retryable(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
    expect(retryable(new LookupInFlightError("backlinks/summary/live"))).toBe(true);
  });

  it("doesn't retry what fails the same way next time", () => {
    for (const code of [0, 400, 401, 404, 40501]) expect(retryable(new DataForSEOError("x", code, "e")), String(code)).toBe(false);
    expect(retryable(new BudgetExceededError(25, 25, 0.024))).toBe(false);
  });
});
