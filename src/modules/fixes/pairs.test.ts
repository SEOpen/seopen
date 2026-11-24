import { describe, expect, it } from "vitest";
import { coveredBy, foldPairs, similarMatch } from "./pairs";

const A = "https://fix.example/services/seo/";
const B = "https://fix.example/services/local-seo/";
const C = "https://fix.example/blog/gmb/";
const similar = (url: string, match: string, impressions = 0, more = "") => ({ code: "duplicate-content", url, detail: `${match} (8 of 10${more})`, pageImpressions: impressions });

describe("similarMatch", () => {
  it("reads the closest match and its score from the audit's detail", () => {
    expect(similarMatch(`${B} (8 of 10)`)).toEqual({ url: B, similarity: "8", more: 0 });
    expect(similarMatch(`${B} (7.5 of 10, +2 more)`)).toEqual({ url: B, similarity: "7.5", more: 2 });
    expect(similarMatch(null)).toBeNull();
    expect(similarMatch("something else")).toBeNull();
  });
});

describe("foldPairs", () => {
  it("keeps one finding for two pages that are each other's closest match", () => {
    const { keep, covered } = foldPairs([similar(A, B, 10), similar(B, A, 50), { code: "missing-h1", url: A, detail: null, pageImpressions: 10 }], []);
    // The page people see more of carries the pair.
    expect(keep.map((f) => [f.code, f.url])).toEqual([["duplicate-content", B], ["missing-h1", A]]);
    expect(covered).toEqual(new Map([[A, B]]));
  });

  it("leaves a page whose closest match points elsewhere as its own finding", () => {
    const { keep, covered } = foldPairs([similar(A, B), similar(B, C), similar(C, B)], []);
    // B and C are a pair, and with nothing else to go on the first address carries it.
    expect(keep.map((f) => f.url)).toEqual([A, C]);
    expect(covered).toEqual(new Map([[B, C]]));
  });

  it("keeps the page that already has a record, so existing pairs settle on the one acted on or the older one", () => {
    expect(foldPairs([similar(A, B, 0), similar(B, A, 99)], [{ id: 7, url: A, status: "open" }, { id: 9, url: B, status: "open" }]).covered).toEqual(new Map([[B, A]]));
    expect(foldPairs([similar(A, B, 0), similar(B, A, 99)], [{ id: 7, url: B, status: "open" }, { id: 9, url: A, status: "applied" }]).covered).toEqual(new Map([[B, A]]));
    expect(foldPairs([similar(A, B, 99), similar(B, A, 0)], [{ id: 3, url: A, status: "resolved" }, { id: 4, url: B, status: "dismissed" }]).covered).toEqual(new Map([[A, B]]));
  });

  it("doesn't fold two pages that someone has acted on separately", () => {
    const { keep, covered } = foldPairs([similar(A, B), similar(B, A)], [{ id: 1, url: A, status: "applied" }, { id: 2, url: B, status: "live" }]);
    expect(keep).toHaveLength(2);
    expect(covered.size).toBe(0);
  });
});

describe("coveredBy", () => {
  it("reads the page a folded record points at", () => {
    expect(coveredBy({ evidence: { covered_by: B } })).toBe(B);
    expect(coveredBy({ evidence: null })).toBeNull();
    expect(coveredBy({ evidence: { covered_by: 3 } })).toBeNull();
  });
});
