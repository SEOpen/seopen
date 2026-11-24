import { describe, expect, it, vi } from "vitest";

/** `/billing` shows these words to a customer, so no job that can pause may fall back to its raw name. */

vi.mock("server-only", () => ({}));

const allJobs = await (await import("@/lib/jobs/registry")).loadJobs();
const { RESEARCH_JOBS } = await import("./jobs-gate");
const { JOB_LABELS, jobLabel } = await import("./pauses");

describe("JOB_LABELS", () => {
  it("names every job that spends research credits", () => {
    expect([...RESEARCH_JOBS].filter((job) => !JOB_LABELS[job])).toEqual([]);
  });

  it("names every job that can pause: the ones that run the paid check", () => {
    const paid = allJobs.filter((job) => /paid:\s*true/.test(String(job.handler))).map((job) => job.name);
    expect(paid).toEqual(expect.arrayContaining(["rank.check", "local.check", "ai.run", "audit.start"]));
    expect(paid.filter((job) => !JOB_LABELS[job])).toEqual([]);
  });

  it("reads as words", () => {
    expect(jobLabel("local.schedule")).toBe("Local SEO checks");
    expect(jobLabel("local.check")).toBe("Local SEO checks");
  });
});
