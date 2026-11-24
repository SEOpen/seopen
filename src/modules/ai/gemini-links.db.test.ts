import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A Gemini answer's redirect links are stored as the pages they lead to, against seopen_test with
 * DataForSEO and the redirect lookups faked. Nothing leaves the machine.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const PAGES: Record<string, string> = {
  [redirect("OURS")]: "https://www.mugsite.example/handmade",
  [redirect("THEIRS")]: "https://mugreview.example/best-mugs-2026",
};

const lookups: string[] = [];
vi.mock("@/lib/web/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web/fetch")>()),
  safeFetch: vi.fn(async (url: string) => {
    lookups.push(url);
    const location = PAGES[url];
    return location ? { status: 302, headers: { location } } : { status: 404, headers: {} };
  }),
}));

vi.mock("@/lib/dataforseo/client", async () => {
  const { BudgetExceededError } = await import("@/lib/billing/errors");
  return {
    BudgetExceededError,
    TTL: { week: 604_800 },
    monthToDateSpendUsd: vi.fn(async () => 0),
    recordLedgerAdjustment: vi.fn(async () => {}),
    taskResults: (res: { tasks: { result: unknown[] | null }[] }) => res.tasks[0]?.result ?? [],
    dfsGet: vi.fn(async () => {
      throw new Error("no fetch expected");
    }),
    dfsPost: vi.fn(async (path: string) => {
      const result = path.includes("llm_mentions")
        ? { aggregated_metrics: {} }
        : {
            model_name: "m",
            items: [
              {
                type: "message",
                sections: [
                  {
                    text: "Try a handmade mug from a local shop.",
                    annotations: [
                      { url: redirect("OURS"), title: "mugsite.example" },
                      { url: redirect("THEIRS"), title: "The best mugs of 2026" },
                      { url: redirect("GONE"), title: "oldsite.example" },
                    ],
                  },
                ],
              },
            ],
          };
      return { cost: 0.01, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.01, result: [result] }] };
    }),
  };
});

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { executeRun } = await import("./run");

describe.skipIf(!ready)("a Gemini answer's links", () => {
  it("are stored as the pages they lead to, and one that can't be followed is kept as it came", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `ai-gemini-${randomUUID()}`, plan: "internal" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Mug Site", domain: "mugsite.example" }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    await db.insert(s.aiPrompts).values({ ...scope, prompt: "best handmade mug", platforms: ["gemini"] });
    const [run] = await db.insert(s.aiRuns).values({ ...scope, status: "queued", estimatedCostUsd: 0.1 }).returning();

    lookups.length = 0;
    await executeRun(scope, run.id);

    const [row] = await db.select().from(s.aiResults).where(eq(s.aiResults.runId, run.id));
    expect(row.status).toBe("done");
    expect(row.citations).toEqual([
      { url: "https://www.mugsite.example/handmade", domain: "mugsite.example", title: null },
      { url: "https://mugreview.example/best-mugs-2026", domain: "mugreview.example", title: "The best mugs of 2026" },
      { url: redirect("GONE"), domain: "oldsite.example", title: "oldsite.example" },
    ]);
    // The site's own page is cited, by its real address.
    expect(row.cited).toBe(true);
    expect(lookups.sort()).toEqual([redirect("GONE"), redirect("OURS"), redirect("THEIRS")]);
  });
});
