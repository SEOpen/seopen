import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * AI visibility → Actions against seopen_test: actions come from the stored answers, only their status
 * and the outreach list are saved, and only actions on the list now can change.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { getAiActions, getOverview } = await import("./data");
const { saveToListOp, setActionStatusOp } = await import("./action-ops");

type Project = typeof s.projects.$inferSelect;

describe.runIf(ready)("AI visibility actions", () => {
  let p: Project;
  let prompts: number[];
  const scope = () => ({ workspaceId: p.workspaceId, projectId: p.id });

  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fernhill", domain: `fernhill-${randomUUID().slice(0, 8)}.example` }).returning();
    await db.insert(s.competitors).values({ workspaceId: ws.id, projectId: p.id, domain: "rival.example" });
    const rows = await db
      .insert(s.aiPrompts)
      .values(["best coffee roaster near me", "is Fernhill any good"].map((prompt) => ({ workspaceId: ws.id, projectId: p.id, prompt, platforms: ["chat_gpt", "claude"] })))
      .returning();
    prompts = rows.map((r) => r.id);
  });

  const run = async (startedAt: string, answers: [prompt: number, platform: string, named: boolean, cites: string[]][]) => {
    const [r] = await db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status: "done", startedAt: new Date(startedAt), finishedAt: new Date(startedAt) }).returning();
    for (const [i, platform, named, cites] of answers) {
      await db.insert(s.aiResults).values({
        workspaceId: p.workspaceId,
        projectId: p.id,
        runId: r.id,
        promptId: prompts[i],
        platform,
        status: "done",
        mentioned: named,
        cited: false,
        citations: cites.map((url) => ({ url, domain: new URL(url).hostname })),
        mentions: [
          { domain: p.domain, own: true, count: named ? 1 : 0, firstOffset: null, position: null, cited: false },
          { domain: "rival.example", own: false, count: 1, firstOffset: null, position: null, cited: false },
        ],
        completedAt: new Date(startedAt),
      });
    }
  };

  const LIST = "https://bestof.example/roasters";
  const THREAD = "https://reddit.com/r/coffee/abc";

  const seed = () =>
    run("2026-11-09T12:00:00Z", [
      [0, "chat_gpt", false, [LIST, THREAD]],
      [0, "claude", false, [LIST]],
      [1, "chat_gpt", true, []],
      [1, "claude", true, []],
    ]);

  it("lists actions for the prompt the site isn't named for, with the competitors named beside each page", async () => {
    await seed();
    const view = await getAiActions(p);
    const [first, second] = view.prompts;
    expect(first).toMatchObject({ promptId: prompts[0], state: "not_named", branded: false, missedOn: ["chat_gpt", "claude"] });
    expect(first.actions.map((a) => [a.kind, a.url, a.status])).toEqual([
      ["write", "", "open"],
      ["featured", LIST, "open"],
      ["thread", THREAD, "open"],
    ]);
    expect(first.actions[1]).toMatchObject({ answers: 2, competitors: ["rival.example"] });
    expect(second).toMatchObject({ promptId: prompts[1], state: "confirming", branded: true, actions: [] });
  });

  it("previews a status change without saving it, then saves only what's on the list now", async () => {
    await seed();
    const refs = [
      { promptId: prompts[0], kind: "featured" as const, url: LIST },
      { promptId: prompts[0], kind: "write" as const },
      { promptId: prompts[1], kind: "write" as const },
    ];
    const dry = await setActionStatusOp(scope(), refs, "done", { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, message: "Would mark 2 actions as done." });
    expect(dry.skipped).toEqual([expect.objectContaining({ promptId: prompts[1], why: expect.stringMatching(/isn't on the Actions list/) })]);
    expect(await db.$count(s.aiActions, eq(s.aiActions.projectId, p.id))).toBe(0);

    const done = await setActionStatusOp(scope(), refs, "done");
    expect(done.message).toBe("Marked 2 actions as done.");
    const again = await setActionStatusOp(scope(), refs.slice(0, 1), "done");
    expect(again.skipped).toEqual([expect.objectContaining({ why: "It's already done." })]);
    const view = await getAiActions(p);
    expect(view.prompts[0].actions.map((a) => a.status)).toEqual(["done", "done", "open"]);
  });

  it("saves a Get featured page to the outreach list and takes it off, but not a thread", async () => {
    await seed();
    await saveToListOp(scope(), { promptId: prompts[0], kind: "featured", url: LIST }, true);
    let view = await getAiActions(p);
    expect(view.saved).toEqual([expect.objectContaining({ url: LIST, domain: "bestof.example", prompt: "best coffee roaster near me", status: "open" })]);
    expect(view.prompts[0].actions[1].saved).toBe(true);
    await expect(saveToListOp(scope(), { promptId: prompts[0], kind: "thread", url: THREAD }, true)).rejects.toThrow(/Get featured/);
    await saveToListOp(scope(), { promptId: prompts[0], kind: "featured", url: LIST }, false);
    view = await getAiActions(p);
    expect(view.saved).toEqual([]);
  });

  it("resolves a prompt after two runs in a row name the site, and its actions leave the list", async () => {
    await seed();
    await run("2026-11-16T12:00:00Z", [
      [0, "chat_gpt", true, []],
      [0, "claude", true, []],
      [1, "chat_gpt", true, []],
      [1, "claude", true, []],
    ]);
    let view = await getAiActions(p);
    expect(view.prompts.map((x) => [x.promptId, x.state])).toEqual([
      [prompts[0], "confirming"],
      [prompts[1], "resolved"],
    ]);
    await run("2026-11-23T12:00:00Z", [
      [0, "chat_gpt", true, []],
      [0, "claude", true, []],
    ]);
    view = await getAiActions(p);
    expect(view.prompts.find((x) => x.promptId === prompts[0])?.state).toBe("resolved");
    await expect(setActionStatusOp(scope(), [{ promptId: prompts[0], kind: "write" }], "done")).resolves.toMatchObject({ changed: [] });
  });

  it("counts branded and generic prompts apart on the overview, whatever the setting", async () => {
    await seed();
    const o = await getOverview(p);
    expect(o.includesBranded).toBe(false);
    expect(o.current).toMatchObject({ total: 2, mentioned: 0 });
    expect(o.groups.generic).toMatchObject({ total: 2, mentioned: 0 });
    expect(o.groups.branded).toMatchObject({ total: 2, mentioned: 2, score: 1 });
  });
});
