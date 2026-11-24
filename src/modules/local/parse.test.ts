import { describe, expect, it } from "vitest";
import { candidateKey, isSameListing, makeTag, normalizeKeyword, parseCandidates, parseKeywords, parseTag, pointOutcome } from "./parse";
import type { MapsItem } from "./types";

const OURS = { cid: "123456789", placeId: "ChIJours" };

function item(rank: number, over: Partial<MapsItem> = {}): MapsItem {
  return {
    type: "maps_search",
    rank_group: rank,
    rank_absolute: rank,
    title: `Business ${rank}`,
    cid: `c${rank}`,
    place_id: `p${rank}`,
    category: "Website designer",
    rating: { value: 4.8, votes_count: 20 + rank },
    latitude: 42.79,
    longitude: -71.2,
    ...over,
  };
}

const ok = (items: MapsItem[] | null) => ({ status_code: 20000, status_message: "Ok.", result: [{ items }] });

describe("keywords", () => {
  it("trims, collapses spaces and lowercases", () => {
    expect(normalizeKeyword("  Web   Design\tSalem ")).toBe("web design salem");
    expect(normalizeKeyword("   ")).toBe("");
  });

  it("splits lines and commas, drops empties and dedupes in order", () => {
    expect(parseKeywords("Web design salem\nwebsite designer, WEB DESIGN SALEM\n\n ,website  designer;seo")).toEqual([
      "web design salem",
      "website designer",
      "seo",
    ]);
  });

  it("caps very long keywords", () => {
    expect(normalizeKeyword("a".repeat(500)).length).toBe(120);
  });
});

describe("tags", () => {
  it("round-trips and rejects anything else", () => {
    expect(parseTag(makeTag(12, 3456))).toEqual({ checkId: 12, pointId: 3456 });
    expect(parseTag("12:3456")).toBeNull();
    expect(parseTag(null)).toBeNull();
  });
});

describe("matching", () => {
  it("matches on cid or place_id, never on the name", () => {
    expect(isSameListing({ cid: "123456789", place_id: null }, OURS)).toBe(true);
    expect(isSameListing({ cid: null, place_id: "ChIJours" }, OURS)).toBe(true);
    expect(isSameListing({ cid: "999", place_id: "ChIJother" }, OURS)).toBe(false);
    expect(isSameListing({ cid: null, place_id: null }, { cid: null, placeId: null })).toBe(false);
  });
});

describe("pointOutcome: Failed vs Not found", () => {
  it("finds our rank by id even when another listing has our name", () => {
    const items = [item(1, { title: "Beta Web Design" }), item(2), item(3, { cid: "123456789", title: "LWD" })];
    const out = pointOutcome(ok(items), OURS);
    expect(out).toMatchObject({ status: "done", rank: 3 });
    if (out.status === "done") expect(out.items.map((i) => i.r)).toEqual([1, 2, 3]);
  });

  it("is Not found (done, no rank) when Maps lists others but not us", () => {
    expect(pointOutcome(ok([item(1), item(2)]), OURS)).toMatchObject({ status: "done", rank: null });
  });

  it("is Failed when Maps answers with no listings at all", () => {
    expect(pointOutcome(ok([]), OURS).status).toBe("failed");
    expect(pointOutcome(ok(null), OURS).status).toBe("failed");
    expect(pointOutcome({ status_code: 20000, status_message: "Ok.", result: null }, OURS).status).toBe("failed");
    // Only ads, no organic listings, is no answer either.
    expect(pointOutcome(ok([{ type: "maps_paid_item", title: "Ad", cid: "123456789" }]), OURS).status).toBe("failed");
  });

  it("is Failed on an error, including 'no search results'", () => {
    expect(pointOutcome({ status_code: 40102, status_message: "No Search Results." }, OURS)).toEqual({ status: "failed", error: "40102 No Search Results." });
    expect(pointOutcome({ status_code: 50000, status_message: "Internal Error." }, OURS).status).toBe("failed");
    expect(pointOutcome(undefined, OURS).status).toBe("failed");
  });

  it("waits while the task is queued", () => {
    expect(pointOutcome({ status_code: 40602, status_message: "Task In Queue." }, OURS)).toEqual({ status: "wait" });
  });

  it("ignores ads and keeps the top 20 by rank", () => {
    const items = [item(2), { type: "maps_paid_item", title: "Ad", rank_group: 1 }, item(1), ...Array.from({ length: 25 }, (_, i) => item(i + 3))];
    const out = pointOutcome(ok(items), { cid: "c22", placeId: null });
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.items).toHaveLength(20);
    expect(out.items[0]).toMatchObject({ r: 1, t: "Business 1", cat: "Website designer", rating: 4.8, votes: 21 });
    expect(out.rank).toBeNull();
    expect(pointOutcome(ok(items), { cid: "c20", placeId: null })).toMatchObject({ rank: 20 });
  });
});

describe("parseCandidates", () => {
  it("keeps listings with ids and coordinates, deduped", () => {
    const cands = parseCandidates({
      items: [
        item(1, { title: "Beta Web Design", address: "1 Main St", domain: "betaweb.example" }),
        item(2, { cid: null, place_id: null }),
        item(3, { latitude: null }),
        item(4, { cid: "c1" }),
        item(5, { cid: null }),
      ],
    });
    expect(cands.map((c) => c.title)).toEqual(["Beta Web Design", "Business 5"]);
    expect(cands[0]).toMatchObject({ cid: "c1", placeId: "p1", lat: 42.79, lng: -71.2, domain: "betaweb.example", address: "1 Main St" });
    expect(candidateKey(cands[0])).toBe("cid:c1");
    expect(candidateKey(cands[1])).toBe("pid:p5");
  });

  it("is empty for an empty search", () => {
    expect(parseCandidates(null)).toEqual([]);
    expect(parseCandidates({ items: null })).toEqual([]);
  });
});
