import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Closing a run against seopen_test: every result here is already final, so `pollRun` has nothing to ask
 * anyone and only does the closing. A run with no answer is a failed run, as a rank or Local check is.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const { pollRun } = await import("./run");
const { aiFailure } = await import("./failure");
const { latestAnswerAt } = await import("./data");
const { projectScope } = await import("@/lib/workspace");

type Status = "done" | "failed";

describe.runIf(ready)("closing an AI run", () => {
  let p: typeof s.projects.$inferSelect;
  let promptId: number;
  let runId: number;

  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID()}.example` }).returning();
    const [prompt] = await db.insert(s.aiPrompts).values({ workspaceId: ws.id, projectId: p.id, prompt: "best coffee", platforms: ["chatgpt", "claude"] }).returning();
    promptId = prompt.id;
    const [run] = await db.insert(s.aiRuns).values({ workspaceId: ws.id, projectId: p.id, status: "running" }).returning();
    runId = run.id;
  });

  const result = (platform: string, status: Status, error: string | null = null, costUsd = 0.01) =>
    db.insert(s.aiResults).values({ workspaceId: p.workspaceId, projectId: p.id, runId, promptId, platform, status, error, costUsd, completedAt: new Date() });

  const close = async () => {
    expect(await pollRun(runId)).toBe("done");
    const [run] = await db.select().from(s.aiRuns).where(eq(s.aiRuns.id, runId));
    return run;
  };

  it("every answer failed: the run failed, in safe words, and stops being polled", async () => {
    await result("chatgpt", "failed", "50000 Internal Error.");
    await result("claude", "failed", "40501 Invalid Field");
    const run = await close();
    expect(run.status).toBe("failed");
    expect(run.finishedAt).toBeTruthy();
    expect(run.error).not.toMatch(/\d{5}|DataForSEO|Invalid|Internal/);
    expect(aiFailure({ status: run.status, error: run.error, createdAt: run.startedAt }, "UTC")).toMatchObject({ kind: "failed", noun: "run", retry: true });
  });

  it("keeps what the run cost", async () => {
    await result("chatgpt", "failed", "50000 Internal Error.", 0.02);
    await result("claude", "failed", "50000 Internal Error.", 0.03);
    const run = await close();
    expect(run.costUsd).toBeCloseTo(0.05);
    expect(run.tasksDone).toBe(2);
  });

  it("answers rejected every time: says running it again won't help", async () => {
    await result("chatgpt", "failed", "40501 Invalid Field");
    await result("claude", "failed", "40501 Invalid Field");
    expect(aiFailure(await close().then((r) => ({ status: r.status, error: r.error, createdAt: r.startedAt })), "UTC")).toMatchObject({ retry: false });
  });

  it("the 72 hour timeout reads as a timeout", async () => {
    await result("chatgpt", "failed", "0 Timed out after 72 h");
    await result("claude", "failed", "0 Timed out after 72 h");
    const run = await close();
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Timed out: no answer came back in time");
  });

  it("one answer back: the run is done, and its answers still count", async () => {
    await result("chatgpt", "done");
    await result("claude", "failed", "50000 Internal Error.");
    const run = await close();
    expect(run.status).toBe("done");
    expect(await latestAnswerAt(projectScope(p))).toEqual(run.startedAt);
  });

  it("an answer that failed doesn't lose the answers an earlier run gave", async () => {
    await result("chatgpt", "done");
    const earlier = await close();
    const [next] = await db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status: "running" }).returning();
    runId = next.id;
    await result("claude", "failed", "50000 Internal Error.");
    expect((await close()).status).toBe("failed");
    expect(await latestAnswerAt(projectScope(p))).toEqual(earlier.startedAt);
  });

  it("a run the budget already closed stays as it was", async () => {
    await db.update(s.aiRuns).set({ status: "failed", error: "Budget" }).where(eq(s.aiRuns.id, runId));
    await result("chatgpt", "failed", "50000 Internal Error.");
    expect(await close()).toMatchObject({ status: "failed", error: "Budget" });
  });
});
