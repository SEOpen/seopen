import { describe, expect, it } from "vitest";
import { ISSUES } from "@/modules/audit/taxonomy";
import { beforeLine, canAgentFix, coversLine, fixDef, GSC_CODES, isSiteWide, issueLine, likelyFiles, pathOf, plainIssue, progressLine, proposedChange, proposedForPeople, shortCommit, TRACKED_AUDIT_CODES, whyItMatters } from "./catalog";

describe("the fix catalogue", () => {
  it("only tracks codes the audit really has", () => {
    for (const code of TRACKED_AUDIT_CODES) expect(ISSUES[code], code).toBeDefined();
  });

  it("says what to do, why and what to expect for every tracked finding", () => {
    for (const code of [...TRACKED_AUDIT_CODES, ...GSC_CODES]) {
      expect(proposedChange(code), code).not.toBe("");
      expect(whyItMatters(code), code).not.toBe("");
      expect(fixDef(code).effect, code).not.toBe("");
    }
  });

  it("keeps the agent's instructions for the agent, and writes the page's line to the customer", () => {
    expect(proposedChange("thin-content")).toContain("ask the user what's true");
    expect(proposedForPeople("thin-content")).toBe("Say more that's useful on this page, or merge it into one that does. Add what's true for your business rather than padding it.");
    for (const code of [...TRACKED_AUDIT_CODES, ...GSC_CODES]) {
      expect(proposedForPeople(code), code).not.toBe("");
      expect(proposedForPeople(code), code).not.toMatch(/the user|the repo|`/i);
    }
  });

  it("softens the little-text advice on a page that's short on purpose, and names the kind of page", () => {
    expect(proposedForPeople("thin-content", "https://x.com/contact/")).toBe("A contact page is often short on purpose. If this one says what it needs to, dismiss this fix rather than pad it.");
    expect(proposedForPeople("thin-content", "https://x.com/accessibility-statement/")).toContain("An accessibility statement is often short on purpose.");
    expect(proposedForPeople("thin-content", "https://x.com/privacy-policy")).toContain("A legal page is often short on purpose.");
    expect(proposedChange("thin-content", "https://x.com/contact-us/")).toContain("This looks like a contact page, which is often short on purpose: ask the user whether to dismiss this fix");
    // A page meant to rank keeps the usual advice.
    expect(proposedForPeople("thin-content", "https://x.com/services/roofing/")).toBe(proposedForPeople("thin-content"));
    expect(proposedForPeople("missing-h1", "https://x.com/contact/")).toBe(proposedForPeople("missing-h1"));
  });

  it("promises no numbers it hasn't measured", () => {
    for (const code of [...TRACKED_AUDIT_CODES, ...GSC_CODES]) expect(fixDef(code).effect, code).not.toMatch(/\d+\s*%/);
  });

  it("leaves hosting problems to a person", () => {
    expect(canAgentFix("title-too-long")).toBe(true);
    expect(canAgentFix("thin-content")).toBe(true);
    expect(canAgentFix("invalid-certificate")).toBe(false);
  });

  it("knows which findings are about the whole site", () => {
    expect(isSiteWide("no-sitemap")).toBe(true);
    expect(isSiteWide("title-too-long")).toBe(false);
    expect(isSiteWide("gsc-low-ctr")).toBe(false);
  });
});

describe("beforeLine", () => {
  it("labels the finding as the before once there's an after to set beside it", () => {
    const f = { code: "title-too-long", url: "https://x.com/a", detail: "72 characters", evidence: null, liveCheck: { saw: "The title is 57 characters.", checkedAt: "2026-11-06T15:00:00Z" } };
    expect(beforeLine({ ...f, status: "live" })).toBe("Before: /a. Title length: 72 characters");
    expect(beforeLine({ ...f, status: "open", liveCheck: null })).toBe("/a. Title length: 72 characters");
    expect(beforeLine({ ...f, status: "applied", liveCheck: null })).toBe("/a. Title length: 72 characters");
  });
});

describe("plainIssue", () => {
  const fix = (code: string, evidence: Record<string, unknown> | null = null, detail: string | null = null) => ({ code, url: "https://x.com/pricing", detail, evidence });

  it("gives low click-through its own numbers", () => {
    const text = plainIssue(fix("gsc-low-ctr", { impressions: 4210, position: 4, ctr: 0.012, expected_ctr: 0.07 }));
    expect(text).toBe("Google showed /pricing 4,210 times in the last 28 days at about position 4, and 1.2% clicked. A result at that position usually gets about 7%.");
  });

  it("names the search a page is close on", () => {
    expect(plainIssue(fix("gsc-striking-distance", { queries: [{ query: "seo tool", position: 11.2 }, { query: "seo app", position: 14 }] }))).toBe("/pricing sits at about position 11.2 for “seo tool” and 1 other search close to page one.");
  });

  it("says how often Google showed it, and counts every search in range", () => {
    const queries = [{ query: "seo tool", position: 11.2, impressions: 420 }, { query: "seo app", position: 14, impressions: 90 }];
    expect(plainIssue(fix("gsc-striking-distance", { queries, searches_in_range: 8 }))).toBe("/pricing sits at about position 11.2 for “seo tool”, seen 420 times in the last 28 days, and 7 other searches close to page one.");
    expect(plainIssue(fix("gsc-striking-distance", { queries: queries.slice(0, 1), searches_in_range: 1 }))).toBe("/pricing sits at about position 11.2 for “seo tool”, seen 420 times in the last 28 days.");
  });

  it("gives a page losing clicks its position then and now", () => {
    expect(plainIssue(fix("gsc-losing-clicks", { clicks: 5, previous_clicks: 50, position: 7, previous_position: 5 }))).toBe("/pricing got 5 clicks in the last 28 days, down from 50 in the 28 before. Its average position went from 5 to 7.");
    expect(plainIssue(fix("gsc-losing-clicks", { clicks: 5, previous_clicks: 50, position: 5, previous_position: 5 }))).toBe("/pricing got 5 clicks in the last 28 days, down from 50 in the 28 before. Its average position held at 5.");
    expect(plainIssue(fix("gsc-losing-clicks", { clicks: 5, previous_clicks: 50, position: 0, previous_position: 5 }))).toBe("/pricing got 5 clicks in the last 28 days, down from 50 in the 28 before.");
  });

  it("names a search shown on several pages, with each page's numbers", () => {
    const pages = [
      { page: "https://x.com/tools/ai-overview", impressions: 70, position: 12, clicks: 0 },
      { page: "https://x.com/pricing", impressions: 10, position: 40, clicks: 0 },
    ];
    expect(plainIssue(fix("gsc-split-query", { queries: [{ query: "ai overview checker", impressions: 80, pages }], searches_split: 1 }))).toBe(
      "Google showed “ai overview checker” on 2 of your pages in the last 28 days: /tools/ai-overview (70 impressions, about position 12) and /pricing (10 impressions, about position 40).",
    );
    expect(plainIssue(fix("gsc-split-query", { queries: [{ query: "ai overview checker", impressions: 80, pages }], searches_split: 3 }))).toContain(" /pricing shares 2 other searches the same way.");
    expect(plainIssue(fix("gsc-split-query", {}))).toBe("/pricing shows for a search another of your pages shows for too.");
  });

  it("says how far down a page Google shows often sits, and the search behind it", () => {
    expect(plainIssue(fix("gsc-shown-not-ranking", { impressions: 1954, clicks: 1, position: 86.5, queries: [{ query: "backlink checker", impressions: 400, position: 88 }] }))).toBe(
      "Google showed /pricing 1,954 times in the last 28 days at about position 86.5, past page three, and it got 1 click. Its top search is “backlink checker”, at about position 88.",
    );
    expect(plainIssue(fix("gsc-shown-not-ranking", { impressions: 300, clicks: 0, position: 45, queries: [] }))).toBe("Google showed /pricing 300 times in the last 28 days at about position 45, past page three, and it got no clicks.");
  });

  it("says what kind of page ranks for a search and what kind the page is", () => {
    const e = { query: "link checker", impressions: 300, position: 71, dominant_type: "tool", agree: 7, of: 10, page_type: "guide", searches_mismatched: 1, other_searches: [] };
    expect(plainIssue(fix("gsc-wrong-page-type", e))).toBe("Google showed /pricing 300 times for “link checker” in the last 28 days, at about position 71. 7 of the top 10 for it are tools, and /pricing reads as a guide or article.");
    expect(plainIssue(fix("gsc-wrong-page-type", { ...e, searches_mismatched: 3 }))).toContain(" The same goes for 2 other searches.");
    expect(plainIssue(fix("gsc-wrong-page-type", {}))).toBe("Google ranks a different kind of page from /pricing for a search it shows /pricing for.");
    expect(proposedChange("gsc-wrong-page-type")).toMatch(/^Leave the title alone/);
    expect(proposedChange("gsc-wrong-page-type")).toContain("a different search for this page to aim at");
    expect(fixDef("gsc-wrong-page-type").kind).toBe("content");
  });

  it("keeps a low position away from the title", () => {
    expect(proposedChange("gsc-shown-not-ranking")).toMatch(/^Leave the title alone/);
    expect(proposedChange("gsc-shown-not-ranking")).toContain("what kind of page ranks on page one");
    expect(fixDef("gsc-shown-not-ranking").kind).toBe("content");
    expect(fixDef("gsc-split-query").kind).toBe("content");
  });

  it("uses the audit's title and label for a crawl finding", () => {
    expect(plainIssue(fix("title-too-long", null, "74 characters"))).toBe("/pricing: Title is too long (title length: 74 characters).");
  });

  it("says what the similarity score means, as the Fixes page does", () => {
    expect(plainIssue(fix("duplicate-content", null, "https://x.com/plans/ (8 of 10)"))).toBe("/pricing: Pages have similar content (closest match: https://x.com/plans/, 8 of 10 alike, 10 is identical).");
    expect(plainIssue(fix("duplicate-content", null, "https://x.com/plans/ (7.5 of 10, +2 more)"))).toBe("/pricing: Pages have similar content (closest match: https://x.com/plans/, 7.5 of 10 alike, 10 is identical, and 2 more similar pages).");
  });
});

describe("issueLine", () => {
  const fix = (code: string, url: string, detail: string | null = null, evidence: Record<string, unknown> | null = null) => ({ code, url, detail, evidence });

  it("doesn't repeat the title it sits under", () => {
    expect(issueLine(fix("title-too-long", "https://x.com/a", "74 characters"))).toBe("/a. Title length: 74 characters");
    expect(issueLine(fix("missing-h1", "https://x.com/"))).toBe("The home page");
  });

  it("names a similar page's closest match by its path, and says what the score means", () => {
    expect(issueLine(fix("duplicate-content", "https://x.com/services/seo/", "https://x.com/services/local-seo/ (8 of 10)"))).toBe("/services/seo/. Closest match: /services/local-seo/, 8 of 10 alike (10 is identical)");
    expect(issueLine(fix("duplicate-content", "https://x.com/a", "https://x.com/b (7 of 10, +2 more)"))).toBe("/a. Closest match: /b, 7 of 10 alike (10 is identical), and 2 more similar pages");
  });

  it("keeps a Search Console finding's numbers", () => {
    expect(issueLine(fix("gsc-losing-clicks", "https://x.com/a", null, { clicks: 5, previous_clicks: 50 }))).toBe("/a got 5 clicks in the last 28 days, down from 50 in the 28 before.");
  });
});

describe("progressLine", () => {
  const fix = (status: string, over: Partial<{ evidence: Record<string, unknown> | null; dismissedReason: string | null; liveCheck: { saw: string; checkedAt: string } | null }> = {}) => ({ status, evidence: null, dismissedReason: null, liveCheck: null, ...over });

  it("dates what the live page showed, as the after beside the finding's before", () => {
    const check = { saw: "The title is 57 characters.", checkedAt: "2026-11-06T15:00:00Z" };
    expect(progressLine(fix("live", { liveCheck: check }), "America/New_York")).toBe("After, checked Nov 6: The title is 57 characters.");
    expect(progressLine(fix("applied", { liveCheck: check }), "America/New_York")).toBe("After, checked Nov 6: The title is 57 characters.");
  });

  it("says why a record closed", () => {
    expect(progressLine(fix("resolved"), "UTC")).toBe("A later crawl or sync no longer finds this.");
    expect(progressLine(fix("dismissed", { dismissedReason: "Decorative" }), "UTC")).toBe("Decorative");
    expect(progressLine(fix("open"), "UTC")).toBeNull();
  });
});

describe("coversLine", () => {
  it("names the similar pages a record's fix also covers, on the record itself", () => {
    expect(coversLine(["https://x.com/services/local-seo/"])).toBe("Also covers /services/local-seo/, its similar pair, so one fix settles both.");
    expect(coversLine(["https://x.com/a/", "https://x.com/b/"])).toBe("Also covers /a/ and /b/, pages much like it, so one fix settles them all.");
    expect(coversLine([])).toBeNull();
  });
});

describe("likelyFiles", () => {
  it("maps a page per framework", () => {
    const files = likelyFiles("title-too-long", "https://x.com/pricing/");
    expect(files.nextjs[0]).toBe("app/pricing/page.tsx");
    expect(files.astro[0]).toBe("src/pages/pricing.astro");
    expect(files.sveltekit[0]).toBe("src/routes/pricing/+page.svelte");
    expect(files.html).toEqual(["pricing.html", "pricing/index.html"]);
  });

  it("maps the home page and the site's own files", () => {
    expect(likelyFiles("missing-title", "https://x.com/").nextjs).toContain("app/page.tsx");
    expect(likelyFiles("no-sitemap", "https://x.com/").nextjs).toEqual(["app/sitemap.ts"]);
    expect(likelyFiles("no-robots-txt", "https://x.com/").html).toEqual(["robots.txt"]);
  });

  it("copes with a bad address", () => {
    expect(pathOf("not a url")).toBe("not a url");
  });
});

describe("shortCommit", () => {
  it("shortens a full hash and leaves anything else whole", () => {
    expect(shortCommit("23cd0cab3425f2b54aa2eae8ebfb18d9ea366c53")).toBe("23cd0ca");
    expect(shortCommit("abc123")).toBe("abc123");
    expect(shortCommit("seopen/fixes")).toBe("seopen/fixes");
  });
});

describe("a logged change", () => {
  const row = { code: "manual-change", url: "https://x.com/pricing", detail: "Rewrote the title and intro.", evidence: { expect: "Pricing for small teams" } };

  it("reads as the change itself, never as a finding", () => {
    expect(plainIssue(row)).toBe("/pricing was changed: Rewrote the title and intro. SEOpen looks for “Pricing for small teams” on the live page.");
    expect(issueLine(row)).toBe("/pricing: Rewrote the title and intro. Looking for “Pricing for small teams” on the live page.");
    expect(issueLine({ ...row, url: "https://x.com/", detail: null, evidence: null })).toBe("The home page.");
    expect(beforeLine({ ...row, status: "live", liveCheck: { saw: "The page contains it." } })).not.toContain("Before:");
  });

  it("is something an agent changes in the code, measured on its own page", () => {
    expect(fixDef("manual-change")).toMatchObject({ kind: "code", verb: "Changed" });
    expect(canAgentFix("manual-change")).toBe(true);
    expect(isSiteWide("manual-change")).toBe(false);
    expect(whyItMatters("manual-change")).not.toBe("");
  });
});
