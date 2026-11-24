import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The weekly Local scheduler against seopen_test. It once compared created_at with a raw Date in
 * sql``, which the driver sends as Date.toString(), so every run failed in production. A business
 * checked this week is skipped without any call to DataForSEO.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dataforseo/client", () => ({
  dfsGet: vi.fn(() => Promise.reject(new Error("no DataForSEO in this test"))),
  dfsPost: vi.fn(() => Promise.reject(new Error("no DataForSEO in this test"))),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { scheduleProject } = await import("./tracker");

describe.skipIf(!ready)("scheduleProject", () => {
  it("skips a business that was checked this week", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `local-${randomUUID()}`, plan: "internal" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Shop", domain: `shop-${ws.id}.example` }).returning();
    const [business] = await db
      .insert(s.localBusinesses)
      .values({ workspaceId: ws.id, projectId: project.id, query: "Shop", city: "Salem, NH", title: "Shop", cid: "1", lat: 42.79, lng: -71.2 })
      .returning();
    await db.insert(s.localChecks).values({
      workspaceId: ws.id,
      projectId: project.id,
      businessId: business.id,
      kind: "scheduled",
      gridSize: 5,
      radiusMiles: 5,
      zoom: 13,
      lat: 42.79,
      lng: -71.2,
      status: "done",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await expect(scheduleProject({ workspaceId: ws.id, projectId: project.id })).resolves.toEqual([]);
  });
});
