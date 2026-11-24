import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Applying the guided setup's checklist against seopen_test: each ticked item lands through the
 * ops, keywords keep their own tags, applying again adds nothing twice, and a refused step says why
 * without stopping the others.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { applySetupOp } = await import("./apply");

async function seed() {
  const [user] = await db
    .insert(s.users)
    .values({ id: `u-${randomUUID()}`, email: `setup-${randomUUID()}@example.com`, emailVerified: true })
    .returning();
  const [ws] = await db.insert(s.workspaces).values({ name: `setup-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id });
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Setup site", domain: `setup-${ws.id}.example` }).returning();
  return { actor: { userId: user.id, source: "app" as const }, project };
}

const selection = {
  competitors: ["rival-one.example", "rival-two.example"],
  keywords: [
    { keyword: "shared notes mac", tag: "notes" },
    { keyword: "mac notes app", tag: "notes" },
    { keyword: "journal mac", tag: null },
  ],
  prompts: [{ prompt: "What is the best shared notes app for Mac?", keyword: "shared notes mac", topic: "notes" }],
  checks: { rank: false, ai: false, audit: false },
};

describe.skipIf(!ready)("applySetupOp", () => {
  it("keeps a competitor's business name as an alias, only for competitors it added", async () => {
    const { actor, project } = await seed();
    const named = { ...selection, keywords: [], prompts: [], competitorNames: { "rival-one.example": "Rival One", "unticked.example": "Not Ticked" } };
    await applySetupOp(project, actor, named);
    const aliases = await db.select({ domain: s.aiBrandAliases.domain, alias: s.aiBrandAliases.alias }).from(s.aiBrandAliases).where(eq(s.aiBrandAliases.projectId, project.id));
    expect(aliases).toEqual([{ domain: "rival-one.example", alias: "Rival One" }]);
    await applySetupOp(project, actor, named);
    expect(await db.$count(s.aiBrandAliases, eq(s.aiBrandAliases.projectId, project.id))).toBe(1);
  });

  it("adds what was ticked, keeps each keyword's tag, and adds nothing twice", async () => {
    const { actor, project } = await seed();
    const results = await applySetupOp(project, actor, selection);
    expect(results.map((r) => [r.step, r.ok])).toEqual([
      ["competitors", true],
      ["keywords", true],
      ["prompts", true],
    ]);

    const comps = await db.select({ domain: s.competitors.domain }).from(s.competitors).where(eq(s.competitors.projectId, project.id));
    expect(comps.map((c) => c.domain).sort()).toEqual(selection.competitors);
    const kws = await db.select({ keyword: s.rankKeywords.keyword, tags: s.rankKeywords.tags }).from(s.rankKeywords).where(eq(s.rankKeywords.projectId, project.id));
    expect(Object.fromEntries(kws.map((k) => [k.keyword, k.tags]))).toEqual({
      "shared notes mac": ["notes"],
      "mac notes app": ["notes"],
      "journal mac": [],
    });
    const prompts = await db.select({ prompt: s.aiPrompts.prompt, source: s.aiPrompts.source, topic: s.aiPrompts.topic }).from(s.aiPrompts).where(eq(s.aiPrompts.projectId, project.id));
    expect(prompts).toEqual([{ prompt: selection.prompts[0].prompt, source: "suggested", topic: "notes" }]);

    await applySetupOp(project, actor, selection);
    expect(await db.$count(s.competitors, eq(s.competitors.projectId, project.id))).toBe(2);
    expect(await db.$count(s.rankKeywords, eq(s.rankKeywords.projectId, project.id))).toBe(3);
    expect(await db.$count(s.aiPrompts, eq(s.aiPrompts.projectId, project.id))).toBe(1);
  });

  it("moves rank tracking to a city of the project's country, first, and refuses one elsewhere", async () => {
    const { actor, project } = await seed();
    await db.insert(s.dfsPlaces).values({ code: 900112, name: "Riverton, Ohio", countryIso: "us" }).onConflictDoNothing();
    const results = await applySetupOp(project, actor, { ...selection, city: 900112 });
    expect(results[0]).toEqual({ step: "city", ok: true, message: "Rankings are searched from Riverton, Ohio." });
    const [after] = await db.select().from(s.projects).where(eq(s.projects.id, project.id));
    expect([after.cityCode, after.cityName]).toEqual([900112, "Riverton, Ohio"]);

    const other = await seed();
    const refused = await applySetupOp(other.project, other.actor, { ...selection, keywords: [], prompts: [], competitors: [], city: 999999999 });
    expect(refused[0].step).toBe("city");
    expect(refused[0].ok).toBe(false);
    const [unmoved] = await db.select().from(s.projects).where(eq(s.projects.id, other.project.id));
    expect(unmoved.cityCode).toBeNull();
  });

  it("reports a refused step and still runs the rest", async () => {
    const { actor, project } = await seed();
    // Nothing to check yet: the rank check is refused, the competitors still land.
    const results = await applySetupOp(project, actor, { ...selection, keywords: [], prompts: [], checks: { rank: true, ai: false, audit: false } });
    expect(results).toEqual([
      { step: "competitors", ok: true, message: "Added 2 competitors." },
      { step: "rank", ok: false, message: "This project tracks no keywords yet. Add some first." },
    ]);
  });
});
