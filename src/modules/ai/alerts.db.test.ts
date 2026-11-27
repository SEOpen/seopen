import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The AI owner alerts against seopen_test: the daily model check against DataForSEO's models list,
 * and the email when every answer on one platform fails in a run. The list and the send are stubbed,
 * so nothing reaches DataForSEO or Resend. Each test runs on its own made-up day far in the future,
 * so its claims are its own.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; html: string }[]);
const mail = vi.hoisted(() => ({ failing: false, configured: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  emailConfigured: () => mail.configured,
  sendEmail: async (msg: { to: string; subject: string; text: string; html: string }) => {
    if (mail.failing) throw new Error("Resend rejected the message");
    sent.push(msg);
  },
}));
vi.stubEnv("OWNER_ALERT_EMAIL", "owner@example.com");

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const { checkAiModels, offeredModels, failedPlatforms, FAILED_PLATFORM_MIN_ANSWERS } = await import("./alerts");
const { pollRun } = await import("./run");
const { PLATFORMS } = await import("./platforms");

let base = Date.UTC(2900, 0, 1) + Math.floor(Math.random() * 20_000) * 86_400_000;
const days: string[] = [];
function newDay(): Date {
  base += 86_400_000 * 3;
  const at = new Date(base + 9 * 3_600_000);
  days.push(at.toISOString().slice(0, 10));
  return at;
}

/** A models response listing these names, shaped as DataForSEO's docs show it. */
const list = (...names: string[]) => ({ status_code: 20000, tasks: [{ status_code: 20000, status_message: "Ok.", result: names.map((model_name) => ({ model_name, reasoning: false, web_search_supported: true, task_post_supported: true })) }] });
/** Every platform's list with its own model on it. */
const allOffered = (platform: string) => list(PLATFORMS.find((p) => p.key === platform)!.model, "some-other-model");

const run = (at: Date, listModels: (platform: string) => Promise<unknown>) => checkAiModels({ configured: () => true, promptsActive: async () => true, listModels: listModels as never, now: () => at });

describe("reading the models list", () => {
  it("reads the model names", () => {
    expect(offeredModels(list("a", "b"))).toEqual(["a", "b"]);
  });

  it.each([
    ["an empty list", list()],
    ["a failed task", { tasks: [{ status_code: 40000, result: null }] }],
    ["no tasks", { tasks: [] }],
    ["entries without names", { tasks: [{ status_code: 20000, result: [{ name: "a" }, { model_name: 3 }] }] }],
    ["nothing", null],
  ])("can't read %s", (_, res) => {
    expect(offeredModels(res)).toBeNull();
  });
});

describe("which platforms failed a run", () => {
  const row = (platform: string, status: string, error: string | null = null) => ({ platform, status, error });

  it("every answer on one platform failed", () => {
    expect(failedPlatforms([row("claude", "failed", "40501 Invalid Field: 'model_name'."), row("claude", "failed", "40501 Invalid Field: 'model_name'."), row("gemini", "done")])).toEqual([
      { platform: "claude", answers: 2, error: "40501 Invalid Field: 'model_name'." },
    ]);
  });

  it("refused or never sent isn't a failed platform", () => {
    expect(failedPlatforms([row("claude", "failed", "This run would cross the workspace's research budget."), row("claude", "failed", "Run stopped before this task was posted")])).toEqual([]);
    expect(failedPlatforms([row("claude", "failed", "50000 Internal Error."), row("claude", "failed", "Run stopped before this task was posted")])).toEqual([]);
  });

  it("one answer back saves the platform", () => {
    expect(failedPlatforms([row("claude", "failed", "50000 Internal Error."), row("claude", "done")])).toEqual([]);
  });

  it("needs a few answers before it alerts", () => {
    expect(FAILED_PLATFORM_MIN_ANSWERS).toBeGreaterThan(1);
    expect(failedPlatforms([row("claude", "failed", "50000 Internal Error.")])).toEqual([]);
  });
});

describe.skipIf(!ready)("the AI model check", () => {
  beforeEach(() => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
  });

  afterAll(async () => {
    for (const day of days) {
      await db.delete(s.settings).where(like(s.settings.key, `platform.ai_model_alert:${day}:%`));
      await db.delete(s.settings).where(like(s.settings.key, `platform.ai_platform_alert:${day}:%`));
    }
  });

  it("every model still offered: sends nothing", async () => {
    const out = await run(newDay(), async (p) => allOffered(p));
    expect(out).toMatchObject({ emailed: false });
    expect(sent).toEqual([]);
  });

  it("a model gone: emails once a day, naming it", async () => {
    const at = newDay();
    const claude = PLATFORMS.find((p) => p.key === "claude")!;
    const listing = async (p: string) => (p === "claude" ? list("claude-other") : allOffered(p));
    const out = await run(at, listing);
    expect(out).toMatchObject({ emailed: true });
    expect("models" in out && out.models.find((m) => m.platform === "claude")?.status).toBe("missing");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].subject).toMatch(/Claude/);
    expect(sent[0].text).toContain(claude.model);
    expect(await run(at, listing)).toMatchObject({ emailed: false });
    expect(sent).toHaveLength(1);
  });

  it("a list it can't read alerts nothing", async () => {
    const out = await run(newDay(), async (p) => {
      if (p === "gemini") throw new Error("HTTP 500");
      return p === "claude" ? list() : allOffered(p);
    });
    expect(out).toMatchObject({ emailed: false });
    expect("models" in out && out.models.filter((m) => m.status === "unreadable").map((m) => m.platform).sort()).toEqual(["claude", "gemini"]);
    expect(sent).toEqual([]);
  });

  it("a failed send gives the claim back", async () => {
    const at = newDay();
    const listing = async (p: string) => (p === "claude" ? list("claude-other") : allOffered(p));
    mail.failing = true;
    await expect(run(at, listing)).rejects.toThrow(/Resend/);
    mail.failing = false;
    expect(await run(at, listing)).toMatchObject({ emailed: true });
  });

  it("skips without credentials or active prompts, before asking anything", async () => {
    const listModels = vi.fn(async () => list("x"));
    expect(await checkAiModels({ configured: () => false, promptsActive: async () => true, listModels, now: newDay })).toEqual({ skipped: "DataForSEO credentials aren't set" });
    expect(await checkAiModels({ configured: () => true, promptsActive: async () => false, listModels, now: newDay })).toEqual({ skipped: "no active AI prompts" });
    expect(listModels).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ready)("a platform failing a whole run", () => {
  let p: typeof s.projects.$inferSelect;
  let promptIds: number[];
  let runId: number;

  beforeEach(async () => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID()}.example` }).returning();
    const prompts = await db
      .insert(s.aiPrompts)
      .values(["best coffee", "coffee near me"].map((prompt) => ({ workspaceId: ws.id, projectId: p.id, prompt, platforms: ["chat_gpt", "claude"] })))
      .returning();
    promptIds = prompts.map((x) => x.id);
    const [r] = await db.insert(s.aiRuns).values({ workspaceId: ws.id, projectId: p.id, status: "running" }).returning();
    runId = r.id;
    // Today's claim from an earlier test run would hide the email: these tests use the real clock.
    await db.delete(s.settings).where(like(s.settings.key, `platform.ai_platform_alert:${new Date().toISOString().slice(0, 10)}:%`));
  });

  /** One answer per call: each platform's next answer goes to the next prompt. */
  const used = new Map<string, number>();
  const result = (platform: string, status: "done" | "failed", error: string | null = null) => {
    const n = used.get(`${runId}:${platform}`) ?? 0;
    used.set(`${runId}:${platform}`, n + 1);
    return db.insert(s.aiResults).values({ workspaceId: p.workspaceId, projectId: p.id, runId, promptId: promptIds[n], platform, status, error, costUsd: 0.01, completedAt: new Date() });
  };

  it("every Claude answer failed: the closing call emails once, with the error", async () => {
    await result("chat_gpt", "done");
    await result("claude", "failed", "40501 Invalid Field: 'model_name'.");
    await result("claude", "failed", "40501 Invalid Field: 'model_name'.");
    expect(await pollRun(runId)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/every Claude answer failed/);
    expect(sent[0].text).toContain("40501 Invalid Field: 'model_name'.");
    expect(sent[0].text).toContain(p.domain);
    // A second close of the same run finds it closed already and sends nothing.
    await pollRun(runId);
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(s.aiRuns).where(eq(s.aiRuns.id, runId));
    expect(row.status).toBe("done");
  });

  it("answers all refused: no email", async () => {
    await result("claude", "failed", "This run would cross the workspace's research budget.");
    await result("claude", "failed", "This run would cross the workspace's research budget.");
    await pollRun(runId);
    expect(sent).toEqual([]);
  });

  it("a failed send doesn't change how the run closes", async () => {
    mail.failing = true;
    await result("claude", "failed", "50000 Internal Error.");
    await result("claude", "failed", "50000 Internal Error.");
    expect(await pollRun(runId)).toBe("done");
    const [row] = await db.select().from(s.aiRuns).where(eq(s.aiRuns.id, runId));
    expect(row.status).toBe("failed");
  });
});
