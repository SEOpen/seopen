import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * One queued Lighthouse test per project, against seopen_test. The audit queue runs one job at a
 * time for every workspace, so a project that could queue tests without limit could hold everyone
 * else's behind its own.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { failLighthouse, queueLighthouse } = await import("./crawl");

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `lh-${randomUUID().slice(0, 8)}`, plan: "pro" }).returning();
  const project = async () =>
    (await db.insert(s.projects).values({ workspaceId: ws.id, name: "p", domain: `${randomUUID().slice(0, 8)}.example.com` }).returning())[0];
  const [a, b] = [await project(), await project()];
  return { a: { workspaceId: ws.id, projectId: a.id }, b: { workspaceId: ws.id, projectId: b.id } };
}

const queued = (projectId: number) => db.$count(s.auditLighthouse, eq(s.auditLighthouse.projectId, projectId));

describe.skipIf(!ready)("queueLighthouse", () => {
  it("queues one test per project, even when two clicks land at once", async () => {
    const { a, b } = await seed();
    const ids = await Promise.all([queueLighthouse(a, "https://a/"), queueLighthouse(a, "https://a/"), queueLighthouse(a, "https://a/")]);
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await queued(a.projectId)).toBe(1);
    // Another project of the same workspace still gets its own.
    expect(await queueLighthouse(b, "https://b/")).not.toBeNull();
  });

  it("queues again once the last test finished, failed, or sat queued past the hour", async () => {
    const { a } = await seed();
    const first = (await queueLighthouse(a, "https://a/"))!;
    await db.update(s.auditLighthouse).set({ status: "done" }).where(eq(s.auditLighthouse.id, first));
    const second = (await queueLighthouse(a, "https://a/"))!;
    expect(second).not.toBeNull();
    await failLighthouse(a, second, "Not queued");
    const third = (await queueLighthouse(a, "https://a/"))!;
    expect(third).not.toBeNull();
    await db.update(s.auditLighthouse).set({ createdAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(s.auditLighthouse.id, third));
    expect(await queueLighthouse(a, "https://a/")).not.toBeNull();
  });

  it("fails only a row of its own project", async () => {
    const { a, b } = await seed();
    const id = (await queueLighthouse(a, "https://a/"))!;
    await failLighthouse(b, id, "Not queued");
    const [row] = await db.select().from(s.auditLighthouse).where(eq(s.auditLighthouse.id, id));
    expect(row.status).toBe("queued");
  });
});
