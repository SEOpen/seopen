import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * What /ai, the dashboard card and MCP count, against seopen_test. An answer that failed is unknown, not
 * a miss: its pair is left out of every number, and last week's answer to it doesn't stand in. A run that
 * got nothing back reports no change.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { getAioSummary, getOverview, getSources, getSummary, mentionsFailure } = await import("./data");

type Project = typeof s.projects.$inferSelect;

describe.runIf(ready)("counting AI answers when some failed", () => {
  let p: Project;
  let prompts: number[];

  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fernhill", domain: `${randomUUID()}.example` }).returning();
    const rows = await db
      .insert(s.aiPrompts)
      .values(["best coffee roaster near me", "where to buy fresh beans"].map((prompt) => ({ workspaceId: ws.id, projectId: p.id, prompt, platforms: ["chat_gpt", "claude"] })))
      .returning();
    prompts = rows.map((r) => r.id);
  });

  const run = async (startedAt: string, answers: [prompt: number, platform: string, named: boolean | "failed"][], status = "done") => {
    const [r] = await db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status, startedAt: new Date(startedAt), finishedAt: new Date(startedAt) }).returning();
    for (const [i, platform, named] of answers) {
      const failed = named === "failed";
      await db.insert(s.aiResults).values({
        workspaceId: p.workspaceId,
        projectId: p.id,
        runId: r.id,
        promptId: prompts[i],
        platform,
        status: failed ? "failed" : "done",
        error: failed ? "DataForSEO HTTP 402 on ai_optimization/chat_gpt/llm_responses/live" : null,
        mentioned: failed ? null : named,
        cited: failed ? null : false,
        mentions: failed ? null : [{ domain: p.domain, own: true, count: named ? 1 : 0, firstOffset: named ? 0 : null, position: named ? 1 : null, cited: false }],
        completedAt: new Date(startedAt),
      });
    }
    return r.id;
  };

  // Nov 3: three of four answers name you. Nov 9: ChatGPT's answer to the first prompt failed; one of the three that came back names you.
  const twoRuns = async () => {
    await run("2026-11-03T12:00:00Z", [
      [0, "chat_gpt", true],
      [0, "claude", true],
      [1, "chat_gpt", false],
      [1, "claude", true],
    ]);
    await run("2026-11-09T12:00:00Z", [
      [0, "chat_gpt", "failed"],
      [0, "claude", true],
      [1, "chat_gpt", false],
      [1, "claude", false],
    ]);
  };

  it("leaves the failed answer out of visibility, instead of counting last week's answer to it", async () => {
    await twoRuns();
    const o = await getOverview(p);
    expect(o.current).toMatchObject({ total: 3, mentioned: 1 });
    expect(o.current.score).toBeCloseTo(1 / 3);
    expect(o.failed).toBe(1);
    expect(o.failedByPlatform).toEqual({ chat_gpt: 1 });
    expect(o.byPlatform.find((b) => b.platform === "chat_gpt")).toMatchObject({ total: 1, mentioned: 0 });
    expect(o.sov.find((x) => x.own)?.rate).toBeCloseTo(1 / 3);
    expect(o.previous).toMatchObject({ total: 4, mentioned: 3 });
  });

  it("draws the trend from the same answers the headline counts, so the last point is the headline", async () => {
    await twoRuns();
    const o = await getOverview(p);
    expect(o.trend.map((t) => t.visibility)).toEqual([75, 33.3]);
    expect(o.trend.at(-1)?.visibility).toBe(Math.round(o.current.score! * 1000) / 10);
  });

  it("counts the card and the sources the same way", async () => {
    await twoRuns();
    const card = await getSummary(p);
    expect(card?.current).toMatchObject({ total: 3, mentioned: 1 });
    expect(card?.failed).toBe(1);
    expect(card?.previous).toMatchObject({ total: 4, mentioned: 3 });
    expect((await getSources(p)).answers).toBe(3);
  });

  it("reports no change when the newest run got nothing back, and keeps the answers from before it", async () => {
    await twoRuns();
    await run(
      "2026-11-16T12:00:00Z",
      [
        [0, "chat_gpt", "failed"],
        [0, "claude", "failed"],
        [1, "chat_gpt", "failed"],
        [1, "claude", "failed"],
      ],
      "failed",
    );
    const o = await getOverview(p);
    expect(o.current).toMatchObject({ total: 3, mentioned: 1 });
    expect(o.failed).toBe(1);
    expect(o.previous).toBeNull();
    expect(o.previousSov).toBeNull();
    expect(o.previousByPlatform).toEqual([]);
    expect(o.failedRun).toMatch(/^2026-11-16/);
    expect(o.trend).toHaveLength(2);
    const card = await getSummary(p);
    expect(card?.previous).toBeNull();
    expect(card?.failedRun).toBe(true);
  });

  it("reports no change when the newest run failed before it asked anything", async () => {
    await twoRuns();
    await db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status: "failed", error: "Posting never finished", startedAt: new Date("2026-11-16T12:00:00Z") });
    expect((await getOverview(p)).previous).toBeNull();
  });

  it("still compares when an older run got nothing back", async () => {
    await run("2026-10-27T12:00:00Z", [[0, "chat_gpt", "failed"]], "failed");
    await twoRuns();
    const o = await getOverview(p);
    expect(o.failedRun).toBeNull();
    expect(o.previous).toMatchObject({ total: 4, mentioned: 3 });
    expect(o.trend).toHaveLength(2);
  });
});

describe.runIf(ready)("AI Overviews and Mentions that couldn't be checked", () => {
  let p: Project;
  let promptId: number;
  const scope = () => ({ workspaceId: p.workspaceId, projectId: p.id });

  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fernhill", domain: `${randomUUID()}.example` }).returning();
    [{ id: promptId }] = await db.insert(s.aiPrompts).values({ workspaceId: ws.id, projectId: p.id, prompt: "best coffee roaster near me", keyword: "coffee roaster", platforms: ["chat_gpt"] }).returning();
  });

  const check = async (at: string, overview: { status: string; taskId?: string; error?: string }, run: { status?: string; error?: string } = {}) => {
    const [r] = await db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status: run.status ?? "done", error: run.error, startedAt: new Date(at) }).returning();
    await db.insert(s.aiOverviews).values({ workspaceId: p.workspaceId, projectId: p.id, runId: r.id, promptId, keyword: "coffee roaster", present: overview.status === "done" ? true : null, createdAt: new Date(at), ...overview });
  };

  it("says the newest AI Overview check failed, and keeps the numbers from before it", async () => {
    await check("2026-11-03T12:00:00Z", { status: "done" });
    await check("2026-11-09T12:00:00Z", { status: "failed", error: "40200 Payment Required." });
    const aio = await getAioSummary(scope());
    expect(aio).toMatchObject({ checked: 1, present: 1, lastAt: new Date("2026-11-03T12:00:00Z") });
    expect(aio.failed).toEqual({ at: new Date("2026-11-09T12:00:00Z"), stored: "40200 Payment Required." });
  });

  it("counts a check its closed run never posted as failed, for the run's reason", async () => {
    await check("2026-11-03T12:00:00Z", { status: "done" });
    await check("2026-11-09T12:00:00Z", { status: "pending" }, { status: "failed", error: "DataForSEO HTTP 402 on serp/google/organic/task_post" });
    expect((await getAioSummary(scope())).failed).toEqual({ at: new Date("2026-11-09T12:00:00Z"), stored: "DataForSEO HTTP 402 on serp/google/organic/task_post" });
  });

  it("says nothing while a check is in flight, or once the newest came back", async () => {
    await check("2026-11-03T12:00:00Z", { status: "done" });
    await check("2026-11-09T12:00:00Z", { status: "pending", taskId: "t-1" }, { status: "running" });
    expect((await getAioSummary(scope())).failed).toBeNull();
    await check("2026-11-16T12:00:00Z", { status: "done" });
    expect((await getAioSummary(scope())).failed).toBeNull();
  });

  const mentionsAt = (at: string) => db.insert(s.aiLlmMentions).values({ workspaceId: p.workspaceId, projectId: p.id, platform: "google", domain: p.domain, own: true, mentions: 4, fetchedAt: new Date(at) });
  const call = (at: string, endpoint: string, statusCode: number) => db.insert(s.apiLedger).values({ workspaceId: p.workspaceId, projectId: p.id, module: "ai", endpoint, statusCode, createdAt: new Date(at) });

  it("reads a Mentions refresh that failed from the call the ledger kept", async () => {
    await mentionsAt("2026-11-03T12:00:00Z");
    await call("2026-11-09T12:05:00Z", "ai_optimization/llm_mentions/target_metrics/live", 402);
    expect(await mentionsFailure(scope())).toEqual({ at: new Date("2026-11-09T12:05:00Z"), statusCode: 402, endpoint: "ai_optimization/llm_mentions/target_metrics/live" });
  });

  it("isn't raised by an answer's failed call, or once newer numbers are in", async () => {
    await mentionsAt("2026-11-03T12:00:00Z");
    await call("2026-11-09T12:05:00Z", "ai_optimization/chat_gpt/llm_responses/live", 402);
    expect(await mentionsFailure(scope())).toBeNull();
    await call("2026-11-09T12:06:00Z", "ai_optimization/llm_mentions/multi_target_metrics/live", 402);
    await mentionsAt("2026-11-10T12:00:00Z");
    expect(await mentionsFailure(scope())).toBeNull();
  });
});
