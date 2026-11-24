import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Refusal } from "@/lib/billing/errors";
import { OpError, refused } from "@/lib/ops";
import { enqueue } from "@/lib/jobs/boss";
import { startCrawl, startLighthouse } from "./actions";
import { failLighthouse, queueLighthouse } from "./crawl";
import { startCrawlOp } from "./ops";

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "u1" }) }));
vi.mock("@/lib/billing/workspace", () => ({ lighthouseRefusal: vi.fn(), loadBillingWorkspace: vi.fn(), projectActionRefusal: vi.fn() }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/projects", () => ({ getCurrentProject: async () => ({ id: 1, workspaceId: 7, domain: "a.com" }) }));
vi.mock("./crawl", () => ({
  activeCrawl: vi.fn(),
  failLighthouse: vi.fn(),
  LIGHTHOUSE_ALREADY_QUEUED: "A Lighthouse test is already running for this project.",
  MAX_PAGES_LIMIT: 5000,
  queueLighthouse: vi.fn(),
  saveSettings: vi.fn(),
  stopCrawl: vi.fn(),
}));
vi.mock("./ops", () => ({ startCrawlOp: vi.fn() }));

const form = () => {
  const f = new FormData();
  f.set("maxPages", "100");
  return f;
};
const failingWith = (err: unknown) => {
  vi.mocked(startCrawlOp).mockRejectedValueOnce(err);
  return startCrawl({}, form());
};

describe("startCrawl", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nothing to show when the crawl starts", async () => {
    vi.mocked(startCrawlOp).mockResolvedValueOnce({} as never);
    await expect(startCrawl({}, form())).resolves.toEqual({});
  });

  it("passes a refusal through as written, saying Upgrade now would help", async () => {
    const refusal: Refusal = { code: "trial_audit", message: "Your trial includes one site audit. Upgrade now to run another.", upgradable: true };
    await expect(failingWith(refused(refusal))).resolves.toEqual({ error: refusal.message, upgradable: true });
  });

  it("shows an operation's own message", async () => {
    await expect(failingWith(new OpError("A crawl is already running for this project."))).resolves.toEqual({ error: "A crawl is already running for this project." });
  });

  it("hides anything else and keeps it in the logs", async () => {
    const raw = new Error("DataForSEO HTTP 500 on on_page/task_post");
    await expect(failingWith(raw)).resolves.toEqual({ error: "The crawl service had a problem, so this crawl didn't finish. Start a new one in a minute." });
    expect(log).toHaveBeenCalledWith("[audit] crawl not started:", raw);
  });
});

describe("startLighthouse", () => {
  const scope = { workspaceId: 7, projectId: 1 };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(enqueue).mockReset();
  });

  it("queues the homepage test", async () => {
    vi.mocked(queueLighthouse).mockResolvedValueOnce(42);
    await expect(startLighthouse()).resolves.toBeUndefined();
    expect(queueLighthouse).toHaveBeenCalledWith(scope, "https://a.com/");
    expect(enqueue).toHaveBeenCalledWith("audit.lighthouse", { ...scope, lighthouseId: 42 });
  });

  it("queues nothing while a test is already queued for the project", async () => {
    vi.mocked(queueLighthouse).mockResolvedValueOnce(null);
    await expect(startLighthouse()).resolves.toEqual({ error: "A Lighthouse test is already running for this project." });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("frees the slot when the job can't be queued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(queueLighthouse).mockResolvedValueOnce(43);
    vi.mocked(enqueue).mockRejectedValueOnce(new Error("pg-boss down"));
    await expect(startLighthouse()).resolves.toEqual({ error: "The Lighthouse test couldn't be queued. Try again in a minute." });
    expect(failLighthouse).toHaveBeenCalledWith(scope, 43, "Not queued");
  });
});
