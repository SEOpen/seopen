import { describe, expect, it } from "vitest";
import { brandTerms, coverage, coverSearches, fewLinksIn, gluedOnPage, isBrandSearch, mainSearch, mergeSearches, otherLanguage, ownerOf, paaQuestions, positionWeight, questionFits, readPage, stem, terms, termSet, titleIntents } from "./coverage";

describe("stem", () => {
  it.each([
    ["repairs", "repair"],
    ["repairing", "repair"],
    ["repaired", "repair"],
    ["companies", "company"],
    ["boxes", "box"],
    ["glasses", "glass"],
    ["running", "run"],
    ["called", "call"],
    ["status", "status"],
    ["analysis", "analysis"],
    ["string", "string"],
    ["need", "need"],
    ["gas", "gas"],
  ])("%s → %s", (word, out) => expect(stem(word)).toBe(out));
});

describe("terms", () => {
  it("lowercases, folds accents, drops stop words and stems", () => {
    expect(terms("How much does a Café Repair cost in Salem?")).toEqual(["cafe", "repair", "cost", "salem"]);
  });
});

describe("coverage", () => {
  const page = termSet("Emergency plumbers in Salem", "We repair burst pipes and water heaters, day or night.");

  it("is covered when every topic word is on the page, in any form", () => {
    expect(coverage("salem plumber", page)).toEqual({ label: "covered", found: ["salem", "plumber"], absent: [] });
    expect(coverage("water heater repairs", page).label).toBe("covered");
  });

  it("is partly covered at half the words or more", () => {
    expect(coverage("plumber cost salem", page)).toEqual({ label: "partly", found: ["plumber", "salem"], absent: ["cost"] });
    expect(coverage("plumber cost", page).label).toBe("partly");
  });

  it("is missing under half", () => {
    expect(coverage("tankless heater installation price", page)).toEqual({ label: "missing", found: ["heater"], absent: ["tankless", "installation", "price"] });
  });

  it("reads a run of words as found when the page uses their initials", () => {
    const seo = termSet("Salem SEO that puts you on the map");
    expect(coverage("salem search engine optimization", seo)).toEqual({ label: "covered", found: ["salem", "search", "engine", "optimization"], absent: [] });
    expect(coverage("search tips", seo).label).toBe("missing");
  });

  it("ignores stop words, and reads a search of only stop words word for word", () => {
    expect(coverage("how to fix a burst pipe", page).absent).toEqual(["fix"]);
    expect(coverage("how to", termSet("how to")).label).toBe("missing");
    expect(coverage("", page).label).toBe("missing");
  });
});

describe("positionWeight", () => {
  it("weighs page one fully, page two at 0.7 and the rest at 0.3", () => {
    expect([1, 4, 10, 10.4, 11, 20, 20.5, 45].map(positionWeight)).toEqual([1, 1, 1, 0.7, 0.7, 0.7, 0.3, 0.3]);
  });
});

describe("coverSearches", () => {
  it("puts missing first by impressions × weight, then partly, then covered", () => {
    const page = termSet("Salem plumber");
    const rows = coverSearches(
      [
        { query: "salem plumber", impressions: 900, clicks: 40, position: 3 },
        { query: "drain cleaning", impressions: 300, clicks: 1, position: 8 },
        { query: "sewer line camera", impressions: 400, clicks: 0, position: 15 },
        { query: "plumber prices", impressions: 200, clicks: 2, position: 6 },
        { query: "boiler service", impressions: 1000, clicks: 0, position: 40 },
      ],
      page,
    );
    expect(rows.map((r) => [r.query, r.label, r.score])).toEqual([
      ["boiler service", "missing", 300],
      ["drain cleaning", "missing", 300],
      ["sewer line camera", "missing", 280],
      ["plumber prices", "partly", 200],
      ["salem plumber", "covered", 900],
    ]);
  });
});

describe("mergeSearches", () => {
  it("sums a search across the page's addresses and averages its position by impressions", () => {
    const merged = mergeSearches([
      [{ query: "a", impressions: 100, clicks: 2, position: 4 }],
      [
        { query: "a", impressions: 300, clicks: 1, position: 8 },
        { query: "b", impressions: 0, clicks: 0, position: 0 },
      ],
    ]);
    expect(merged).toEqual([{ query: "a", impressions: 400, clicks: 3, position: 7 }]);
  });
});

describe("brand", () => {
  it("reads the brand from the domain and spots it in a search", () => {
    const brand = brandTerms("www.fernhill-plumbing.co.uk");
    expect([...brand]).toEqual(["fernhillplumbing"]);
    expect(isBrandSearch("fernhill plumbing reviews", brand)).toBe(true);
    expect(isBrandSearch("plumbing reviews", brand)).toBe(false);
    expect(isBrandSearch("alphanote app", brandTerms("alphanote.test"))).toBe(true);
  });

  it("picks the main search past brand searches, or the top one when all are brand", () => {
    const brand = brandTerms("alphanote.test");
    const rows = [
      { query: "alphanote", impressions: 900, clicks: 0, position: 1 },
      { query: "mac notes app", impressions: 500, clicks: 0, position: 9 },
    ];
    expect(mainSearch(rows, brand)?.query).toBe("mac notes app");
    expect(mainSearch(rows.slice(0, 1), brand)?.query).toBe("alphanote");
    expect(mainSearch([], brand)).toBeNull();
  });
});

describe("titleIntents", () => {
  const brand = brandTerms("fernhill.example");
  const rows = [
    { query: "salem plumber", impressions: 900, clicks: 0, position: 5 },
    { query: "drain cleaning", impressions: 600, clicks: 0, position: 9 },
    { query: "plumber near me", impressions: 500, clicks: 0, position: 12 },
    { query: "fernhill", impressions: 2000, clicks: 0, position: 1 },
  ];

  it("finds two top searches with no word in common that the title both chases", () => {
    const pair = titleIntents("Salem Plumber | Drain Cleaning | Fernhill", rows, brand);
    expect(pair?.map((r) => r.query)).toEqual(["salem plumber", "drain cleaning"]);
  });

  it("is null for a title about one thing, or without a title", () => {
    expect(titleIntents("Salem Plumber | Fernhill", rows, brand)).toBeNull();
    expect(titleIntents(null, rows, brand)).toBeNull();
  });
});

describe("fewLinksIn", () => {
  it("is few under 3 links and under the site's median", () => {
    expect(fewLinksIn(1, 6)).toBe(true);
    expect(fewLinksIn(2, null)).toBe(true);
    expect(fewLinksIn(2, 2)).toBe(false);
    expect(fewLinksIn(3, 10)).toBe(false);
    expect(fewLinksIn(null, 10)).toBe(false);
  });
});

describe("paaQuestions", () => {
  it("reads People also ask in page order, without repeats", () => {
    expect(
      paaQuestions([
        { type: "organic" },
        { type: "people_also_ask", items: [{ type: "people_also_ask_element", title: "How much does a plumber cost?" }, { title: " Is a plumber worth it? " }, { title: "How much does a plumber cost?" }, { title: null }] },
      ]),
    ).toEqual(["How much does a plumber cost?", "Is a plumber worth it?"]);
    expect(paaQuestions(null)).toEqual([]);
  });
});

describe("ownerOf", () => {
  const own = { query: "web design salem", impressions: 40, clicks: 0, position: 38 };
  it("names the page that gets more impressions for the search at a better position", () => {
    const salem = { page: "https://betaweb.example/location/web-design-salem/", impressions: 900, position: 9.2 };
    expect(ownerOf(own, [{ page: "https://betaweb.example/blog/x/", impressions: 30, position: 50 }, salem])).toEqual(salem);
  });
  it("leaves the search with this page when it leads, or when the other page ranks lower", () => {
    expect(ownerOf(own, [{ page: "https://betaweb.example/a/", impressions: 20, position: 5 }])).toBeNull();
    expect(ownerOf(own, [{ page: "https://betaweb.example/b/", impressions: 400, position: 45 }])).toBeNull();
    expect(ownerOf(own, [])).toBeNull();
  });
});

// From getseopen.com's own pages in the 2026-11-17 MCP QA (B6 to B8).
const backlinksPage = termSet("Backlink checker and explorer: who links to you", "A backlink checker and explorer for your site and your competitors", "Open site explorer style lists. Check the links and backlinks that point to you.");

describe("gluedOnPage", () => {
  it("reads a run-together word as found when the page has its parts", () => {
    expect(gluedOnPage("opensiteexplorer", backlinksPage)).toBe(true);
    expect(gluedOnPage("checkbacklinks", backlinksPage)).toBe(true);
    expect(coverage("checkbacklinks", backlinksPage).label).toBe("covered");
  });
  it("leaves a word whose parts aren't all on the page, or that is too short to split", () => {
    expect(gluedOnPage("scanbacklinks", backlinksPage)).toBe(false);
    expect(gluedOnPage("links", backlinksPage)).toBe(false);
  });
});

describe("otherLanguage", () => {
  it("spots common words of other languages on an English project", () => {
    for (const q of ["comprobar backlinks", "backlinks checken", "backlinks testen", "backlinks prüfen", "backlinks überprüfen", "buscar backlinks"]) expect(otherLanguage(q, "en")).toBe(true);
    expect(otherLanguage("check incoming links", "en")).toBe(false);
    expect(otherLanguage("las vegas plumber", "en")).toBe(false);
  });
  it("leaves every search in when the project isn't in English", () => {
    expect(otherLanguage("backlinks checken", "de")).toBe(false);
  });
});

describe("mainSearch, against the title and H1", () => {
  const brand = brandTerms("getseopen.com");
  const heading = termSet("Daily rank tracker for Google, from $29 a month · SEOpen", "A daily Google rank tracker that checks every keyword each morning");
  const rows = [
    { query: "see rank", impressions: 46, clicks: 0, position: 85 },
    { query: "search rank tracker", impressions: 37, clicks: 0, position: 76.3 },
    { query: "weekly rank tracking", impressions: 21, clicks: 0, position: 90.6 },
    { query: "daily rank tracker", impressions: 9, clicks: 0, position: 73.2 },
  ];
  it("prefers the top search the title or H1 is mostly written for (QA B7)", () => {
    expect(mainSearch(rows, brand, heading)?.query).toBe("search rank tracker");
  });
  it("falls back to the top non-brand search when none fits, and ignores one-word fits", () => {
    expect(mainSearch(rows, brand, termSet("Pricing"))?.query).toBe("see rank");
    expect(mainSearch([{ query: "rank", impressions: 50, clicks: 0, position: 9 }, ...rows], brand, heading)?.query).toBe("search rank tracker");
  });
});

describe("questionFits", () => {
  it("keeps questions the page is close to answering, and drops ones about another topic (QA B6)", () => {
    expect(questionFits("How do I see my backlinks?", "backlink explorer", termSet("See the backlinks to your site"))).toBe(true);
    expect(questionFits("Is buying backlinks illegal?", "backlink explorer", backlinksPage)).toBe(false);
    expect(questionFits("What is a backlink generator?", "backlink explorer", backlinksPage)).toBe(false);
    expect(questionFits("Are backlinks still relevant in 2026?", "backlink explorer", backlinksPage)).toBe(false);
    expect(questionFits("What is a backlink explorer?", "backlink explorer", backlinksPage)).toBe(true);
  });
});

describe("readPage", () => {
  it("leaves out headings in the header, nav, footer and aside, or outside <main> (QA B8)", () => {
    const outside = readPage(`<html><head><title>T</title></head><body><header><h1>Rank tracker</h1><nav><h2>Menu</h2></nav></header><h2>What you see</h2><aside><h3>Related</h3></aside><footer><h2>SEO</h2><h2>AI search</h2></footer></body></html>`);
    expect(outside.headings).toEqual([
      { level: 1, text: "Rank tracker" },
      { level: 2, text: "What you see" },
    ]);
    const inMain = readPage(`<body><header><h2>Banner</h2></header><main><article><header><h1>Rank tracker</h1></header><h2>How it runs</h2></article></main><footer><h2>SEOpen</h2></footer></body>`);
    expect(inMain.headings.map((h) => h.text)).toEqual(["Rank tracker", "How it runs"]);
    // A closing call to action inside <main>, such as getseopen.com's beta block, isn't the outline.
    const cta = readPage(`<body><main><h1>Rank tracker</h1><h2>How it runs</h2><aside aria-labelledby="beta"><h2 id="beta">SEOpen is in private beta</h2></aside></main></body>`);
    expect(cta.headings.map((h) => h.text)).toEqual(["Rank tracker", "How it runs"]);
  });
});
