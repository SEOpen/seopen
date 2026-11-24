import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { withBillingContext } from "@/lib/billing/context";
import type { AnyJobDef } from "@/lib/jobs/types";

/**
 * A run or check whose job is refused, or whose job is lost, against seopen_test with DataForSEO
 * stubbed so a call fails the test: nothing keeps reading as running, nothing blocks a delete, and a
 * job resumed after an upgrade spends nothing on a row that has closed.
 */

const client = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/dataforseo/client", async (orig) => {
  const stub = (path: string) => {
    client.calls.push(path);
    if (path.endsWith("tasks_ready")) return Promise.resolve({ tasks: [{ result: [] }] });
    return Promise.reject(new Error(`no DataForSEO in this test: ${path}`));
  };
  return { ...(await orig<typeof import("@/lib/dataforseo/client")>()), dfsGet: vi.fn(stub), dfsPost: vi.fn(stub) };
});
vi.mock("@/billing-provider", () => ({ provider: { cancelSubscriptionsForWorkspace: vi.fn(async () => undefined) } }));
vi.mock("@/modules/google/auth", async (orig) => ({ ...(await orig<typeof import("@/modules/google/auth")>()), disconnectAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/modules/posthog/account", async (orig) => ({ ...(await orig<typeof import("@/modules/posthog/account")>()), disconnectPosthogAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/admin/access", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => undefined) }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { FREE_PLAN_REFUSAL } = await import("@/lib/billing/spend");
const { POSTING_NEVER_FINISHED } = await import("@/lib/check-failure");
const { jobs: rankJobs } = await import("@/modules/rank/jobs");
const { jobs: localJobs } = await import("@/modules/local/jobs");
const { jobs: aiJobs } = await import("@/modules/ai/jobs");
const rank = await import("@/modules/rank/tracker");
const local = await import("@/modules/local/tracker");
const { deleteWorkspaceOp } = await import("./delete");
const { closeStaleQueuedRuns, pollRun } = await import("@/modules/ai/run");

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Runs a job's handler as the worker does: its name and payload are the billing context. */
function run(jobs: AnyJobDef[], name: string, payload: object) {
  const job = jobs.find((j) => j.name === name)!;
  return withBillingContext({ job: { name, data: payload } }, () => job.handler(payload, { name, data: payload } as never));
}

async function seed(plan = "free") {
  const id = randomUUID();
  const [user] = await db.insert(s.users).values({ id, email: `${id}@example.com`, name: "Owner", emailVerified: true }).returning();
  const [ws] = await db.insert(s.workspaces).values({ name: `stuck-${id}`, plan }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `stuck-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  return { ws, project, scope, actor: { userId: user.id, source: "app" as const } };
}

async function rankRun(scope: { workspaceId: number; projectId: number }, createdAt = new Date()) {
  const [row] = await db.insert(s.rankRuns).values({ ...scope, kind: "manual", date: "2026-11-01", depth: 10, aiOverview: false, createdAt }).returning();
  return row;
}

async function localCheck(scope: { workspaceId: number; projectId: number }, createdAt = new Date()) {
  const [business] = await db
    .insert(s.localBusinesses)
    .values({ ...scope, query: "Shop", city: "Salem, NH", title: "Shop", cid: randomUUID(), lat: 42.79, lng: -71.2 })
    .returning();
  const [keyword] = await db.insert(s.localKeywords).values({ ...scope, businessId: business.id, keyword: "coffee" }).returning();
  const [check] = await db
    .insert(s.localChecks)
    .values({ ...scope, businessId: business.id, kind: "manual", gridSize: 5, radiusMiles: 5, zoom: 13, lat: 42.79, lng: -71.2, createdAt })
    .returning();
  const [point] = await db
    .insert(s.localPoints)
    .values({ workspaceId: scope.workspaceId, checkId: check.id, keywordId: keyword.id, row: 0, col: 0, lat: 42.79, lng: -71.2 })
    .returning();
  return { check, point, keyword };
}

const rankRow = async (id: number) => (await db.select().from(s.rankRuns).where(eq(s.rankRuns.id, id)))[0];
const checkRow = async (id: number) => (await db.select().from(s.localChecks).where(eq(s.localChecks.id, id)))[0];
const pointRow = async (id: number) => (await db.select().from(s.localPoints).where(eq(s.localPoints.id, id)))[0];
const aiRow = async (id: number) => (await db.select().from(s.aiRuns).where(eq(s.aiRuns.id, id)))[0];

beforeEach(() => {
  client.calls.length = 0;
});

describe.skipIf(!ready)("a check whose job is refused", () => {
  it("closes a rank run, with the refusal as its reason, and spends nothing", async () => {
    const { scope } = await seed();
    const row = await rankRun(scope);
    const out = await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    expect(out).toEqual({ skipped: expect.stringContaining("paused") });
    expect(await rankRow(row.id)).toMatchObject({ status: "failed", error: FREE_PLAN_REFUSAL.message, finishedAt: expect.any(Date) });
    expect(client.calls).toEqual([]);
  });

  it("closes a Local check and its points", async () => {
    const { scope } = await seed();
    const { check, point } = await localCheck(scope);
    await run(localJobs, "local.check", { ...scope, checkId: check.id });
    expect(await checkRow(check.id)).toMatchObject({ status: "failed", error: FREE_PLAN_REFUSAL.message, finishedAt: expect.any(Date) });
    expect(await pointRow(point.id)).toMatchObject({ status: "failed", error: FREE_PLAN_REFUSAL.message });
    expect(client.calls).toEqual([]);
  });

  it("closes a queued AI run, and a scheduled ai.run with no row has nothing to close", async () => {
    const { scope } = await seed();
    const [row] = await db.insert(s.aiRuns).values(scope).returning();
    await run(aiJobs, "ai.run", { ...scope, runId: row.id });
    expect(await aiRow(row.id)).toMatchObject({ status: "failed", error: FREE_PLAN_REFUSAL.message, finishedAt: expect.any(Date) });
    await expect(run(aiJobs, "ai.run", scope)).resolves.toEqual({ skipped: expect.stringContaining("paused") });
    expect(client.calls).toEqual([]);
  });

  it("closes a run of an archived project, which has no refusal to quote", async () => {
    const { project, scope } = await seed("starter");
    const row = await rankRun(scope);
    await db.update(s.projects).set({ archived: true }).where(eq(s.projects.id, project.id));
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    expect(await rankRow(row.id)).toMatchObject({ status: "failed", error: POSTING_NEVER_FINISHED });
  });

  it("lets a rank run that posted some tasks finish them, and a Local check too", async () => {
    const { scope } = await seed();
    const row = await rankRun(scope);
    const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "posted" }).returning();
    await db.insert(s.rankTasks).values({ id: randomUUID(), workspaceId: scope.workspaceId, runId: row.id, keywordId: keyword.id });
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    expect(await rankRow(row.id)).toMatchObject({ status: "pending", tasksTotal: 1, error: null, finishedAt: null });

    const { check, point } = await localCheck(scope);
    await db.update(s.localPoints).set({ taskId: randomUUID() }).where(eq(s.localPoints.id, point.id));
    await run(localJobs, "local.check", { ...scope, checkId: check.id });
    expect(await checkRow(check.id)).toMatchObject({ status: "pending", finishedAt: null });
    expect(await pointRow(point.id)).toMatchObject({ status: "pending" });
  });

  it("closes a rank run whose posted tasks have all finished", async () => {
    const { scope } = await seed();
    const row = await rankRun(scope);
    const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "finished" }).returning();
    await db.insert(s.rankTasks).values({ id: randomUUID(), workspaceId: scope.workspaceId, runId: row.id, keywordId: keyword.id, status: "done" });
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    expect(await rankRow(row.id)).toMatchObject({ status: "done", finishedAt: expect.any(Date) });
  });

  it("doesn't let a payload naming another workspace's row close it", async () => {
    const a = await seed();
    const b = await seed("starter");
    const theirs = await rankRun(b.scope);
    const { check } = await localCheck(b.scope);
    const [ai] = await db.insert(s.aiRuns).values(b.scope).returning();
    await run(rankJobs, "rank.check", { ...a.scope, runId: theirs.id });
    await run(localJobs, "local.check", { ...a.scope, checkId: check.id });
    await run(aiJobs, "ai.run", { ...a.scope, runId: ai.id });
    expect((await rankRow(theirs.id)).status).toBe("posting");
    expect((await checkRow(check.id)).status).toBe("posting");
    expect((await aiRow(ai.id)).status).toBe("queued");
  });

  it("leaves nothing to spend when the job resumes after an upgrade", async () => {
    const { ws, scope } = await seed();
    const row = await rankRun(scope);
    const { check } = await localCheck(scope);
    const [ai] = await db.insert(s.aiRuns).values(scope).returning();
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    await run(localJobs, "local.check", { ...scope, checkId: check.id });
    await run(aiJobs, "ai.run", { ...scope, runId: ai.id });

    await db.update(s.workspaces).set({ plan: "starter" }).where(eq(s.workspaces.id, ws.id));
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    await run(localJobs, "local.check", { ...scope, checkId: check.id });
    await run(aiJobs, "ai.run", { ...scope, runId: ai.id });

    expect(client.calls).toEqual([]);
    expect((await rankRow(row.id)).status).toBe("failed");
    expect((await checkRow(check.id)).status).toBe("failed");
    expect((await aiRow(ai.id)).status).toBe("failed");
  });

  it("lets the customer delete the workspace straight after", async () => {
    const { ws, scope, actor } = await seed();
    const row = await rankRun(scope);
    const { check } = await localCheck(scope);
    const [ai] = await db.insert(s.aiRuns).values(scope).returning();
    await expect(deleteWorkspaceOp({ workspaceId: ws.id }, actor, "delete")).rejects.toThrow("A check is still running.");
    await run(rankJobs, "rank.check", { ...scope, runId: row.id });
    await run(localJobs, "local.check", { ...scope, checkId: check.id });
    await run(aiJobs, "ai.run", { ...scope, runId: ai.id });
    await deleteWorkspaceOp({ workspaceId: ws.id }, actor, "delete");
    expect(await db.$count(s.workspaces, eq(s.workspaces.id, ws.id))).toBe(0);
  });
});

describe.skipIf(!ready)("a check whose job is lost", () => {
  it("is closed by the rank poller after an hour, and not before", async () => {
    const { scope } = await seed("starter");
    const fresh = await rankRun(scope);
    await rank.pollOnce();
    expect((await rankRow(fresh.id)).status).toBe("posting");
    await db.update(s.rankRuns).set({ createdAt: ago(2 * HOUR) }).where(eq(s.rankRuns.id, fresh.id));
    await rank.pollOnce();
    expect(await rankRow(fresh.id)).toMatchObject({ status: "failed", error: POSTING_NEVER_FINISHED });
  });

  it("is closed by the Local poller after an hour, and not before", async () => {
    const { scope } = await seed("starter");
    const { check, point } = await localCheck(scope);
    await local.pollOnce();
    expect((await checkRow(check.id)).status).toBe("posting");
    await db.update(s.localChecks).set({ createdAt: ago(2 * HOUR) }).where(eq(s.localChecks.id, check.id));
    await local.pollOnce();
    expect(await checkRow(check.id)).toMatchObject({ status: "failed", error: POSTING_NEVER_FINISHED });
    expect((await pointRow(point.id)).status).toBe("failed");
  });

  it("is closed by the AI poller after a day, and not before", async () => {
    const { scope } = await seed("starter");
    const [fresh] = await db.insert(s.aiRuns).values({ ...scope, startedAt: ago(23 * HOUR) }).returning();
    const [lost] = await db.insert(s.aiRuns).values({ ...scope, startedAt: ago(25 * HOUR) }).returning();
    await closeStaleQueuedRuns();
    expect((await aiRow(fresh.id)).status).toBe("queued");
    expect(await aiRow(lost.id)).toMatchObject({ status: "failed", error: POSTING_NEVER_FINISHED });
  });

  it("waits for a crashed AI run's unposted tasks until it gives up on them", async () => {
    const { scope } = await seed("starter");
    const [prompt] = await db.insert(s.aiPrompts).values({ ...scope, prompt: "best tea", platforms: ["chatgpt"] }).returning();
    const [row] = await db.insert(s.aiRuns).values({ ...scope, status: "running", startedAt: ago(2 * HOUR) }).returning();
    await db.insert(s.aiResults).values({ ...scope, runId: row.id, promptId: prompt.id, platform: "chatgpt" });
    await pollRun(row.id);
    expect((await aiRow(row.id)).status).toBe("running");
  });

  it("gives up on a crashed AI run's unposted tasks with the rest of it", async () => {
    const { scope } = await seed("starter");
    const [prompt] = await db.insert(s.aiPrompts).values({ ...scope, prompt: "best coffee", platforms: ["chatgpt"] }).returning();
    const [row] = await db.insert(s.aiRuns).values({ ...scope, status: "running", startedAt: ago(74 * HOUR) }).returning();
    const [result] = await db.insert(s.aiResults).values({ ...scope, runId: row.id, promptId: prompt.id, platform: "chatgpt" }).returning();
    const [overview] = await db.insert(s.aiOverviews).values({ ...scope, runId: row.id, promptId: prompt.id, keyword: "coffee" }).returning();
    await pollRun(row.id);
    expect((await db.select().from(s.aiResults).where(eq(s.aiResults.id, result.id)))[0].status).toBe("failed");
    expect((await db.select().from(s.aiOverviews).where(eq(s.aiOverviews.id, overview.id)))[0].status).toBe("failed");
    expect((await aiRow(row.id)).status).not.toBe("running");
    expect(client.calls).toEqual([]);
  });
});
