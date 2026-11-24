import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/** Admin on a copy without plans (admin.ts) against seopen_test: core's counts, and suspended workspaces as Health's list. */

const ready = await testDb();

const { db } = await import("@/db");
const { workspaces } = await import("@/db/schema");
const { admin } = await import("./admin");

describe.skipIf(!ready)("self-hosted admin", () => {
  it("shows workspaces and projects, and nothing a plan would add", async () => {
    const o = await admin.overview(30);
    expect(o.figures.map((f) => f.id)).toEqual(["workspaces", "projects"]);
    expect(o.daily).toEqual([]);
    expect(o.funnel).toBeNull();
  });

  it("lists a suspended workspace and no other", async () => {
    const [suspended, active] = await db
      .insert(workspaces)
      .values([
        { name: `suspended-${randomUUID()}`, status: "suspended" },
        { name: `active-${randomUUID()}`, billingError: "Your card was declined." },
      ])
      .returning({ id: workspaces.id });
    const { rows, noun } = await admin.stopped();
    expect(rows.find((r) => r.workspaceId === suspended.id)).toMatchObject({ problem: "Suspended" });
    expect(rows.some((r) => r.workspaceId === active.id)).toBe(false);
    expect(noun).toBe("suspended workspace");
  });

  it("adds nothing to the workspace pages", async () => {
    expect(await admin.workspaces([{ id: 1, plan: "internal" }], "UTC")).toEqual({ figures: [], kinds: [], byId: new Map() });
    const [ws] = await db.insert(workspaces).values({ name: `ws-${randomUUID()}` }).returning();
    expect(await admin.workspace(ws, "UTC")).toMatchObject({ facts: [], problems: 0, status: null });
  });
});
