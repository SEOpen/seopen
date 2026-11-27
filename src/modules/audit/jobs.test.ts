import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * audit.poll's cadence. Cron can't fire more often than once a minute, so a run that finds a crawl
 * still going looks once more 30 seconds later, and a minute with nothing running costs one look.
 */

const crawl = vi.hoisted(() => ({
  expireStaleLighthouse: vi.fn(async () => undefined),
  POLL_DEADLINE_MS: 20 * 60_000,
  pollActiveCrawls: vi.fn<(opts?: { deadline: number }) => Promise<number>>(async () => 0),
  projectsWithWeeklyCrawl: vi.fn(),
  runLighthouse: vi.fn(),
  startCrawl: vi.fn(),
  startScheduledCrawl: vi.fn(),
}));
vi.mock("./crawl", () => crawl);
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ jobScope: vi.fn() }));

const { jobs, SECOND_POLL_MS } = await import("./jobs");
const poll = jobs.find((j) => j.name === "audit.poll")!;

beforeEach(() => {
  vi.useFakeTimers();
  crawl.pollActiveCrawls.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("audit.poll", () => {
  it("looks again 30 seconds later while a crawl is running, so its result lands sooner", async () => {
    crawl.pollActiveCrawls.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const run = poll.handler({}, {} as never);
    await vi.advanceTimersByTimeAsync(SECOND_POLL_MS - 1);
    expect(crawl.pollActiveCrawls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(crawl.pollActiveCrawls).toHaveBeenCalledTimes(2);
    expect(SECOND_POLL_MS).toBe(30_000);
  });

  it("looks once a minute when nothing is running", async () => {
    crawl.pollActiveCrawls.mockResolvedValue(0);
    await poll.handler({}, {} as never);
    expect(crawl.pollActiveCrawls).toHaveBeenCalledTimes(1);
  });

  it("never looks more than twice in one run", async () => {
    crawl.pollActiveCrawls.mockResolvedValue(3);
    const run = poll.handler({}, {} as never);
    await vi.advanceTimersByTimeAsync(5 * SECOND_POLL_MS);
    await run;
    expect(crawl.pollActiveCrawls).toHaveBeenCalledTimes(2);
  });

  it("skips the second look when the run is near its deadline, and passes the deadline down", async () => {
    crawl.pollActiveCrawls.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(crawl.POLL_DEADLINE_MS - SECOND_POLL_MS + 1);
      return 2;
    });
    const start = Date.now();
    await poll.handler({}, {} as never);
    expect(crawl.pollActiveCrawls).toHaveBeenCalledTimes(1);
    expect(crawl.pollActiveCrawls).toHaveBeenCalledWith({ deadline: start + crawl.POLL_DEADLINE_MS });
  });
});
