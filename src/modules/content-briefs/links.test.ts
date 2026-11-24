import { describe, expect, it } from "vitest";
import { linkSuggestions, onTopic, topicTerms, type AuditPage, type GscPair } from "./links";

const gscSource = { label: "Search Console, 2026-10-01 to 2026-10-28", at: null };
const auditSource = { label: "Latest site audit crawl", at: "2026-11-01T10:00:00.000Z" };
const pair = (query: string, page: string, impressions: number, position = 9): GscPair => ({ query, page, clicks: 1, impressions, position });
const page = (url: string, title: string, internalLinksIn = 0, extra: Partial<AuditPage> = {}): AuditPage => ({ url, title, h1: null, statusCode: 200, indexable: true, internalLinksIn, ...extra });

describe("topicTerms and onTopic", () => {
  it("keeps the words that carry the meaning", () => {
    expect(topicTerms("how to prune climbing roses")).toEqual(["prune", "climbing", "roses"]);
  });

  it("needs every term of a short topic and half of a long one", () => {
    expect(onTopic("prune roses in march", ["prune", "roses"])).toBe(true);
    expect(onTopic("roses", ["prune", "roses"])).toBe(false);
    expect(onTopic("climbing roses", ["prune", "climbing", "roses"])).toBe(true);
    expect(onTopic("anything", [])).toBe(false);
  });
});

describe("linkSuggestions", () => {
  it("links from pages that show for the topic in Search Console, most impressions first", () => {
    const out = linkSuggestions({
      keyword: "prune roses",
      gsc: { pairs: [pair("when to prune roses", "https://f.example/a", 50), pair("prune roses", "https://f.example/b", 300, 12), pair("roses for sale", "https://f.example/c", 900)], source: gscSource },
      audit: null,
    });
    expect(out.from.map((l) => l.url)).toEqual(["https://f.example/b", "https://f.example/a"]);
    expect(out.from[0].why).toBe("Shows for “prune roses” at position 12; 300 impressions on the topic.");
    expect(out.from[0].source).toBe(gscSource);
    expect(out.note).toContain("https://f.example/b already shows for “prune roses” at position 12");
  });

  it("adds on-topic audit pages to link from, and related ones to link to, live and indexable only", () => {
    const out = linkSuggestions({
      keyword: "prune roses",
      gsc: null,
      audit: {
        pages: [
          page("https://f.example/pruning-roses", "Prune roses the easy way", 3),
          page("https://f.example/roses", "All our roses", 40),
          page("https://f.example/old", "Roses", 90, { statusCode: 404 }),
          page("https://f.example/hidden", "Roses", 90, { indexable: false }),
          page("https://f.example/tools", "Garden tools", 99),
        ],
        source: auditSource,
      },
    });
    expect(out.from.map((l) => l.url)).toEqual(["https://f.example/pruning-roses"]);
    expect(out.to.map((l) => l.url)).toEqual(["https://f.example/roses"]);
    expect(out.to[0].why).toBe("A related page: “All our roses”, with 40 internal links to it.");
    expect(out.note).toBeNull();
  });

  it("leaves out searches that share only modifiers such as \"free\" with the topic, and says 1 impression (QA A8)", () => {
    const pair = (query: string, page: string, impressions: number) => ({ query, page, clicks: 0, impressions, position: 40 });
    const out = linkSuggestions({
      keyword: "free backlink checker",
      gsc: { pairs: [pair("seeps free rank checker", "https://getseopen.com/features/rank-tracker", 1), pair("backlink checker small seo", "https://getseopen.com/features/backlinks", 1)], source: gscSource },
      audit: null,
    });
    expect(out.from.map((l) => l.url)).toEqual(["https://getseopen.com/features/backlinks"]);
    expect(out.from[0].why).toBe("Shows for “backlink checker small seo” at position 40; 1 impression on the topic.");
    expect(topicTerms("free backlink checker")).toEqual(["backlink", "checker"]);
    expect(topicTerms("free tools")).toEqual(["free", "tools"]);
  });

  it("says why there are none", () => {
    expect(linkSuggestions({ keyword: "prune roses", gsc: null, audit: null }).note).toContain("no Search Console data or finished site audit");
    expect(linkSuggestions({ keyword: "prune roses", gsc: { pairs: [], source: gscSource }, audit: null }).note).toContain("Nothing in Search Console");
  });
});
