import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import type { Refinement } from "./refine";

/**
 * Claude's setup review against seopen_test, with the call itself stubbed: the same inputs reuse
 * the saved answer without asking Claude again (so reopening the setup uses no free review), and
 * changed inputs ask again.
 */

vi.mock("server-only", () => ({}));

const answer: Refinement = {
  summary: "A Salem web design studio.",
  competitors: [{ domain: "rivalstudio.example", reason: "Another Salem studio." }],
  keywords: ["salem web design"],
  ideas: [],
  prompts: [],
};
const callClaude = vi.fn(async () => ({
  response: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] },
  costUsd: 0.04,
}));
vi.mock("@/lib/ai/claude", () => ({ CLAUDE_MODEL: "claude-opus-5-5", claudeConfigured: () => true, callClaude }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { refineProposal } = await import("./refine.server");
const { plainProposal } = await import("./propose");
type SetupInput = import("./propose").SetupInput;

const input = (domain: string): SetupInput => ({
  domain,
  projectName: "Beta Web Design",
  type: "other",
  site: { title: "Beta Web Design", description: "Web design in Salem, NH", headings: [], business: null, cities: [] },
  keywords: [{ keyword: "salem web design", volume: 390 }],
  ideas: [],
  competitors: [{ domain: "rivalstudio.example", keywords: 9 }],
  existing: { competitors: [], keywords: [], prompts: [] },
  room: { keywords: 100, prompts: 25 },
});

describe.skipIf(!ready)("refineProposal", () => {
  it("reuses a saved review for the same inputs and asks again when they change", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `refine-${randomUUID()}`, plan: "internal" }).returning();
    const scope = { workspaceId: ws.id, projectId: 0 };
    const first = input(`refine-${ws.id}.example`);

    const a = await refineProposal(ws, scope, first, plainProposal(first));
    const b = await refineProposal(ws, scope, first, plainProposal(first));
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ...b, costUsd: 0.04 });
    expect(b).toMatchObject({ costUsd: 0, proposal: { summary: answer.summary, competitors: [{ domain: "rivalstudio.example" }] } });

    const changed = { ...first, existing: { ...first.existing, prompts: ["Who designs websites in Salem?"] } };
    await refineProposal(ws, scope, changed, plainProposal(changed));
    expect(callClaude).toHaveBeenCalledTimes(2);
  });
});
