import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The daily purge of rank_tasks, against seopen_test: a finished run's tasks go once none is pending
 * and the last was fetched over TASK_KEEP_MS ago. Every task the tracker can still read stays: a run
 * still posting or pending, a run closed while tasks were out, and one that only just finished. The
 * purge runs on a clock in 2001, so it can't touch rows other test files are using at the same time.
 */

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { TASK_KEEP_MS, purgeFinishedTasks } = await import("./retention");

const NOW = new Date("2001-01-01T00:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe.skipIf(!ready)("purgeFinishedTasks", () => {
  it("deletes the tasks of finished runs nothing reads any more and keeps the rest", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `rank-purge-${randomUUID()}`, plan: "internal" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `purge-${ws.id}.example` }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: "kw" }).returning();
    // Only one run per project can be posting or pending, so the open runs get a project each.
    const openProject = async () => (await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `purge-${randomUUID()}.example` }).returning())[0];
    const runIn = async (projectId: number, status: "posting" | "pending" | "done" | "failed") =>
      (await db.insert(s.rankRuns).values({ workspaceId: ws.id, projectId, kind: "daily", date: "2001-01-01", depth: 20, status }).returning())[0];
    const task = (runId: number, attempt: number, status: "pending" | "done" | "failed", fetchedAt: Date | null) => ({
      id: randomUUID(),
      workspaceId: ws.id,
      runId,
      keywordId: keyword.id,
      attempt,
      status,
      postedAt: at(-6 * HOUR),
      fetchedAt,
    });

    const done = await runIn(project.id, "done");
    const failed = await runIn(project.id, "failed");
    // createRun closes a stale posting run while its tasks are still out: the poller still reads them.
    const closedEarly = await runIn(project.id, "failed");
    const justDone = await runIn(project.id, "done");
    const pending = await runIn((await openProject()).id, "pending");
    const posting = await runIn((await openProject()).id, "posting");
    const tasks = {
      done: [task(done.id, 1, "done", at(-3 * HOUR)), task(done.id, 2, "failed", at(-2 * HOUR))],
      failed: [task(failed.id, 1, "failed", null)],
      closedEarly: [task(closedEarly.id, 1, "done", at(-3 * HOUR)), task(closedEarly.id, 2, "pending", null)],
      justDone: [task(justDone.id, 1, "done", at(-3 * HOUR)), task(justDone.id, 2, "failed", at(-TASK_KEEP_MS + 60_000))],
      pending: [task(pending.id, 1, "done", at(-3 * HOUR))],
      posting: [task(posting.id, 1, "done", at(-3 * HOUR))],
    };
    await db.insert(s.rankTasks).values(Object.values(tasks).flat());

    const purged = await purgeFinishedTasks(NOW);

    const left = await db.select({ id: s.rankTasks.id }).from(s.rankTasks).where(eq(s.rankTasks.workspaceId, ws.id));
    const kept = [...tasks.closedEarly, ...tasks.justDone, ...tasks.pending, ...tasks.posting];
    expect(left.map((t) => t.id).sort()).toEqual(kept.map((t) => t.id).sort());
    expect(purged).toBeGreaterThanOrEqual(3);

    await db.delete(s.workspaces).where(eq(s.workspaces.id, ws.id));
  });
});
