import { describe, expect, it } from "vitest";
import type { IndexingView } from "./data";
import { indexingSentence } from "./brief";

const view = (counts: Partial<IndexingView["counts"]>): IndexingView =>
  ({ settings: null, notIndexed: [], toRequest: [], requested: [], others: [], requestedToday: 0, nowIndexed: [], pendingIndexNow: 0, counts: { pages: 50, inspected: 50, indexed: 28, notIndexed: 22, requestIndexing: 22, unchecked: 0, submitted: 0, ...counts } }) as IndexingView;

describe("indexingSentence", () => {
  it("doesn't repeat the count when every page is worth a request", () => {
    expect(indexingSentence(view({}))).toBe("Google hasn't indexed 22 pages from the sitemap. Each is known to Google, so a Request Indexing in Search Console should help.");
  });
  it("says how many are worth a request when some need fixing first", () => {
    expect(indexingSentence(view({ requestIndexing: 5, unchecked: 3 }))).toBe("Google hasn't indexed 22 pages from the sitemap. 5 are worth a Request Indexing in Search Console. 3 pages still to check.");
  });
  it("says so when nothing is missing", () => {
    expect(indexingSentence(view({ indexed: 50, notIndexed: 0, requestIndexing: 0 }))).toBe("Google has indexed every page checked so far, 50 of 50.");
  });
});
