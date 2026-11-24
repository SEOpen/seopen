import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * Paused jobs starting again without an upgrade, against seopen_test: after the platform cap is
 * raised and after the month rolls over, but only where the job's own check now passes. Each sweep
 * is narrowed to the test's workspaces, so it can't touch another file's pauses. Nothing is queued:
 * enqueue is a stub.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { projects, users, workspaceJobPauses, workspaceMembers, workspaces, workspaceUsage } = await import("@/db/schema");
const { resumeLapsedPauses } = await import("./jobs-gate");
const { monthUsage } = await import("./usage");

/** A workspace with a verified owner and one project; `spent` is this month's meter. */
async function workspace(plan = "starter", spent = 0) {
  const email = `resume-${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await db.insert(users).values({ id: randomUUID(), email, emailVerified: true }).returning();
  const [ws] = await db.insert(workspaces).values({ name: email, plan }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [project] = await db.insert(projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID().slice(0, 8)}.example.com` }).returning();
  await monthUsage(ws.id);
  await db.update(workspaceUsage).set({ spentUsd: spent }).where(eq(workspaceUsage.workspaceId, ws.id));
  return { workspaceId: ws.id, projectId: project.id };
}

const LAST_MONTH = sql`date_trunc('month', now()) - interval '3 days'`;

async function pause(scope: { workspaceId: number; projectId: number }, job: string, reason: string, at: "now" | "last month" = "now") {
  await db.insert(workspaceJobPauses).values({
    ...scope,
    job,
    payload: { ...scope, runId: 7 },
    reason,
    message: `paused: ${reason}`,
    pausedAt: at === "now" ? new Date() : LAST_MONTH,
  });
}

const pausesOf = (workspaceId: number) =>
  db.select({ job: workspaceJobPauses.job, reason: workspaceJobPauses.reason }).from(workspaceJobPauses).where(eq(workspaceJobPauses.workspaceId, workspaceId));

function queue() {
  const queued: { name: string; data: object }[] = [];
  return { queued, enqueue: async (name: string, data: object) => void queued.push({ name, data }) };
}

describe.skipIf(!ready)("resumeLapsedPauses", () => {
  it.skipIf(!rules.hasPlans)("queues a job the platform cap paused once the cap has room, with its payload", async () => {
    const s = await workspace();
    await pause(s, "rank.check", "platform");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { platformOnly: true, workspaceIds: [s.workspaceId] })).toBe(1);
    expect(q.queued).toEqual([{ name: "rank.check", data: { ...s, runId: 7 } }]);
    expect(await pausesOf(s.workspaceId)).toEqual([]);
  });

  it("leaves a workspace over its own ceiling paused, row and banner, when the cap is raised", async () => {
    const s = await workspace("starter", 100);
    await pause(s, "rank.check", "platform");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { platformOnly: true, workspaceIds: [s.workspaceId] })).toBe(0);
    expect(q.queued).toEqual([]);
    expect(await pausesOf(s.workspaceId)).toEqual([{ job: "rank.check", reason: "platform" }]);
  });

  it("leaves a workspace that isn't paying paused", async () => {
    const free = await workspace("free");
    await pause(free, "rank.check", "platform");
    const none = await workspace("none");
    await pause(none, "ai.run", "platform");
    const suspended = await workspace();
    await db.update(workspaces).set({ status: "suspended" }).where(eq(workspaces.id, suspended.workspaceId));
    await pause(suspended, "rank.check", "platform");
    const q = queue();
    const ids = [free.workspaceId, none.workspaceId, suspended.workspaceId];
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: ids })).toBe(0);
    expect(q.queued).toEqual([]);
    for (const id of ids) expect(await pausesOf(id)).toHaveLength(1);
  });

  it.skipIf(!rules.hasPlans)("on a new month, queues last month's ceiling and credits pauses that now pass", async () => {
    const s = await workspace();
    await pause(s, "rank.check", "ceiling", "last month");
    await pause(s, "local.check", "credits", "last month");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] })).toBe(2);
    expect(q.queued.map((j) => j.name).sort()).toEqual(["local.check", "rank.check"]);
    expect(await pausesOf(s.workspaceId)).toEqual([]);
  });

  it("leaves this month's ceiling pause alone, and a cap Save leaves every ceiling pause alone", async () => {
    const s = await workspace("starter", 100);
    await pause(s, "rank.check", "ceiling");
    const old = await workspace();
    await pause(old, "rank.check", "ceiling", "last month");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] })).toBe(0);
    expect(await resumeLapsedPauses(q.enqueue, { platformOnly: true, workspaceIds: [s.workspaceId, old.workspaceId] })).toBe(0);
    expect(q.queued).toEqual([]);
    expect(await pausesOf(s.workspaceId)).toHaveLength(1);
    expect(await pausesOf(old.workspaceId)).toHaveLength(1);
  });

  it("keeps a trial paused over the month: its allowance is for the whole trial", async () => {
    const s = await workspace("trial");
    await db.insert(workspaceUsage).values({ workspaceId: s.workspaceId, month: sql`(date_trunc('month', now()) - interval '1 month')::date`, spentUsd: 3 });
    await pause(s, "rank.check", "ceiling", "last month");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] })).toBe(0);
    expect(await pausesOf(s.workspaceId)).toEqual([{ job: "rank.check", reason: "ceiling" }]);
  });

  it("leaves pauses for other reasons, even where the check would pass", async () => {
    const s = await workspace();
    await pause(s, "rank.check", "trial_blocked", "last month");
    await pause(s, "audit.start", "unverified", "last month");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] })).toBe(0);
    expect(await pausesOf(s.workspaceId)).toHaveLength(2);
  });

  it.skipIf(!rules.hasPlans)("queues each job once when a cap Save and the daily run sweep at the same time", async () => {
    const s = await workspace();
    await pause(s, "rank.check", "platform");
    await pause(s, "ai.run", "platform");
    const q = queue();
    const counts = await Promise.all([
      resumeLapsedPauses(q.enqueue, { platformOnly: true, workspaceIds: [s.workspaceId] }),
      resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] }),
      resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] }),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(q.queued.map((j) => j.name).sort()).toEqual(["ai.run", "rank.check"]);
  });

  it.skipIf(!rules.hasPlans)("keeps the pause when queueing fails, for the next sweep", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await workspace();
    await pause(s, "rank.check", "platform");
    const failing = async () => {
      throw new Error("pg-boss is down");
    };
    expect(await resumeLapsedPauses(failing, { workspaceIds: [s.workspaceId] })).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const [row] = await db
      .select({ reason: workspaceJobPauses.reason })
      .from(workspaceJobPauses)
      .where(and(eq(workspaceJobPauses.workspaceId, s.workspaceId), eq(workspaceJobPauses.job, "rank.check")));
    expect(row?.reason).toBe("platform");
    const q = queue();
    expect(await resumeLapsedPauses(q.enqueue, { workspaceIds: [s.workspaceId] })).toBe(1);
  });
});
