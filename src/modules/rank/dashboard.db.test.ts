import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/** What the Overview says of keywords with no results yet, against seopen_test. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { dashboard } = await import("./dashboard");

async function seed(keywords: number, plan: "internal" | "free" = "internal") {
  const [ws] = await db.insert(s.workspaces).values({ name: `rank-card-${randomUUID()}`, plan }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `site-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  for (let i = 0; i < keywords; i++) await db.insert(s.rankKeywords).values({ ...scope, keyword: `keyword ${i}` });
  const run = (status: "posting" | "pending" | "done" | "failed", createdAt = new Date()) => db.insert(s.rankRuns).values({ ...scope, kind: "manual", date: "2026-11-07", depth: 20, status, createdAt });
  return { project, run };
}

describe.skipIf(!ready)("the Rankings module with no results", () => {
  it("waits for a check that hasn't started", async () => {
    const { project } = await seed(2);
    expect(await dashboard.waiting!(project)).toBe("2 keywords tracked, waiting for the first check");
  });

  it("says the first check is running while it posts or waits on results", async () => {
    const posting = await seed(1);
    await posting.run("posting");
    expect(await dashboard.waiting!(posting.project)).toBe("1 keyword tracked, the first check is running");
    const pending = await seed(8);
    await pending.run("pending");
    expect(await dashboard.waiting!(pending.project)).toBe("8 keywords tracked, the first check is running");
  });

  it("doesn't call a finished, failed or stuck check running", async () => {
    for (const [status, at] of [["done", undefined], ["failed", undefined], ["posting", new Date(Date.now() - 86_400_000)]] as const) {
      const { project, run } = await seed(2);
      await run(status, at);
      expect(await dashboard.waiting!(project)).toBe("2 keywords tracked, waiting for the first check");
    }
  });

  it.skipIf(!rules.hasPlans)("doesn't promise a check on Free, which runs none", async () => {
    const { project } = await seed(3, "free");
    expect(await dashboard.waiting!(project)).toBe("3 keywords tracked, not checked on the Free plan");
  });

  it("has nothing to say with no keywords", async () => {
    const { project, run } = await seed(0);
    await run("pending");
    expect(await dashboard.waiting!(project)).toBeNull();
  });
});
