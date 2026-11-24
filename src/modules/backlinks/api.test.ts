import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What each backlinks call reserves before it's made: its own list price from `estimateCostUsd`,
 * not the client's flat default, which is under half of what a 500-row list costs.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));

const posts: { path: string; estimateUsd?: number }[] = [];

vi.mock("@/lib/dataforseo/client", () => ({
  TTL: { day: 86_400, week: 604_800 },
  peekCache: vi.fn(async () => null),
  firstResult: (res: { tasks: { result: unknown[] }[] }) => res.tasks[0]?.result?.[0] ?? null,
  dfsPost: vi.fn(async (path: string, _tasks: unknown[], opts: { estimateUsd?: number }) => {
    posts.push({ path, estimateUsd: opts.estimateUsd });
    return { cost: 0.03, tasks: [{ status_code: 20000, cost: 0.03, result: [{ total_count: 0, items_count: 0, items: [] }] }] };
  }),
}));

const { getAnchors, getBacklinks, getCompetitorGap, getNewLost, getReferringDomains, GAP_LIMIT, LIST_LIMIT } = await import("./api");
const { estimateCostUsd } = await import("./logic");

const opts = { workspaceId: 1, projectId: 1 };

describe("backlinks reservations", () => {
  beforeEach(() => {
    posts.length = 0;
  });

  it("a 500-row list reserves what 500 rows cost", async () => {
    await getBacklinks("example.com", opts);
    await getReferringDomains("example.com", opts);
    await getAnchors("example.com", opts);
    expect(LIST_LIMIT).toBe(500);
    expect(posts.map((p) => p.estimateUsd)).toEqual([estimateCostUsd(500), estimateCostUsd(500), estimateCostUsd(500)]);
    expect(posts[0].estimateUsd).toBeCloseTo(0.042, 6);
  });

  it("a smaller list reserves for its own limit", async () => {
    await getBacklinks("example.com", { ...opts, limit: 100 });
    await getCompetitorGap("rival.example", "example.com", opts);
    expect(posts.map((p) => p.estimateUsd)).toEqual([estimateCostUsd(100), estimateCostUsd(GAP_LIMIT)]);
  });

  it("the 12-month history reserves for its 13 rows", async () => {
    await getNewLost("example.com", opts);
    expect(posts[0].estimateUsd).toBe(estimateCostUsd(13));
  });
});
