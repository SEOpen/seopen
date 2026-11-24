import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Re-running detection on stored answers against seopen_test, as after a brand alias changes. It
 * writes what detection finds on every done answer and AI Overview of the project, leaves pending
 * rows alone, and never writes another workspace's rows. No API calls.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { asc, eq } = await import("drizzle-orm");
const { redetectProject } = await import("./run");

/** What a row held before detection ran again: wrong on purpose, so a write shows. */
const STALE = { mentions: [], mentioned: false, cited: true, position: 9 };

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `ai-redetect-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Brewhaus", domain: "brewhaus.example" }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  await db.insert(s.competitors).values({ ...scope, domain: "rivalbeans.example" });
  const [prompt] = await db.insert(s.aiPrompts).values({ ...scope, prompt: "best coffee", platforms: ["chat_gpt"], keyword: "best coffee" }).returning();
  const [run] = await db.insert(s.aiRuns).values({ ...scope, status: "done" }).returning();
  return { scope, promptId: prompt.id, runId: run.id };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const result = async (x: Seeded, platform: string, status: string, answer: string | null, citations: { url: string; domain: string }[] = []) => {
  const [r] = await db
    .insert(s.aiResults)
    .values({ ...x.scope, runId: x.runId, promptId: x.promptId, platform, status, answer, citations, ...STALE })
    .returning();
  return r.id;
};

const overview = async (x: Seeded, status: string, text: string | null, references: { url: string; domain: string }[] = []) => {
  // One overview per run and prompt, so each gets its own run.
  const [run] = await db.insert(s.aiRuns).values({ ...x.scope, status: "done" }).returning();
  const [o] = await db
    .insert(s.aiOverviews)
    .values({ ...x.scope, runId: run.id, promptId: x.promptId, keyword: "best coffee", status, text, references, mentioned: false, cited: true })
    .returning();
  return o.id;
};

const resultRow = async (id: number) => (await db.select().from(s.aiResults).where(eq(s.aiResults.id, id)))[0];
const overviewRow = async (id: number) => (await db.select().from(s.aiOverviews).where(eq(s.aiOverviews.id, id)))[0];

const ownCite = [{ url: "https://brewhaus.example/menu", domain: "brewhaus.example" }];
const rivalCite = [{ url: "https://rivalbeans.example/", domain: "rivalbeans.example" }];

describe.skipIf(!ready)("redetectProject", () => {
  it("writes each done answer's own detection, row by row", async () => {
    const x = await seed();
    const first = await result(x, "chat_gpt", "done", "Try Brewhaus first, then Rivalbeans.", ownCite);
    const second = await result(x, "gemini", "done", "Rivalbeans beats Brewhaus. Brewhaus is fine too.");
    const none = await result(x, "claude", "done", "Nothing to see here.", rivalCite);
    const empty = await result(x, "perplexity", "done", null);
    const pending = await result(x, "google_ai_mode", "pending", "Brewhaus is great.", ownCite);

    await redetectProject(x.scope);

    expect(await resultRow(first)).toMatchObject({
      mentioned: true,
      cited: true,
      position: 1,
      mentions: [
        { domain: "brewhaus.example", own: true, count: 1, firstOffset: 4, position: 1, cited: true },
        { domain: "rivalbeans.example", own: false, count: 1, firstOffset: 25, position: 2, cited: false },
      ],
    });
    expect(await resultRow(second)).toMatchObject({
      mentioned: true,
      cited: false,
      position: 2,
      mentions: [
        { domain: "brewhaus.example", own: true, count: 2, firstOffset: 17, position: 2, cited: false },
        { domain: "rivalbeans.example", own: false, count: 1, firstOffset: 0, position: 1, cited: false },
      ],
    });
    expect(await resultRow(none)).toMatchObject({
      mentioned: false,
      cited: false,
      position: null,
      mentions: [
        { domain: "brewhaus.example", own: true, count: 0, firstOffset: null, position: null, cited: false },
        { domain: "rivalbeans.example", own: false, count: 0, firstOffset: null, position: null, cited: true },
      ],
    });
    expect(await resultRow(empty)).toMatchObject({ mentioned: false, cited: false, position: null });
    // Pending answers are not detected yet: they keep what they had.
    expect(await resultRow(pending)).toMatchObject(STALE);
  });

  it("writes each done AI Overview's mention and citation, and leaves a pending one", async () => {
    const x = await seed();
    const named = await overview(x, "done", "Brewhaus roasts its own beans.");
    const citedOnly = await overview(x, "done", "Local roasters vary.", ownCite);
    const neither = await overview(x, "done", null, rivalCite);
    const pending = await overview(x, "pending", "Brewhaus roasts its own beans.", ownCite);

    await redetectProject(x.scope);

    expect(await overviewRow(named)).toMatchObject({ mentioned: true, cited: false });
    expect(await overviewRow(citedOnly)).toMatchObject({ mentioned: false, cited: true });
    expect(await overviewRow(neither)).toMatchObject({ mentioned: false, cited: false });
    expect(await overviewRow(pending)).toMatchObject({ mentioned: false, cited: true });
  });

  it("never writes another workspace's answers or overviews", async () => {
    const x = await seed();
    const other = await seed();
    const mine = await result(x, "chat_gpt", "done", "Brewhaus is great.", ownCite);
    const theirs = await result(other, "chat_gpt", "done", "Brewhaus is great.", ownCite);
    const theirOverview = await overview(other, "done", "Brewhaus is great.", ownCite);

    await redetectProject(x.scope);

    expect(await resultRow(mine)).toMatchObject({ mentioned: true, cited: true, position: 1 });
    expect(await resultRow(theirs)).toMatchObject(STALE);
    expect(await overviewRow(theirOverview)).toMatchObject({ mentioned: false, cited: true });
  });

  it("writes every row of a project with more answers than one statement takes", async () => {
    const x = await seed();
    // 1,100 answers on two platforms: past two chunk edges.
    const prompts = await db
      .insert(s.aiPrompts)
      .values(Array.from({ length: 550 }, (_, i) => ({ ...x.scope, prompt: `prompt ${i}`, platforms: ["chat_gpt", "gemini"] })))
      .returning({ id: s.aiPrompts.id });
    await db.insert(s.aiResults).values(
      prompts.flatMap((p, i) =>
        ["chat_gpt", "gemini"].map((platform) => ({
          ...x.scope,
          runId: x.runId,
          promptId: p.id,
          platform,
          status: "done",
          // Every third answer names us, so each row's value is its own.
          answer: i % 3 === 0 ? "Brewhaus." : "Nobody.",
          citations: [],
          ...STALE,
        })),
      ),
    );

    await redetectProject(x.scope);

    const rows = await db
      .select({ promptId: s.aiResults.promptId, mentioned: s.aiResults.mentioned, position: s.aiResults.position, cited: s.aiResults.cited })
      .from(s.aiResults)
      .where(eq(s.aiResults.runId, x.runId))
      .orderBy(asc(s.aiResults.promptId), asc(s.aiResults.platform));
    expect(rows).toHaveLength(1100);
    rows.forEach((r, n) => {
      const named = Math.floor(n / 2) % 3 === 0;
      expect(r).toEqual({ promptId: prompts[Math.floor(n / 2)].id, mentioned: named, position: named ? 1 : null, cited: false });
    });
  });
});
