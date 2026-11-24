import { describe, expect, it } from "vitest";
import { expectedCtr, declining, lowCtr, parseRange, strikingDistance, strikingMinImpressions, strikingPages, strikingWeight } from "./insights";
import {
  currentPick,
  pageKey,
  planImport,
  propertyName,
  selectImports,
  scoreGscMatch,
  siteDomain,
  siteLabel,
  suggestGa4Property,
  suggestGscProperty,
  type Ga4Property,
  type GscSite,
} from "./matching";

const site = (siteUrl: string, permissionLevel = "siteOwner"): GscSite => ({ siteUrl, permissionLevel });
const prop = (property: string, propertyName: string, streamDomains: string[] = []): Ga4Property => ({
  property,
  propertyName,
  account: "accounts/1",
  accountName: "Main",
  streamDomains,
});

describe("GSC property matching", () => {
  it("reads the domain from both property formats", () => {
    expect(siteDomain("sc-domain:alphanote.example")).toBe("alphanote.example");
    expect(siteDomain("https://www.alphanote.example/")).toBe("alphanote.example");
    expect(siteDomain("http://blog.alphanote.example/")).toBe("blog.alphanote.example");
  });

  it("prefers a Domain property, then https root, then http root, then a path prefix", () => {
    expect(scoreGscMatch("alphanote.example", "sc-domain:alphanote.example")).toBeGreaterThan(scoreGscMatch("alphanote.example", "https://www.alphanote.example/"));
    expect(scoreGscMatch("alphanote.example", "https://alphanote.example/")).toBeGreaterThan(scoreGscMatch("alphanote.example", "http://alphanote.example/"));
    expect(scoreGscMatch("alphanote.example", "http://alphanote.example/")).toBeGreaterThan(scoreGscMatch("alphanote.example", "https://alphanote.example/blog/"));
    expect(scoreGscMatch("alphanote.example", "sc-domain:paperfinch.example")).toBe(0);
  });

  it("lets a parent Domain property cover a subdomain project, but not the reverse", () => {
    expect(scoreGscMatch("blog.alphanote.example", "sc-domain:alphanote.example")).toBeGreaterThan(0);
    expect(scoreGscMatch("alphanote.example", "sc-domain:blog.alphanote.example")).toBe(0);
  });

  it("suggests the best usable site and skips unverified ones", () => {
    const sites = [
      site("https://www.alphanote.example/"),
      site("sc-domain:alphanote.example", "siteUnverifiedUser"),
      site("sc-domain:paperfinch.example"),
    ];
    expect(suggestGscProperty("alphanote.example", sites)).toBe("https://www.alphanote.example/");
    expect(suggestGscProperty("www.PaperFinch.example", sites)).toBe("sc-domain:paperfinch.example");
    expect(suggestGscProperty("example.com", sites)).toBeNull();
  });
});

describe("GA4 property matching", () => {
  const props = [
    prop("properties/1", "Alphanote", ["www.alphanote.example"]),
    prop("properties/2", "paperfinch.example - GA4"),
    prop("properties/3", "Velvet Fox site"),
    prop("properties/4", "Old lark test", ["staging.alphanote.example"]),
  ];

  it("matches on web stream hostnames first", () => {
    expect(suggestGa4Property("alphanote.example", props)).toBe("properties/1");
  });

  it("falls back to the property name", () => {
    expect(suggestGa4Property("paperfinch.example", props)).toBe("properties/2");
    expect(suggestGa4Property("velvetfox.com", props)).toBeNull();
  });
});

describe("planImport", () => {
  it("creates one project per unmapped domain, preferring Domain properties", () => {
    const plan = planImport(
      [{ domain: "alphanote.example", gscProperty: "sc-domain:alphanote.example" }],
      [
        site("sc-domain:alphanote.example"),
        site("https://www.paperfinch.example/"),
        site("sc-domain:paperfinch.example"),
        site("https://quillgrove.dev/"),
        site("sc-domain:ghost.com", "siteUnverifiedUser"),
      ],
    );
    expect(plan).toEqual([
      { domain: "paperfinch.example", siteUrl: "sc-domain:paperfinch.example" },
      { domain: "quillgrove.dev", siteUrl: "https://quillgrove.dev/" },
    ]);
  });

  it("skips domains that already have a project even if it is not mapped", () => {
    expect(planImport([{ domain: "alphanote.example", gscProperty: null }], [site("sc-domain:alphanote.example")])).toEqual([]);
  });
});

describe("pageKey", () => {
  it("joins GSC URLs with GA4 host + landing page", () => {
    expect(pageKey("https://www.alphanote.example/templates/daily/")).toBe("alphanote.example/templates/daily");
    expect(pageKey("www.alphanote.example", "/templates/daily")).toBe("alphanote.example/templates/daily");
    expect(pageKey("alphanote.example", "/templates/daily?utm_source=x")).toBe("alphanote.example/templates/daily");
    expect(pageKey("https://alphanote.example")).toBe("alphanote.example/");
    expect(pageKey("alphanote.example", "/")).toBe("alphanote.example/");
  });
});

describe("opportunity rules", () => {
  const row = (clicks: number, impressions: number, position: number) => ({ clicks, impressions, position, ctr: clicks / impressions });

  it("expected CTR falls with position and interpolates", () => {
    expect(expectedCtr(1)).toBeCloseTo(0.28);
    expect(expectedCtr(1.5)).toBeCloseTo(0.215);
    expect(expectedCtr(15)).toBe(0.01);
    expect(expectedCtr(3)).toBeGreaterThan(expectedCtr(4));
  });

  it("striking distance keeps positions 4–20 with enough impressions", () => {
    const rows = [row(1, 500, 9), row(1, 20, 12), row(30, 900, 3), row(2, 300, 19.5), row(0, 400, 25), row(3, 350, 4)];
    expect(strikingDistance(rows).map((r) => r.position)).toEqual([9, 4, 19.5]);
    expect(strikingDistance(rows, 50, { min: 11, max: 20 }).map((r) => r.position)).toEqual([19.5]);
  });

  it("reads a range from a URL or an agent, and falls back to 4 to 20", () => {
    expect(parseRange("4", "10")).toEqual({ min: 4, max: 10 });
    expect(parseRange(1, 20)).toEqual({ min: 1, max: 20 });
    for (const [lo, hi] of [["10", "4"], ["0", "20"], ["4", "30"], ["4.5", "10"], [undefined, undefined], ["", ""]]) expect(parseRange(lo, hi)).toEqual({ min: 4, max: 20 });
  });

  it("scales the impressions bar with the period", () => {
    expect(strikingMinImpressions(28)).toBe(50);
    expect(strikingMinImpressions(90)).toBe(161);
    expect(strikingMinImpressions(7)).toBe(13);
  });

  it("groups searches by page and scores impressions × (21 − position) ÷ 17", () => {
    expect(strikingWeight(4)).toBe(1);
    expect(strikingWeight(20)).toBeCloseTo(1 / 17);
    const pair = (page: string, query: string, impressions: number, position: number, clicks = 0) => ({ page, query, impressions, position, clicks });
    const pages = strikingPages([
      pair("/a", "alpha", 170, 4, 5), // 170
      pair("/a", "alpha two", 340, 12.5, 1), // 170
      pair("/b", "beta", 1_000, 19.5), // 88.2
      pair("/b", "beta top", 900, 2), // out of range
      pair("/c", "gamma", 30, 5), // under the impressions bar on its own
      pair("/d", "delta", 400, 21), // out of range
    ]);
    expect(pages.map((p) => p.page)).toEqual(["/a", "/b"]);
    expect(pages[0]).toMatchObject({ score: 340, queries: 2, impressions: 510, clicks: 6, bestPosition: 4, topQuery: { query: "alpha two", position: 12.5, impressions: 340 } });
    expect(pages[1]).toMatchObject({ score: 88.2, queries: 1, impressions: 1_000, bestPosition: 19.5, topQuery: { query: "beta" } });
    expect(strikingPages([pair("/c", "gamma", 30, 5)], undefined, 20).map((p) => p.page)).toEqual(["/c"]);
    expect(strikingPages([pair("/b", "beta top", 900, 2)], { min: 1, max: 20 })[0].score).toBe(1_005.9);
  });

  it("low CTR flags top-10 rows under half the expected CTR", () => {
    const rows = [row(5, 1000, 2), row(100, 1000, 2), row(1, 50, 1)];
    const out = lowCtr(rows);
    expect(out).toHaveLength(1);
    expect(out[0].missedClicks).toBe(145);
  });

  it("declining keeps rows down 30% or more with a real baseline", () => {
    const out = declining([
      { page: "a", clicks: 50, prevClicks: 100 },
      { page: "b", clicks: 90, prevClicks: 100 },
      { page: "c", clicks: 0, prevClicks: 5 },
      { page: "d", clicks: 10, prevClicks: null },
    ]);
    expect(out.map((r) => r.page)).toEqual(["a"]);
    expect(out[0].lostClicks).toBe(50);
  });
});

describe("selectImports", () => {
  const plan = [
    { domain: "paperfinch.example", siteUrl: "sc-domain:paperfinch.example" },
    { domain: "reportwell.app", siteUrl: "sc-domain:reportwell.app" },
    { domain: "zetagrid.example", siteUrl: "sc-domain:zetagrid.example" },
  ];
  const ga4 = [prop("properties/1", "Reportwell"), prop("properties/2", "ZetaGrid")];

  it("keeps only ticked sites from the current plan, with their GA4 choice", () => {
    const choices: Record<string, string> = { "sc-domain:reportwell.app": "properties/1", "sc-domain:zetagrid.example": "" };
    expect(selectImports(plan, ["sc-domain:reportwell.app", "sc-domain:zetagrid.example"], (s) => choices[s], ga4)).toEqual([
      { domain: "reportwell.app", siteUrl: "sc-domain:reportwell.app", ga4Property: "properties/1" },
      { domain: "zetagrid.example", siteUrl: "sc-domain:zetagrid.example", ga4Property: null },
    ]);
  });

  it("drops sites that aren't in the plan and GA4 properties the account can't see", () => {
    expect(selectImports(plan, ["sc-domain:alphanote.test", "sc-domain:paperfinch.example"], () => "properties/999", ga4)).toEqual([
      { domain: "paperfinch.example", siteUrl: "sc-domain:paperfinch.example", ga4Property: null },
    ]);
  });
});

describe("property names", () => {
  it("drops the raw prefixes", () => {
    expect(propertyName("sc-domain:example.com")).toBe("example.com");
    expect(propertyName("https://www.example.com/")).toBe("www.example.com");
    expect(propertyName("https://example.com/blog/")).toBe("example.com/blog");
    expect(propertyName("properties/462738462")).toBe("GA4 property 462738462");
  });

  it("keeps a domain and a URL apart in a list", () => {
    expect(siteLabel("sc-domain:example.com")).toBe("example.com (whole domain)");
    expect(siteLabel("https://example.com/")).toBe("https://example.com/");
  });
});

describe("currentPick", () => {
  const own = { domain: "a.com", value: "sc-domain:other.com" };

  it("starts on the best match, or None without one", () => {
    expect(currentPick("a.com", null, "sc-domain:a.com")).toBe("sc-domain:a.com");
    expect(currentPick("a.com", null, null)).toBe("");
  });

  it("keeps the person's own choice, None included, however the same address is written", () => {
    expect(currentPick("https://www.a.com/", own, "sc-domain:a.com")).toBe("sc-domain:other.com");
    expect(currentPick("a.com", { domain: "a.com", value: "" }, "sc-domain:a.com")).toBe("");
  });

  it("drops it for a new address, so a site picked for one is never linked to another", () => {
    expect(currentPick("b.com", own, "sc-domain:b.com")).toBe("sc-domain:b.com");
    expect(currentPick("b.com", own, null)).toBe("");
  });
});
