import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * The atomic monthly ceiling, against seopen_test: many reservations at once never pass the
 * workspace's ceiling, its research credits or the platform cap, and settling or releasing frees
 * the room again. Nothing here talks to DataForSEO.
 */

// A Free audit claims its project's site (site-claims.ts), which needs the server key.
process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");

const ready = await testDb();

const { db } = await import("@/db");
const { apiLedger, auditCrawls, projects, spendReservations, users, workspaceMembers, workspaces } = await import("@/db/schema");
const { SpendRefusedError } = await import("./errors");
const { monthUsage, platformMonthUsage, release, releaseStaleReservations, reserve, settle } = await import("./usage");
const { reserveSpend, spendBlock } = await import("./spend");
const { auditRefusal, loadBillingWorkspace, projectActionRefusal } = await import("./workspace");
const { paidJobRefusal } = await import("./jobs-gate");

const REFUSALS = {
  ceiling: { code: "ceiling", message: "ceiling", upgradable: false },
  credits: { code: "credits", message: "credits", upgradable: false },
  platform: { code: "platform", message: "platform", upgradable: false },
} as const;

async function workspace(plan = "starter") {
  const [ws] = await db.insert(workspaces).values({ name: `usage-${randomUUID()}`, plan }).returning();
  return ws.id;
}

/** Fires `n` reservations at once; returns the ones that went through. */
async function burst(n: number, args: Omit<Parameters<typeof reserve>[0], "refusals">) {
  const results = await Promise.allSettled(Array.from({ length: n }, () => reserve({ ...args, refusals: REFUSALS })));
  for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SpendRefusedError);
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

describe.skipIf(!ready)("atomic reservation", () => {
  it("40 concurrent calls never reserve past the ceiling", async () => {
    const id = await workspace();
    const granted = await burst(40, { workspaceId: id, estimateUsd: 0.1, research: false, ceilingUsd: 1, creditsUsd: null, platformCapUsd: null });
    expect(granted).toHaveLength(10);
    const usage = await monthUsage(id);
    expect(usage.reservedUsd).toBeCloseTo(1, 6);
    await Promise.all(granted.map(release));
  });

  it("settling frees the estimate and records the real cost; the ceiling counts spent plus reserved", async () => {
    const id = await workspace();
    const args = { workspaceId: id, estimateUsd: 0.5, research: false, ceilingUsd: 1, creditsUsd: null, platformCapUsd: null } as const;
    const a = await reserve({ ...args, refusals: REFUSALS });
    const b = await reserve({ ...args, refusals: REFUSALS });
    await expect(reserve({ ...args, refusals: REFUSALS })).rejects.toMatchObject({ code: "ceiling" });
    await settle(a, { chargedUsd: 0.2, costUsd: 0.1 });
    await release(b);
    expect(await monthUsage(id)).toMatchObject({ spentUsd: 0.2, reservedUsd: 0 });
    // 0.2 spent: one more 0.5 fits, a second doesn't.
    const c = await reserve({ ...args, refusals: REFUSALS });
    await expect(reserve({ ...args, refusals: REFUSALS })).rejects.toMatchObject({ code: "ceiling" });
    await release(c);
  });

  it("research credits hold under concurrency too, and plan work doesn't use them", async () => {
    const id = await workspace();
    const granted = await burst(30, { workspaceId: id, estimateUsd: 0.05, research: true, ceilingUsd: 10, creditsUsd: 0.5, platformCapUsd: null });
    expect(granted).toHaveLength(10);
    await expect(
      reserve({ workspaceId: id, estimateUsd: 0.05, research: true, ceilingUsd: 10, creditsUsd: 0.5, platformCapUsd: null, refusals: REFUSALS }),
    ).rejects.toMatchObject({ code: "credits" });
    // A rank check (plan meter) still fits under the dollar ceiling.
    const plan = await reserve({ workspaceId: id, estimateUsd: 0.05, research: false, ceilingUsd: 10, creditsUsd: 0.5, platformCapUsd: null, refusals: REFUSALS });
    const usage = await monthUsage(id);
    expect(usage.researchReservedUsd).toBeCloseTo(0.5, 6);
    expect(usage.reservedUsd).toBeCloseTo(0.55, 6);
    await Promise.all([...granted, plan].map(release));
  });

  it("a research call can hold less against its credits than against the ceiling", async () => {
    const id = await workspace();
    const args = { workspaceId: id, estimateUsd: 0.4, research: true, ceilingUsd: 10, creditsUsd: 0.1, platformCapUsd: null } as const;
    // The whole estimate against 10 credits' worth doesn't fit; the quoted part does.
    await expect(reserve({ ...args, refusals: REFUSALS })).rejects.toMatchObject({ code: "credits" });
    const r = await reserve({ ...args, researchEstimateUsd: 0.06, refusals: REFUSALS });
    expect(await monthUsage(id)).toMatchObject({ reservedUsd: 0.4, researchReservedUsd: 0.06 });
    // Two rows, the research part and the rest, so the cleanup can take each off the right meter.
    const rows = await db.select().from(spendReservations).where(eq(spendReservations.workspaceId, id));
    expect(rows.map((row) => [row.estimateUsd, row.research]).sort()).toEqual([[0.06, true], [0.34, false]]);
    await expect(reserve({ ...args, researchEstimateUsd: 0.06, refusals: REFUSALS })).rejects.toMatchObject({ code: "credits" });

    // A real cost above what the credits held is recorded in full, not refused.
    await settle(r, { chargedUsd: 0.08, costUsd: 0.08 });
    const usage = await monthUsage(id);
    expect(usage).toMatchObject({ reservedUsd: 0, researchReservedUsd: 0 });
    expect(usage.spentUsd).toBeCloseTo(0.08, 6);
    expect(usage.researchUsd).toBeCloseTo(0.08, 6);
    expect(await db.select().from(spendReservations).where(eq(spendReservations.workspaceId, id))).toEqual([]);
  });

  it("a leaked split reservation comes off each meter by its own part, once", async () => {
    const id = await workspace();
    const args = { workspaceId: id, research: true, ceilingUsd: 10, creditsUsd: 1, platformCapUsd: null, refusals: REFUSALS } as const;
    const leaked = await reserve({ ...args, estimateUsd: 0.4, researchEstimateUsd: 0.06 });
    const live = await reserve({ ...args, estimateUsd: 0.1 });
    await db
      .update(spendReservations)
      .set({ createdAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(inArray(spendReservations.id, [leaked.id, leaked.restId!]));

    await releaseStaleReservations();
    const usage = await monthUsage(id);
    expect(usage.reservedUsd).toBeCloseTo(0.1, 6);
    expect(usage.researchReservedUsd).toBeCloseTo(0.1, 6);

    // Settling after the cleanup released it releases nothing again.
    await settle(leaked, { chargedUsd: 0.04, costUsd: 0.04 });
    expect((await monthUsage(id)).researchReservedUsd).toBeCloseTo(0.1, 6);
    await release(live);
    expect(await monthUsage(id)).toMatchObject({ reservedUsd: 0, researchReservedUsd: 0 });
  });

  it("a month's row seeded from the ledger counts every research module, Local SEO too", async () => {
    const id = await workspace();
    await db.insert(apiLedger).values([
      { workspaceId: id, endpoint: "/made-up", module: "local", chargedUsd: 0.25 },
      { workspaceId: id, endpoint: "/made-up", module: "keywords", chargedUsd: 0.5 },
      { workspaceId: id, endpoint: "/made-up", module: "rank", chargedUsd: 2 },
    ]);
    const usage = await monthUsage(id);
    expect(usage.spentUsd).toBeCloseTo(2.75);
    expect(usage.researchUsd).toBeCloseTo(0.75);
  });

  it("the platform cap holds across workspaces, and a refusal there reserves nothing for the workspace", async () => {
    const ids = await Promise.all([workspace(), workspace(), workspace()]);
    const before = await platformMonthUsage();
    const cap = before.spentUsd + before.reservedUsd + 0.3;
    const results = await Promise.allSettled(
      ids.flatMap((workspaceId) =>
        Array.from({ length: 5 }, () => reserve({ workspaceId, estimateUsd: 0.1, research: false, ceilingUsd: 10, creditsUsd: null, platformCapUsd: cap, refusals: REFUSALS })),
      ),
    );
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    // Other test files may spend at the same time, which only leaves less room.
    expect(granted.length).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "platform")).toBe(true);
    const reservedByWorkspaces = (await Promise.all(ids.map(monthUsage))).reduce((n, u) => n + u.reservedUsd, 0);
    expect(reservedByWorkspaces).toBeCloseTo(granted.length * 0.1, 6);
    await Promise.all(granted.map(release));
  });

  it.skipIf(!rules.hasPlans)("reserveSpend: a Free workspace may spend only on audits, up to its ceiling", async () => {
    const free = await workspace("free");
    const ownerId = `usage-${randomUUID()}`;
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.com`, emailVerified: true });
    await db.insert(workspaceMembers).values({ workspaceId: free, userId: ownerId, role: "owner" });
    const audit = await reserveSpend(free, 0.045, false, "audit");
    await release(audit);
    await expect(reserveSpend(free, 0.01, false, "rank")).rejects.toMatchObject({ code: "free_plan" });
    await expect(reserveSpend(free, 0.01, true, "keywords")).rejects.toMatchObject({ code: "free_plan" });
    await expect(reserveSpend(free, 0.31, false, "audit")).rejects.toMatchObject({ code: "ceiling" });
    expect(await spendBlock(free, { research: true })).toMatchObject({ code: "free_plan" });
  });

  it.skipIf(!rules.hasPlans)("a Free workspace gets one audit a week and no other paid work", async () => {
    const id = await workspace("free");
    const ownerId = `usage-${randomUUID()}`;
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.com`, emailVerified: true });
    await db.insert(workspaceMembers).values({ workspaceId: id, userId: ownerId, role: "owner" });
    const [project] = await db.insert(projects).values({ workspaceId: id, name: "site", domain: `${ownerId}.example.com` }).returning();
    const ws = await loadBillingWorkspace(id);
    const scope = { workspaceId: id, projectId: project.id };
    const crawl = (status: "done" | "failed", createdAt = new Date()) =>
      db.insert(auditCrawls).values({ workspaceId: id, projectId: project.id, target: project.domain, trigger: "manual", maxPages: 100, enableJavascript: false, loadResources: true, estimatedCostUsd: 0.045, status, createdAt });

    expect(await projectActionRefusal(scope, { paid: true })).toMatchObject({ code: "free_plan" });
    expect(await projectActionRefusal(scope, { paid: true, onFree: true })).toBeNull();
    expect(await paidJobRefusal("rank.schedule", scope)).toMatchObject({ code: "free_plan" });
    expect(await paidJobRefusal("backlinks.snapshot", scope)).toMatchObject({ code: "free_plan" });
    expect(await paidJobRefusal("audit.lighthouse", scope)).toMatchObject({ code: "free_plan" });

    expect(await auditRefusal(ws)).toBeNull();
    await crawl("failed");
    await crawl("done", new Date(Date.now() - 8 * 86_400_000));
    expect(await auditRefusal(ws)).toBeNull();
    expect(await paidJobRefusal("audit.schedule", scope)).toBeNull();
    await crawl("done");
    expect(await auditRefusal(ws)).toMatchObject({ code: "free_audit" });
    expect(await paidJobRefusal("audit.schedule", scope)).toMatchObject({ code: "free_audit" });
  });

  it.skipIf(!rules.hasPlans)("reserveSpend: no plan, unverified email and suspension refuse; a verified trial stops at $3", async () => {
    const none = await workspace("none");
    await expect(reserveSpend(none, 0.01, false)).rejects.toMatchObject({ code: "no_plan" });
    expect(await spendBlock(none)).toMatchObject({ code: "no_plan" });

    const trial = await workspace("trial");
    const userId = `usage-${randomUUID()}`;
    await db.insert(users).values({ id: userId, email: `${userId}@example.com`, emailVerified: false });
    await db.insert(workspaceMembers).values({ workspaceId: trial, userId, role: "owner" });
    await expect(reserveSpend(trial, 0.01, false)).rejects.toMatchObject({ code: "unverified" });

    await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
    const granted: Awaited<ReturnType<typeof reserveSpend>>[] = [];
    for (let i = 0; i < 4; i++) granted.push(await reserveSpend(trial, 0.75, false));
    await expect(reserveSpend(trial, 0.75, false)).rejects.toMatchObject({ code: "ceiling", upgradable: true });
    expect(await spendBlock(trial)).toMatchObject({ code: "ceiling" });
    await Promise.all(granted.map(release));

    await db.update(workspaces).set({ status: "suspended" }).where(eq(workspaces.id, trial));
    await expect(reserveSpend(trial, 0.01, false)).rejects.toMatchObject({ code: "suspended" });
  });
});
