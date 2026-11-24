import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/** The daily purge of URL inspections, against seopen_test: each project keeps its newest INSPECTIONS_KEPT, and no other project's rows go. */

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { INSPECTIONS_KEPT, purgeOldInspections } = await import("./retention");

describe.skipIf(!ready)("purgeOldInspections", () => {
  it("keeps each project's newest inspections and deletes the older ones", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `inspect-purge-${randomUUID()}`, plan: "internal" }).returning();
    const project = async () => (await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `inspect-${randomUUID()}.example` }).returning())[0];
    const [big, small] = [await project(), await project()];
    const start = Date.UTC(2026, 0, 1);
    const rows = (projectId: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ workspaceId: ws.id, projectId, url: `https://site.example/${i}`, inspectedAt: new Date(start + i * 60_000), verdict: "PASS" }));
    await db.insert(s.gscUrlInspections).values([...rows(big.id, INSPECTIONS_KEPT + 30), ...rows(small.id, 5)]);

    expect(await purgeOldInspections()).toBeGreaterThanOrEqual(30);
    const kept = await db.select().from(s.gscUrlInspections).where(eq(s.gscUrlInspections.projectId, big.id)).orderBy(asc(s.gscUrlInspections.inspectedAt));
    expect(kept).toHaveLength(INSPECTIONS_KEPT);
    // The 30 oldest went: the oldest left is the 31st inspected.
    expect(kept[0].url).toBe("https://site.example/30");
    expect(await db.select().from(s.gscUrlInspections).where(eq(s.gscUrlInspections.projectId, small.id))).toHaveLength(5);

    expect(await purgeOldInspections()).toBe(0);
  });
});
