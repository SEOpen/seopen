import { describe, expect, it } from "vitest";

/**
 * The worker runs every job under plain tsx, where `import "server-only"` throws. A job that reaches
 * a server-only module crash-loops the worker at startup (ab634c8, fixed in 241bc52). No vi.mock of
 * server-only here, on purpose: this must load the job modules exactly as the worker does.
 */
describe("worker job registry", () => {
  it("loads every job without reaching a server-only module", async () => {
    const { loadJobs } = await import("./registry");
    const jobs = await loadJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.map((j) => j.name)).toContain("recap.weekly");
  });

  it("runs the heartbeat the web app's worker watch reads", async () => {
    const { loadJobs } = await import("./registry");
    expect((await loadJobs()).find((j) => j.name === "worker.heartbeat")).toMatchObject({ cron: "*/2 * * * *", retryLimit: 0 });
  });
});
