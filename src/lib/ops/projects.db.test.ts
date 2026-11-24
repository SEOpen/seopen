import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/** Restoring and deleting an archived project against seopen_test: it comes back with its data if the plan has room, and goes for good only when "delete" is typed. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { deleteProjectOp, restoreProjectOp } = await import("./projects");

const actor = { userId: "test-user", source: "app" as const };

async function seed(limits?: Record<string, number>) {
  const [ws] = await db.insert(s.workspaces).values({ name: `restore-${randomUUID()}`, plan: "internal", limits }).returning();
  const [archived] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Old site", domain: `old-${ws.id}.example`, archived: true }).returning();
  await db.insert(s.rankKeywords).values({ workspaceId: ws.id, projectId: archived.id, keyword: "old keyword" });
  return { ws, archived, scope: { workspaceId: ws.id, projectId: archived.id } };
}

const archivedNow = async (id: number) => (await db.select({ a: s.projects.archived }).from(s.projects).where(eq(s.projects.id, id)))[0].a;

describe.skipIf(!ready)("restoreProjectOp", () => {
  it("brings an archived project back with its keywords", async () => {
    const { archived, scope } = await seed();
    expect(await restoreProjectOp(scope)).toEqual({ dryRun: false, message: "Restored Old site." });
    expect(await archivedNow(archived.id)).toBe(false);
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.projectId, archived.id))).toBe(1);
    await expect(restoreProjectOp(scope)).rejects.toThrow("Old site isn't archived.");
  });

  it.skipIf(!rules.hasPlans)("refuses when the plan has no room for another project, and changes nothing", async () => {
    const { ws, archived, scope } = await seed({ projects: 1 });
    await db.insert(s.projects).values({ workspaceId: ws.id, name: "Live site", domain: `live-${ws.id}.example` });
    await expect(restoreProjectOp(scope)).rejects.toThrow(/^Can't restore Old site: /);
    expect(await archivedNow(archived.id)).toBe(true);
  });

  it.skipIf(!rules.hasPlans)("refuses when its keywords no longer fit", async () => {
    const { archived, scope } = await seed({ keywords: 0 });
    await expect(restoreProjectOp(scope)).rejects.toThrow(/^Can't restore Old site: It tracks 1 keyword\. /);
    expect(await archivedNow(archived.id)).toBe(true);
  });

  it("only restores within its own workspace", async () => {
    const { archived } = await seed();
    const other = await seed();
    await expect(restoreProjectOp({ workspaceId: other.ws.id, projectId: archived.id })).rejects.toThrow("No such project in this workspace.");
  });
});

describe.skipIf(!ready)("deleteProjectOp", () => {
  const exists = async (id: number) => (await db.$count(s.projects, eq(s.projects.id, id))) === 1;

  it("removes the project and what's stored under it, and leaves the spend ledger", async () => {
    const { ws, archived, scope } = await seed();
    await db.insert(s.apiLedger).values({ workspaceId: ws.id, endpoint: "serp", module: "rank", projectId: archived.id, costUsd: 0.5 });
    expect(await deleteProjectOp(scope, actor, " Delete ")).toEqual({ dryRun: false, message: "Deleted Old site." });
    expect(await exists(archived.id)).toBe(false);
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.workspaceId, ws.id))).toBe(0);
    const [spend] = await db.select().from(s.apiLedger).where(eq(s.apiLedger.workspaceId, ws.id));
    expect(spend).toMatchObject({ projectId: null, costUsd: 0.5 });
  });

  it("refuses without the word delete", async () => {
    const { archived, scope } = await seed();
    await expect(deleteProjectOp(scope, actor, "Old site")).rejects.toThrow("Type delete to confirm.");
    await expect(deleteProjectOp(scope, actor, "")).rejects.toThrow("Type delete to confirm.");
    expect(await exists(archived.id)).toBe(true);
  });

  it("refuses a project that isn't archived", async () => {
    const { ws } = await seed();
    const [live] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Live site", domain: `live-${ws.id}.example` }).returning();
    await expect(deleteProjectOp({ workspaceId: ws.id, projectId: live.id }, actor, "delete")).rejects.toThrow("Archive Live site before deleting it.");
    expect(await exists(live.id)).toBe(true);
  });

  it("refuses while a check is running, and not after it finishes", async () => {
    const { ws, archived, scope } = await seed();
    const [run] = await db.insert(s.aiRuns).values({ workspaceId: ws.id, projectId: archived.id, status: "running" }).returning();
    await expect(deleteProjectOp(scope, actor, "delete")).rejects.toThrow("A check is still running on Old site. Delete it once that finishes.");
    expect(await exists(archived.id)).toBe(true);
    await db.update(s.aiRuns).set({ status: "done" }).where(eq(s.aiRuns.id, run.id));
    await deleteProjectOp(scope, actor, "delete");
    expect(await exists(archived.id)).toBe(false);
  });

  it("changes nothing on a dry run", async () => {
    const { archived, scope } = await seed();
    expect(await deleteProjectOp(scope, actor, "delete", { dryRun: true })).toEqual({ dryRun: true, message: "Would delete Old site." });
    expect(await exists(archived.id)).toBe(true);
  });

  it("only deletes within its own workspace", async () => {
    const { archived } = await seed();
    const other = await seed();
    await expect(deleteProjectOp({ workspaceId: other.ws.id, projectId: archived.id }, actor, "delete")).rejects.toThrow("No such project in this workspace.");
    expect(await exists(archived.id)).toBe(true);
  });
});
