import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Adding a business is paid like the search before it: a search older than a day is bought again. */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { FREE_PLAN_REFUSAL } = await import("@/lib/billing/spend");
const { addBusinessOp } = await import("./ops");

describe.skipIf(!ready)("adding a Local business", () => {
  it("refuses a Free workspace before it searches, as step 1 does", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `local-ops-${Date.now()}-${Math.random()}`, plan: "free" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Local site", domain: "local.example" }).returning();
    const add = addBusinessOp({ workspaceId: ws.id, projectId: project.id }, { name: "Joe's Pizza", city: "Salem", listing: "cid:1" });
    await expect(add).rejects.toThrow(FREE_PLAN_REFUSAL.message);
    expect(await db.select().from(s.apiLedger).where(eq(s.apiLedger.workspaceId, ws.id))).toEqual([]);
  });
});
