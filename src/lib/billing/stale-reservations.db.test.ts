import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Clearing reservations a crashed call never settled, against seopen_test. The platform's row is
 * touched by every workspace's calls, so it is rarely quiet for an hour; its reservations are the
 * sum of the workspaces' instead, which keeps the live ones and drops the leaked ones. The rows
 * here are for a month long past, so no other test file's calls touch them.
 */

const ready = await testDb();

const { db } = await import("@/db");
const { platformUsage, spendReservations, workspaces, workspaceUsage } = await import("@/db/schema");
const { releaseStaleReservations, settle } = await import("./usage");

const MONTH = "2001-03-01";
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000);

async function workspaceRow(reservedUsd: number, updatedAt: Date) {
  const [ws] = await db.insert(workspaces).values({ name: `stale-${randomUUID()}`, plan: "starter" }).returning();
  await db.insert(workspaceUsage).values({ workspaceId: ws.id, month: MONTH, reservedUsd, researchReservedUsd: reservedUsd, updatedAt });
  return ws.id;
}

const usageOf = async (workspaceId: number) =>
  (await db.select().from(workspaceUsage).where(sql`${workspaceUsage.workspaceId} = ${workspaceId} and ${workspaceUsage.month} = ${MONTH}`))[0];
const platformReserved = async () => (await db.select().from(platformUsage).where(eq(platformUsage.month, MONTH)))[0]?.reservedUsd;

describe.skipIf(!ready)("releaseStaleReservations", () => {
  // Only this file uses MONTH, so earlier runs' rows for it can go.
  const clear = async () => {
    await db.delete(spendReservations).where(eq(spendReservations.month, MONTH));
    await db.delete(workspaceUsage).where(eq(workspaceUsage.month, MONTH));
    await db.delete(platformUsage).where(eq(platformUsage.month, MONTH));
  };

  /** A reservation's own row, as `reserve` writes it. */
  const held = async (workspaceId: number, estimateUsd: number, createdAt: Date) =>
    (await db.insert(spendReservations).values({ workspaceId, month: MONTH, estimateUsd, research: true, createdAt }).returning())[0];
  beforeEach(clear);
  afterAll(clear);

  it("clears a leaked reservation from a busy platform row and keeps the live ones", async () => {
    const leaked = await workspaceRow(0.5, HOURS_AGO(2));
    const live = await workspaceRow(0.2, new Date());
    // Another workspace's call touched the platform row a moment ago.
    await db.insert(platformUsage).values({ month: MONTH, reservedUsd: 0.7, updatedAt: new Date() });

    await releaseStaleReservations();

    expect(await usageOf(leaked)).toMatchObject({ reservedUsd: 0, researchReservedUsd: 0 });
    expect(await usageOf(live)).toMatchObject({ reservedUsd: 0.2, researchReservedUsd: 0.2 });
    expect(await platformReserved()).toBeCloseTo(0.2, 6);
  });

  it("clears a busy workspace's own leaked reservation and keeps its live one", async () => {
    // Another call touched the workspace's row a moment ago, so it's never quiet for an hour.
    const busy = await workspaceRow(0.7, new Date());
    const leaked = await held(busy, 0.5, HOURS_AGO(2));
    const live = await held(busy, 0.2, new Date());
    await db.insert(platformUsage).values({ month: MONTH, reservedUsd: 0.7, updatedAt: new Date() });

    await releaseStaleReservations();

    const row = await usageOf(busy);
    expect(row.reservedUsd).toBeCloseTo(0.2, 6);
    expect(row.researchReservedUsd).toBeCloseTo(0.2, 6);
    expect(await platformReserved()).toBeCloseTo(0.2, 6);
    const left = await db.select({ id: spendReservations.id }).from(spendReservations).where(eq(spendReservations.workspaceId, busy));
    expect(left.map((r) => r.id)).toEqual([live.id]);
    expect(leaked.id).not.toBe(live.id);
  });

  it("doesn't release again when a call settles after the cleanup released it", async () => {
    const busy = await workspaceRow(0.7, new Date());
    const late = await held(busy, 0.5, HOURS_AGO(2));
    await held(busy, 0.2, new Date());
    await db.insert(platformUsage).values({ month: MONTH, reservedUsd: 0.7, updatedAt: new Date() });
    await releaseStaleReservations();

    await settle({ id: late.id, workspaceId: busy, month: MONTH, estimateUsd: 0.5, research: true }, { chargedUsd: 0.4, costUsd: 0.3 });

    const row = await usageOf(busy);
    expect(row.reservedUsd).toBeCloseTo(0.2, 6);
    expect(row.spentUsd).toBeCloseTo(0.4, 6);
    expect(await platformReserved()).toBeCloseTo(0.2, 6);
  });

  it("drops a reservation whose workspace is gone", async () => {
    const id = await workspaceRow(0.3, new Date());
    await db.insert(platformUsage).values({ month: MONTH, reservedUsd: 0.3, updatedAt: new Date() });
    await db.delete(workspaces).where(eq(workspaces.id, id));

    await releaseStaleReservations();

    expect(await platformReserved()).toBeCloseTo(0, 6);
  });
});
