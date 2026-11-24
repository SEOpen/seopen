import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Paused jobs starting again after an upgrade or a grant, against seopen_test. A job that
 * couldn't be queued keeps its pause row, and the jobs after it are still queued. Two resumes at
 * once queue each job once. Nothing is queued for real: enqueue is a stub.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { projects, workspaceJobPauses, workspaces } = await import("@/db/schema");
const { resumePausedJobs } = await import("./pauses");

const JOBS = ["rank.check", "ai.run", "local.check"];

/** A workspace with one project and a pause for each of JOBS. */
async function paused() {
  const [ws] = await db.insert(workspaces).values({ name: `pauses-${randomUUID()}`, plan: "starter" }).returning();
  const [project] = await db.insert(projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID().slice(0, 8)}.example.com` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  for (const job of JOBS) {
    await db.insert(workspaceJobPauses).values({ ...scope, job, payload: { ...scope, job }, reason: "ceiling", message: "Monthly limit reached" });
  }
  return scope;
}

const pausedJobs = async (workspaceId: number) =>
  (await db.select({ job: workspaceJobPauses.job }).from(workspaceJobPauses).where(eq(workspaceJobPauses.workspaceId, workspaceId))).map((r) => r.job).sort();

function queue(failing: string[] = []) {
  const queued: { name: string; data: object }[] = [];
  const enqueue = async (name: string, data: object) => {
    // Let another resume reach the same rows before this one finishes.
    await new Promise((r) => setTimeout(r, 5));
    if (failing.includes(name)) throw new Error("pg-boss is down");
    queued.push({ name, data });
  };
  return { queued, enqueue };
}

describe.skipIf(!ready)("resumePausedJobs", () => {
  it("queues every paused job with its payload and clears the pauses", async () => {
    const s = await paused();
    const q = queue();
    expect(await resumePausedJobs(s.workspaceId, q.enqueue)).toBe(3);
    expect(q.queued.map((j) => j.name).sort()).toEqual([...JOBS].sort());
    expect(q.queued.find((j) => j.name === "ai.run")!.data).toEqual({ ...s, job: "ai.run" });
    expect(await pausedJobs(s.workspaceId)).toEqual([]);
  });

  it("keeps the pause of a job it couldn't queue, and still queues the ones after it", async () => {
    const s = await paused();
    const q = queue(["rank.check"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resumePausedJobs(s.workspaceId, q.enqueue)).toBe(2);
    error.mockRestore();
    expect(q.queued.map((j) => j.name).sort()).toEqual(["ai.run", "local.check"]);
    expect(await pausedJobs(s.workspaceId)).toEqual(["rank.check"]);
  });

  it("queues each job once when two resumes run at the same time", async () => {
    const s = await paused();
    const q = queue();
    const [a, b] = await Promise.all([resumePausedJobs(s.workspaceId, q.enqueue), resumePausedJobs(s.workspaceId, q.enqueue)]);
    expect(a + b).toBe(3);
    expect(q.queued.map((j) => j.name).sort()).toEqual([...JOBS].sort());
    expect(await pausedJobs(s.workspaceId)).toEqual([]);
  });

  it("leaves another workspace's pauses", async () => {
    const mine = await paused();
    const theirs = await paused();
    await resumePausedJobs(mine.workspaceId, queue().enqueue);
    expect(await pausedJobs(theirs.workspaceId)).toEqual([...JOBS].sort());
  });
});
