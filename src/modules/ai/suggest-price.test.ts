import { beforeEach, describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

/** "Suggest prompts" spends research credits at no more than the price its button shows. */

const dfsPost = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/dataforseo/client", async (orig) => ({ ...(await orig<typeof import("@/lib/dataforseo/client")>()), dfsPost }));

const { fetchProjectKeywords } = await import("./dfs");
const { SUGGEST_LOOKUP_USD, SUGGEST_MAX_USD } = await import("./prompts");
const { labsCost } = await import("@/modules/keywords/requests");
const { maxCostLabel } = await import("@/modules/keywords/format");

const ctx = { workspaceId: 7, projectId: 1, locationCode: 2840, languageCode: "en" };
const answer = (items: unknown[]) => ({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items }] }] });
const ranked = (n: number) => Array.from({ length: n }, (_, i) => ({ keyword_data: { keyword: `k${i}`, keyword_info: { search_volume: 10 } } }));

describe("Suggest prompts' price", () => {
  beforeEach(() => dfsPost.mockReset());

  it.skipIf(!rules.hasPlans)("is Labs' price for 100 rows, twice over at most, shown in credits", () => {
    expect(SUGGEST_LOOKUP_USD).toBeCloseTo(labsCost(100), 9);
    expect(SUGGEST_MAX_USD).toBeCloseTo(2 * labsCost(100), 9);
    expect(maxCostLabel(SUGGEST_MAX_USD)).toBe("≈ 5 credits max");
  });

  it("charges each lookup as research, reserved and capped at its share", async () => {
    dfsPost.mockResolvedValueOnce(answer(ranked(3))).mockResolvedValueOnce(answer([{ keyword: "site", keyword_info: { search_volume: 5 } }]));
    const out = await fetchProjectKeywords("example.com", ctx);
    expect(out.map((k) => k.keyword)).toEqual(["k0", "k1", "k2", "site"]);
    expect(dfsPost).toHaveBeenCalledTimes(2);
    for (const [, , opts] of dfsPost.mock.calls) {
      expect(opts).toMatchObject({ module: "ai", research: true, estimateUsd: SUGGEST_LOOKUP_USD, maxChargeUsd: SUGGEST_LOOKUP_USD });
    }
  });

  it("makes one lookup when the site ranks for enough", async () => {
    dfsPost.mockResolvedValueOnce(answer(ranked(10)));
    await fetchProjectKeywords("example.com", ctx);
    expect(dfsPost).toHaveBeenCalledTimes(1);
  });
});
