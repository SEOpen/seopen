import { describe, expect, it } from "vitest";
import type { LocalListing } from "@/db/schema/local";
import { addStats, avgRank, bucketOf, competitorsAcrossGrid, foundLabel, foundShare, rankChange, statsFromPoints, top3Share } from "./metrics";

const L = (r: number, cid: string, t = cid): LocalListing => ({ r, t, cid, pid: null, cat: null, addr: null, d: null, rating: null, votes: null });

describe("statsFromPoints", () => {
  const points = [
    { status: "done" as const, rank: 1 },
    { status: "done" as const, rank: 3 },
    { status: "done" as const, rank: 8 },
    { status: "done" as const, rank: null },
    { status: "failed" as const, rank: null },
    { status: "pending" as const, rank: null },
  ];
  const s = statsFromPoints(points);

  it("counts failed points apart from not found", () => {
    expect(s).toEqual({ total: 6, answered: 4, failed: 1, found: 3, top3: 2, rankSum: 12 });
    expect(foundLabel(s)).toBe("3/4 · 1 failed");
  });

  it("averages rank over found points and shares over answered ones", () => {
    expect(avgRank(s)).toBe(4);
    expect(top3Share(s)).toBe(0.5);
    expect(foundShare(s)).toBe(0.75);
  });

  it("has no averages when nothing answered or nothing was found", () => {
    const failed = statsFromPoints([{ status: "failed", rank: null }]);
    expect(avgRank(failed)).toBeNull();
    expect(top3Share(failed)).toBeNull();
    expect(foundLabel(failed)).toBe("0/0 · 1 failed");
    expect(avgRank(statsFromPoints([{ status: "done", rank: null }]))).toBeNull();
  });

  it("reports the change in average rank, negative being better", () => {
    const before = statsFromPoints([{ status: "done", rank: 6 }, { status: "done", rank: 8 }]);
    expect(rankChange(s, before)).toBe(-3);
    expect(rankChange(s, null)).toBeNull();
    expect(rankChange(statsFromPoints([{ status: "failed", rank: null }]), before)).toBeNull();
  });

  it("adds keywords up", () => {
    expect(addStats([s, s])).toEqual({ total: 12, answered: 8, failed: 2, found: 6, top3: 4, rankSum: 24 });
    expect(addStats([])).toEqual({ total: 0, answered: 0, failed: 0, found: 0, top3: 0, rankSum: 0 });
  });
});

describe("bucketOf", () => {
  it("follows the legend", () => {
    expect([1, 3, 4, 10, 11, 20].map((rank) => bucketOf({ status: "done", rank }))).toEqual(["top3", "top3", "top10", "top10", "top20", "top20"]);
    expect(bucketOf({ status: "done", rank: null })).toBe("none");
    expect(bucketOf({ status: "failed", rank: null })).toBe("failed");
    expect(bucketOf({ status: "pending", rank: null })).toBe("pending");
  });
});

describe("competitorsAcrossGrid", () => {
  it("ranks businesses by points present, then average rank, and marks ours", () => {
    const points = [
      { status: "done" as const, items: [L(1, "a"), L(2, "b"), L(3, "us")] },
      { status: "done" as const, items: [L(1, "b"), L(2, "a")] },
      { status: "done" as const, items: [L(1, "c"), L(2, "a"), L(5, "us")] },
      // A failed point adds nothing, and isn't in the denominator.
      { status: "failed" as const, items: [] },
    ];
    const list = competitorsAcrossGrid(points, { cid: "us", placeId: null });
    expect(list.map((c) => [c.key, c.present, Math.round(c.avgRank * 100) / 100, c.ours])).toEqual([
      ["cid:a", 3, 1.67, false],
      ["cid:b", 2, 1.5, false],
      ["cid:us", 2, 4, true],
      ["cid:c", 1, 1, false],
    ]);
    expect(list[0].answered).toBe(3);
  });

  it("counts a business once per point and respects the limit", () => {
    const points = [{ status: "done" as const, items: [L(1, "a"), L(4, "a"), L(2, "b")] }];
    const list = competitorsAcrossGrid(points, { cid: null, placeId: null }, 1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "cid:a", present: 1, avgRank: 1 });
  });
});
