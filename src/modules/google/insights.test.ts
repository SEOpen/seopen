import { describe, expect, it } from "vitest";
import { searchPages, shownNotRanking, sitelinkCopies, sitelinkPages, splitQueries, splitRecords, STRIKING_FORMULA, strikingFormula, strikingPages } from "./insights";
import { pageKey } from "./matching";

const pair = (query: string, page: string, impressions: number, position: number, clicks = 0) => ({ query, page, impressions, position, clicks });

describe("splitQueries", () => {
  it("finds a search Google showed on two pages, as on getseopen.com", () => {
    const splits = splitQueries([pair("ai overview checker", "https://x.com/tools/ai-overview", 70, 12), pair("ai overview checker", "https://x.com/features/ai", 10, 40)], 5_000);
    expect(splits).toEqual([
      {
        query: "ai overview checker",
        impressions: 80,
        pages: [
          { page: "https://x.com/tools/ai-overview", impressions: 70, clicks: 0, position: 12 },
          { page: "https://x.com/features/ai", impressions: 10, clicks: 0, position: 40 },
        ],
      },
    ]);
  });

  it("leaves out a search too small to say much, for the site's size", () => {
    expect(splitQueries([pair("q", "https://x.com/a", 30, 12), pair("q", "https://x.com/b", 15, 20)], 5_000)).toEqual([]);
    // 0.1% of a million impressions is 1,000: a search of 80 is the long tail there.
    expect(splitQueries([pair("q", "https://x.com/a", 70, 12), pair("q", "https://x.com/b", 10, 40)], 1_000_000)).toEqual([]);
  });

  it("doesn't count a page with a sliver of the search", () => {
    // 12 of 300 is 4%: Google tried the page, it isn't competing.
    expect(splitQueries([pair("q", "https://x.com/a", 288, 12), pair("q", "https://x.com/b", 12, 40)], 5_000)).toEqual([]);
    expect(splitQueries([pair("q", "https://x.com/a", 60, 12), pair("q", "https://x.com/b", 9, 40)], 5_000)).toEqual([]);
  });

  it("treats the addresses of one page as one page", () => {
    const pairs = [pair("q", "https://x.com/a", 50, 12), pair("q", "http://www.x.com/a/", 20, 14), pair("q", "https://x.com/a#faq", 20, 9)];
    expect(splitQueries(pairs, 5_000, pageKey)).toEqual([]);
    expect(splitQueries(pairs, 5_000)).toHaveLength(1);
  });

  it("leaves a double listing at the top alone, like a brand search's sitelinks", () => {
    expect(splitQueries([pair("brand", "https://x.com/", 400, 1), pair("brand", "https://x.com/pricing", 200, 1.4)], 5_000)).toEqual([]);
    expect(splitQueries([pair("brand", "https://x.com/", 400, 1), pair("brand", "https://x.com/pricing", 200, 4)], 5_000)).toHaveLength(1);
  });

  it("puts the searches with most impressions on the weaker pages first", () => {
    const splits = splitQueries([pair("small", "https://x.com/a", 500, 5), pair("small", "https://x.com/b", 60, 30), pair("big", "https://x.com/c", 100, 8), pair("big", "https://x.com/d", 90, 9)], 5_000);
    expect(splits.map((s) => s.query)).toEqual(["big", "small"]);
  });
});

describe("splitRecords", () => {
  it("records each split on its weakest page, and one page's splits together", () => {
    const splits = splitQueries(
      [pair("one", "https://x.com/a", 70, 12), pair("one", "https://x.com/b", 30, 40), pair("two", "https://x.com/c", 200, 8), pair("two", "https://x.com/b", 50, 30), pair("three", "https://x.com/c", 80, 9), pair("three", "https://x.com/d", 40, 15), pair("three", "https://x.com/e", 20, 22)],
      5_000,
    );
    const records = splitRecords(splits);
    expect(records.map((r) => [r.page, r.queries.map((q) => q.query), r.impressions])).toEqual([
      ["https://x.com/b", ["two", "one"], 80],
      ["https://x.com/e", ["three"], 20],
    ]);
  });
});

describe("shownNotRanking", () => {
  const row = (key: string, impressions: number, position: number) => ({ key, impressions, position, clicks: 1, ctr: 1 / impressions });

  it("finds a page shown often past page three, as /features/backlinks was", () => {
    expect(shownNotRanking([row("/features/backlinks", 1_954, 86.5), row("/close", 3_000, 12), row("/few", 150, 60)], 20_000).map((r) => r.key)).toEqual(["/features/backlinks"]);
  });

  it("needs more on a bigger site, and nothing at position 30 itself", () => {
    expect(shownNotRanking([row("/a", 1_954, 86.5)], 500_000)).toEqual([]);
    expect(shownNotRanking([row("/a", 1_954, 30)], 20_000)).toEqual([]);
    expect(shownNotRanking([row("/a", 400, 31), row("/b", 900, 45)], 20_000).map((r) => r.key)).toEqual(["/b", "/a"]);
  });
});

describe("searchPages", () => {
  it("ties each search to the page Google showed most for it, folding one page's addresses", () => {
    const pages = searchPages(
      [pair("backlink checker", "https://x.com/features/backlinks", 900, 88), pair("backlink checker", "https://www.x.com/features/backlinks/", 100, 80), pair("backlink checker", "https://x.com/blog/links", 300, 60), pair("link checker", "https://x.com/blog/links", 60, 40)],
      5_000,
      pageKey,
    );
    expect(pages).toEqual([
      { query: "backlink checker", page: "https://x.com/features/backlinks", clicks: 0, impressions: 1_000, position: 87.2 },
      { query: "link checker", page: "https://x.com/blog/links", clicks: 0, impressions: 60, position: 40 },
    ]);
  });

  it("leaves out a search the page holds too little of, for the site's size", () => {
    expect(searchPages([pair("q", "https://x.com/a", 40, 12)], 5_000)).toEqual([]);
    expect(searchPages([pair("q", "https://x.com/a", 400, 12)], 1_000_000)).toEqual([]);
  });
});

describe("sitelinks", () => {
  const H = "https://betaweb.example";
  const pair = (query: string, path: string, impressions: number, position: number, clicks = 0) => ({ query, page: `${H}${path}`, impressions, position, clicks });
  // As one client site's Search Console showed it: the links under the home page result repeat its numbers.
  const pairs = [
    pair("website design salem nh", "/", 120, 9.7, 2),
    pair("website design salem nh", "/pricing/", 120, 9.7),
    pair("website design salem nh", "/work/", 118, 9.6),
    pair("website design salem nh", "/contact/", 119, 9.7),
    pair("website design cost salem nh", "/pricing/", 18, 11.5),
    // A real split: two pages, different numbers.
    pair("seo canobie lake", "/location/seo-canobie-lake/", 60, 2.2),
    pair("seo canobie lake", "/blog/canobie-lake-seo/", 25, 14.1),
  ];

  it("finds the rows that repeat another page's result, leaving the result with the home page", () => {
    expect([...sitelinkCopies(pairs)].map((k) => k.split("\u0000")[1].replace(H, "")).sort()).toEqual(["/contact/", "/pricing/", "/work/"]);
  });

  it("calls a page a sitelink page only when most of its impressions are such rows", () => {
    // /pricing/ has 120 copied of 138, /work/ and /contact/ are all copies.
    expect([...sitelinkPages(pairs)].map((p) => p.replace(H, "")).sort()).toEqual(["/contact/", "/pricing/", "/work/"]);
    expect(sitelinkPages([...pairs, pair("salem web design pricing", "/pricing/", 200, 6)]).has(`${H}/pricing/`)).toBe(false);
  });

  it("leaves sitelink rows and rank checkers' searches out of striking distance", () => {
    const pages = strikingPages([...pairs, pair("website page optimization, derry nh", "/services/", 321, 15.4)], undefined, 10);
    expect(pages.map((p) => p.page.replace(H, "")).sort()).toEqual(["/", "/blog/canobie-lake-seo/", "/pricing/"]);
    expect(pages.find((p) => p.page.endsWith("/pricing/"))!.list.map((q) => q.query)).toEqual(["website design cost salem nh"]);
  });

  it("ignores rows too small to tell apart from chance", () => {
    expect(sitelinkCopies([pair("a b", "/", 3, 5), pair("a b", "/x/", 3, 5)]).size).toBe(0);
  });
});

describe("strikingFormula", () => {
  it("says what the ends of the range count", () => {
    expect(STRIKING_FORMULA).toBe("Score: for each search in the range, impressions × (21 − position) ÷ 17, added up for the page. A search at position 4 counts in full, one at 20 counts a seventeenth.");
    expect(strikingFormula({ min: 1, max: 10 })).toContain("A search at position 1 counts 20/17, more than in full, one at 10 counts 11/17.");
    expect(strikingFormula({ min: 7, max: 7 })).toContain("A search at position 7 counts 14/17.");
  });
});
