import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * One AI visibility run by hand per project a week (2026-11-12), against seopen_test. Runs this
 * week that were queued, running or done count; the Monday cron run, a failed run, last week's runs
 * and another project's runs don't. The internal plan has no limit unless set by hand.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { manualAiRunRefusal, loadBillingWorkspace } = await import("./workspace");

async function setup(plan: string, limits?: Record<string, number>) {
  const [ws] = await db.insert(s.workspaces).values({ name: `manual-ai-${randomUUID()}`, plan, limits }).returning();
  const [a] = await db.insert(s.projects).values({ workspaceId: ws.id, domain: `a-${randomUUID().slice(0, 8)}.example`, name: "A" }).returning();
  const [b] = await db.insert(s.projects).values({ workspaceId: ws.id, domain: `b-${randomUUID().slice(0, 8)}.example`, name: "B" }).returning();
  return { ws: await loadBillingWorkspace(ws.id), a: a.id, b: b.id };
}

const run = (workspaceId: number, projectId: number, over: Partial<typeof s.aiRuns.$inferInsert> = {}) =>
  db.insert(s.aiRuns).values({ workspaceId, projectId, trigger: "manual", status: "done", ...over });

describe.skipIf(!ready)("manual AI visibility runs per week", () => {
  it.skipIf(!rules.hasPlans)("allows one run by hand per project a week on Starter", async () => {
    const { ws, a, b } = await setup("starter");
    expect(await manualAiRunRefusal(ws, a)).toBeNull();
    await run(ws.id, a);
    expect(await manualAiRunRefusal(ws, a)).toMatchObject({ code: "ai_manual_runs", upgradable: false });
    // Another project has its own run.
    expect(await manualAiRunRefusal(ws, b)).toBeNull();
  });

  it.skipIf(!rules.hasPlans)("doesn't count the Monday run, a failed run or last week's", async () => {
    const { ws, a } = await setup("pro");
    await run(ws.id, a, { trigger: "cron" });
    await run(ws.id, a, { status: "failed" });
    await run(ws.id, a, { startedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    expect(await manualAiRunRefusal(ws, a)).toBeNull();
    await run(ws.id, a, { status: "queued" });
    expect(await manualAiRunRefusal(ws, a)).not.toBeNull();
  });

  it.skipIf(!rules.hasPlans)("leaves the internal plan unlimited unless set by hand", async () => {
    const open = await setup("internal");
    for (let i = 0; i < 3; i++) await run(open.ws.id, open.a);
    expect(await manualAiRunRefusal(open.ws, open.a)).toBeNull();
    const capped = await setup("internal", { manualAiRunsPerWeek: 1 });
    await run(capped.ws.id, capped.a);
    expect(await manualAiRunRefusal(capped.ws, capped.a)).not.toBeNull();
  });
});
