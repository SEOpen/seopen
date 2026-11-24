import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendRefusedError, type Refusal } from "@/lib/billing/errors";
import { OpError } from "@/lib/ops";
import type { Project } from "@/lib/projects";
import { enqueue } from "@/lib/jobs/boss";
import { createCrawl, failUnqueuedCrawl } from "./crawl";
import { startCrawlOp } from "./ops";

vi.mock("@/db", () => ({ db: { $count: async () => 2 } }));
vi.mock("@/lib/analytics/server", () => ({ analyticsEnabled: () => false, track: vi.fn() }));
vi.mock("@/lib/billing/gates", () => ({
  auditJavascript: (_ws: unknown, requested: boolean) => requested, auditPageLimit: (_ws: unknown, n: number) => n, isInternal: () => false }));
vi.mock("@/lib/billing/workspace", () => ({
  auditRefusal: async () => null,
  loadBillingWorkspace: async () => ({ plan: "starter" }),
  projectActionRefusal: async () => null,
}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("./crawl", () => ({
  activeCrawl: async () => null,
  createCrawl: vi.fn(),
  failUnqueuedCrawl: vi.fn(),
  getSettings: async () => ({ maxPages: 100, enableJavascript: false }),
  MAX_PAGES_LIMIT: 5000,
  saveSettings: vi.fn(),
}));

const project = { id: 1, workspaceId: 7, domain: "a.com" } as Project;
const actor = { userId: "u1", source: "app" } as const;
const start = () => startCrawlOp(project, actor, {});
const failure = async () => {
  const err = await start().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OpError);
  return err as OpError;
};

describe("startCrawlOp when the crawl can't be created", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a crawl when nothing goes wrong", async () => {
    vi.mocked(createCrawl).mockResolvedValueOnce(42);
    await expect(start()).resolves.toMatchObject({ dryRun: false, crawlId: 42 });
  });

  it("hides a database error and keeps it in the logs", async () => {
    const raw = new Error('Failed query: insert into "audit_crawls"');
    vi.mocked(createCrawl).mockRejectedValueOnce(raw);
    const err = await failure();
    expect(err.message).toBe("The crawl service had a problem, so this crawl didn't finish. Start a new one in a minute.");
    expect(err.refusal).toBeUndefined();
    expect(log).toHaveBeenCalledWith("[audit] crawl not created:", raw);
  });

  it("keeps the wording when a concurrent submit won the race", async () => {
    vi.mocked(createCrawl).mockRejectedValueOnce(new Error("A crawl is already running for this project."));
    expect((await failure()).message).toBe("A crawl is already running for this project.");
    expect(log).not.toHaveBeenCalled();
  });

  it("passes a refusal through as written, with Upgrade now", async () => {
    const refusal: Refusal = { code: "ceiling", message: "Your trial's allowance is used up. Upgrade now to keep going.", upgradable: true };
    vi.mocked(createCrawl).mockRejectedValueOnce(new SpendRefusedError(7, refusal));
    const err = await failure();
    expect(err.message).toBe(refusal.message);
    expect(err.refusal).toEqual(refusal);
  });

  it("closes the crawl when its start job can't be queued, so the project isn't left looking busy", async () => {
    vi.mocked(createCrawl).mockResolvedValueOnce(42);
    const raw = new Error("pg-boss is not installed");
    vi.mocked(enqueue).mockRejectedValueOnce(raw);
    const err = await failure();
    expect(err.message).toBe("The crawl couldn't be queued, so it didn't start. Start a new one in a minute.");
    expect(failUnqueuedCrawl).toHaveBeenCalledWith({ workspaceId: 7, projectId: 1 }, 42);
    expect(log).toHaveBeenCalledWith("[audit] crawl not queued:", raw);
  });

  it("still says the same thing when the row can't be closed either", async () => {
    vi.mocked(createCrawl).mockResolvedValueOnce(42);
    vi.mocked(enqueue).mockRejectedValueOnce(new Error("down"));
    vi.mocked(failUnqueuedCrawl).mockRejectedValueOnce(new Error("also down"));
    expect((await failure()).message).toBe("The crawl couldn't be queued, so it didn't start. Start a new one in a minute.");
  });

  it("reports a started crawl when only the poll kick fails: the next tick picks it up", async () => {
    vi.mocked(createCrawl).mockResolvedValueOnce(42);
    vi.mocked(failUnqueuedCrawl).mockClear();
    vi.mocked(enqueue).mockResolvedValueOnce("job").mockRejectedValueOnce(new Error("down"));
    await expect(start()).resolves.toMatchObject({ dryRun: false, crawlId: 42 });
    expect(failUnqueuedCrawl).not.toHaveBeenCalled();
  });
});
