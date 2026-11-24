import { describe, expect, it } from "vitest";
import backlinksFixture from "./fixtures/backlinks.json";
import intersectionFixture from "./fixtures/intersection.json";
import newLostFixture from "./fixtures/new_lost.json";
import referringDomainsFixture from "./fixtures/referring_domains.json";
import {
  brandTerm,
  buildDisavowFile,
  buildReview,
  classifyAnchor,
  dofollowShare,
  estimateCostUsd,
  BROAD_LINK_RANK,
  isBroadLinker,
  isSameBrand,
  isUniversalLinker,
  isWithinDays,
  linkedPageRows,
  subnetOf,
  mergeGap,
  prepareGap,
  REVIEW_LABELS,
  scoreDomain,
  timeseriesWindow,
  toNewLostSeries,
  type DomainSignals,
} from "./logic";
import type { BacklinkItem, IntersectionItem, ReferringDomainItem } from "./types";

const base: DomainSignals = { domain: "example.com", spamScore: 0, rank: 200, backlinks: 2, tld: "com", anchor: "Example", subnetPeers: 1 };

describe("REVIEW_LABELS", () => {
  it("has a word for every label scoreDomain gives", () => {
    expect(REVIEW_LABELS[scoreDomain(base).label]).toBe("OK");
    expect(REVIEW_LABELS[scoreDomain({ ...base, spamScore: 35, rank: 0 }).label]).toBe("To review");
    expect(REVIEW_LABELS[scoreDomain({ ...base, spamScore: 60, rank: 0 }).label]).toBe("Risky");
  });
});

describe("brandTerm", () => {
  it("drops the TLD, www and subdomains", () => {
    expect(brandTerm("alphanote.example")).toBe("alphanote");
    expect(brandTerm("www.alphanote.example")).toBe("alphanote");
    expect(brandTerm("blog.example.co.uk")).toBe("example");
    expect(brandTerm("plainpadnotes.github.io")).toBe("github");
  });
});

describe("classifyAnchor", () => {
  const kw = ["mac journal", "shared notes"];
  it("recognises URLs, brand, generic, exact, partial and other", () => {
    expect(classifyAnchor("https://alphanote.example/", "alphanote.example", kw)).toBe("url");
    expect(classifyAnchor("www.alphanote.example", "alphanote.example", kw)).toBe("url");
    expect(classifyAnchor("AlphaNote app", "alphanote.example", kw)).toBe("branded");
    expect(classifyAnchor("Alpha Note", "alphanote.example", kw)).toBe("branded");
    expect(classifyAnchor("Visit Our Site", "alphanote.example", kw)).toBe("generic");
    expect(classifyAnchor("click here!", "alphanote.example", kw)).toBe("generic");
    expect(classifyAnchor("", "alphanote.example", kw)).toBe("generic");
    expect(classifyAnchor(null, "alphanote.example", kw)).toBe("generic");
    expect(classifyAnchor("Mac Journal", "alphanote.example", kw)).toBe("exact");
    expect(classifyAnchor("the best shared offline notes", "alphanote.example", kw)).toBe("partial");
    expect(classifyAnchor("quiet pages for your desktop", "alphanote.example", kw)).toBe("other");
  });
  it("without keywords there is no exact or partial class", () => {
    expect(classifyAnchor("mac journal", "alphanote.example")).toBe("other");
  });
});

describe("dofollowShare and cost", () => {
  it("uses the nofollow attribute count", () => {
    expect(dofollowShare({ backlinks: 349, referring_links_attributes: { nofollow: 90, noopener: 101 } })).toBeCloseTo(259 / 349);
    expect(dofollowShare({ backlinks: 10, referring_links_attributes: null })).toBe(1);
    expect(dofollowShare({ backlinks: 0, referring_links_attributes: null })).toBeNull();
  });
  it("estimates list price", () => {
    expect(estimateCostUsd(0)).toBeCloseTo(0.024);
    expect(estimateCostUsd(1000)).toBeCloseTo(0.06);
  });
});

describe("toNewLostSeries", () => {
  it("sorts by month and makes lost counts negative", () => {
    const series = toNewLostSeries(newLostFixture);
    expect(series).toHaveLength(newLostFixture.length);
    expect(series[0].date).toBe("2025-10");
    expect(series.every((p, i) => i === 0 || p.date > series[i - 1].date)).toBe(true);
    expect(series[0]).toEqual({ date: "2025-10", newDomains: 2, lostDomains: -1, newBacklinks: 4, lostBacklinks: -7 });
    expect(toNewLostSeries(null)).toEqual([]);
  });
  it("pins the window to the Sunday before this week's Monday", () => {
    expect(timeseriesWindow(new Date("2026-10-29T12:00:00Z"))).toEqual({ date_from: "2025-10-01", date_to: "2026-10-25" });
    expect(timeseriesWindow(new Date("2026-11-01T23:00:00Z")).date_to).toBe("2026-10-25");
  });
  it("ends before today on a Monday, which DataForSEO requires", () => {
    expect(timeseriesWindow(new Date("2026-10-26T00:00:00Z"))).toEqual({ date_from: "2025-10-01", date_to: "2026-10-25" });
    expect(timeseriesWindow(new Date("2026-11-16T01:11:00Z"))).toEqual({ date_from: "2025-11-01", date_to: "2026-11-15" });
  });
});

describe("scoreDomain", () => {
  it("leaves a clean link ok", () => {
    expect(scoreDomain(base)).toEqual({ score: 0, label: "ok", reasons: [] });
  });
  it("adds explainable points per rule", () => {
    expect(scoreDomain({ ...base, spamScore: 65 }).score).toBe(40);
    expect(scoreDomain({ ...base, spamScore: 35 }).score).toBe(20);
    expect(scoreDomain({ ...base, spamScore: 35, rank: 0 }).label).toBe("review");
    expect(scoreDomain({ ...base, tld: "shop" }).reasons).toEqual(["Link-network TLD (.shop)"]);
    expect(scoreDomain({ ...base, anchor: "Buy cheap backlinks" }).reasons[0]).toMatch(/Spammy link text/);
    expect(scoreDomain({ ...base, anchor: "Search engine optimisation guide" }).score).toBe(0);
    expect(scoreDomain({ ...base, backlinks: 120 }).reasons[0]).toMatch(/Site-wide/);
    expect(scoreDomain({ ...base, subnetPeers: 4 }).score).toBe(15);
    expect(scoreDomain({ ...base, rank: 0 }).score).toBe(10);
  });
  it("labels a link-network domain risky and caps at 100", () => {
    const r = scoreDomain({ ...base, spamScore: 70, tld: "site", anchor: "Premium SEO links", backlinks: 80, subnetPeers: 5, rank: 0 });
    expect(r.label).toBe("risky");
    expect(r.score).toBe(100);
    expect(r.reasons).toHaveLength(6);
  });
});

describe("buildReview", () => {
  it("joins domains with their sample link and ranks the spam first", () => {
    const rows = buildReview(referringDomainsFixture as unknown as ReferringDomainItem[], backlinksFixture as unknown as BacklinkItem[]);
    expect(rows).toHaveLength(referringDomainsFixture.length);
    const spam = rows.find((r) => r.domain === "linkfarm-alpha.shop")!;
    expect(spam.label).toBe("risky");
    expect(spam.anchor).toMatch(/Premium SEO Links/);
    expect(spam.reasons.some((r) => r.includes(".shop"))).toBe(true);
    const home = rows.find((r) => r.domain === "fernhill-neighbors.biz")!;
    expect(home.anchor).toBe("Visit Our Site");
    expect(home.urlFrom).toMatch(/fernhill-neighbors\.biz/);
    expect(rows[0].score).toBeGreaterThanOrEqual(rows.at(-1)!.score);
  });
  it("counts linking domains that share a /24 subnet", () => {
    const domains = ["a.com", "b.com", "c.com"].map((domain) => ({ domain, rank: 100, backlinks: 1, backlinks_spam_score: 0 }) as ReferringDomainItem);
    const links = domains.map((d, i) => ({ domain_from: d.domain, domain_from_ip: `10.0.0.${i + 1}`, anchor: "x" }) as BacklinkItem);
    expect(buildReview(domains, links).every((r) => r.subnetPeers === 3 && r.score === 15)).toBe(true);
  });
});

describe("buildDisavowFile", () => {
  it("writes a dated header and sorted, deduped domain lines", () => {
    const file = buildDisavowFile(["b.shop", "www.a.site", "b.shop", " "], { target: "alphanote.example", date: new Date("2026-10-29T10:00:00Z") });
    const lines = file.trimEnd().split("\n");
    expect(lines[0]).toBe("# Disavow file for alphanote.example");
    expect(lines[1]).toContain("2026-10-29");
    expect(lines[1]).toContain("2 domains");
    expect(lines.filter((l) => !l.startsWith("#"))).toEqual(["domain:a.site", "domain:b.shop"]);
    expect(file.endsWith("\n")).toBe(true);
  });
  it("is valid with no domains", () => {
    expect(buildDisavowFile([], { target: "x.com", date: new Date() }).split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([]);
  });
});

describe("isSameBrand", () => {
  it("matches a site's brand on another TLD or subdomain, and nothing shorter than 3 letters", () => {
    expect(isSameBrand("seranking.ru", ["getseopen.com", "seranking.com"])).toBe(true);
    expect(isSameBrand("blog.spyfu.co.uk", ["spyfu.com"])).toBe(true);
    expect(isSameBrand("madeup-tools.com", ["seranking.com", "spyfu.com"])).toBe(false);
    expect(isSameBrand("x.org", ["x.com"])).toBe(false);
  });
});

describe("isUniversalLinker", () => {
  it("matches the listed sites, their subdomains and search engines on any TLD", () => {
    expect(isUniversalLinker("google.com")).toBe(true);
    expect(isUniversalLinker("www.google.com")).toBe(true);
    expect(isUniversalLinker("sites.google.com")).toBe(true);
    expect(isUniversalLinker("google.co.uk")).toBe(true);
    expect(isUniversalLinker("yandex.kz")).toBe(true);
    expect(isUniversalLinker("m.facebook.com")).toBe(true);
    expect(isUniversalLinker("web.archive.org")).toBe(true);
  });

  it("leaves niche sites alone, including ones whose name only ends like a listed one", () => {
    expect(isUniversalLinker("garden-forum.example")).toBe(false);
    expect(isUniversalLinker("notx.com")).toBe(false);
    expect(isUniversalLinker("facebook.com.example")).toBe(false);
    expect(isUniversalLinker("reddit-gardening.example")).toBe(false);
  });
});

describe("isBroadLinker", () => {
  it("flags a high link rank that links to every one of three or more competitors", () => {
    expect(isBroadLinker({ competitorCount: 3, rank: BROAD_LINK_RANK }, 3)).toBe(true);
    expect(isBroadLinker({ competitorCount: 3, rank: BROAD_LINK_RANK - 1 }, 3)).toBe(false);
    expect(isBroadLinker({ competitorCount: 2, rank: 900 }, 3)).toBe(false);
    expect(isBroadLinker({ competitorCount: 3, rank: null }, 3)).toBe(false);
  });

  it("says nothing with fewer than three competitors, where every row links to all of them", () => {
    expect(isBroadLinker({ competitorCount: 2, rank: 900 }, 2)).toBe(false);
    expect(isBroadLinker({ competitorCount: 1, rank: 900 }, 1)).toBe(false);
  });
});

describe("prepareGap", () => {
  const rivals = ["rival-one.example", "rival-two.example", "rival-three.example"];
  const gapRow = (domain: string, competitorCount: number, rank: number, spamScore: number) => ({ domain, competitorCount, competitors: rivals.slice(0, competitorCount).join(", "), rank, backlinks: 3, spamScore, firstSeen: null });
  // Spam and the general host first, to show that prepareGap moves them.
  const merged = [
    gapRow("farm.example", 3, 650, 70),
    gapRow("news-hub.example", 3, 700, 0),
    gapRow("garden-blog.example", 2, 120, 1),
    gapRow("google.de", 3, 900, 0),
    gapRow("rival-one.ru", 1, 300, 0),
    gapRow("fernhill.de", 1, 200, 0),
  ];

  it("leaves out own sites and universal linkers, and puts general hosts after the rest", () => {
    const gap = prepareGap(merged, "fernhill.example", rivals);
    expect(gap.rows.map((r) => [r.domain, r.broadLinker])).toEqual([
      ["garden-blog.example", false],
      ["news-hub.example", true],
    ]);
    expect(gap.ownSites).toEqual(["rival-one.ru", "fernhill.de"]);
    expect(gap.universalLinkers).toEqual(["google.de"]);
    expect(gap.spamHidden).toBe(1);
  });

  it("lists spam last with includeSpam, and counts none hidden", () => {
    const gap = prepareGap(merged, "fernhill.example", rivals, { includeSpam: true });
    expect(gap.rows.map((r) => r.domain)).toEqual(["garden-blog.example", "news-hub.example", "farm.example"]);
    expect(gap.spamHidden).toBe(0);
  });
});

describe("mergeGap", () => {
  it("merges per-competitor results and puts shared prospects first", () => {
    const fx = intersectionFixture as unknown as IntersectionItem[];
    const rows = mergeGap([
      { competitor: "a.com", items: fx.slice(0, 2) },
      { competitor: "b.com", items: fx.slice(1, 4) },
    ]);
    const shared = rows.find((r) => r.competitorCount === 2)!;
    expect(shared.competitors).toBe("a.com, b.com");
    expect(rows[0].competitorCount).toBe(2);
    expect(new Set(rows.map((r) => r.domain)).size).toBe(rows.length);
  });

  it("puts domains with an elevated spam score after the rest, however many competitors they link to", () => {
    const item = (target: string, spam: number) => ({ domain_intersection: { "1": { target, rank: 100, backlinks: 1, backlinks_spam_score: spam } } }) as unknown as IntersectionItem;
    const rows = mergeGap([
      { competitor: "a.com", items: [item("farm.xyz", 70), item("blog.org", 5)] },
      { competitor: "b.com", items: [item("farm.xyz", 70)] },
    ]);
    expect(rows.map((r) => r.domain)).toEqual(["blog.org", "farm.xyz"]);
  });
});

describe("isWithinDays", () => {
  it("compares against now", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    expect(isWithinDays("2026-10-10 00:00:00 +00:00", 30, now)).toBe(true);
    expect(isWithinDays("2026-09-01 00:00:00 +00:00", 30, now)).toBe(false);
    expect(isWithinDays(null, 30, now)).toBe(false);
  });
});

describe("subnetOf", () => {
  it("groups by /24 and ignores Cloudflare addresses", () => {
    expect(subnetOf("203.0.113.176")).toBe("203.0.113");
    expect(subnetOf("104.21.89.3")).toBeNull();
    expect(subnetOf("172.67.154.102")).toBeNull();
    expect(subnetOf("2606:4700::1")).toBeNull();
    expect(subnetOf(null)).toBeNull();
  });
});

describe("linkedPageRows", () => {
  const link = (url_to: string, domain_from: string, rank: number | null, dofollow: boolean, anchor: string | null) => ({ url_to, domain_from, domain_from_rank: rank, dofollow, anchor }) as BacklinkItem;

  it("groups links by target page, most linking domains first, strongest domains first", () => {
    const rows = linkedPageRows([
      link("https://example.com/tool", "www.a.com", 100, true, "free tool"),
      link("https://example.com/", "b.com", 50, false, "Example"),
      link("https://example.com/tool", "c.com", 300, false, "  free tool "),
      link("https://example.com/tool", "d.com", null, true, null),
    ]);
    expect(rows.map((r) => [r.url, r.referringDomains, r.dofollow])).toEqual([
      ["https://example.com/tool", 3, 2],
      ["https://example.com/", 1, 0],
    ]);
    expect(rows[0].topDomains.map((d) => d.domain)).toEqual(["c.com", "a.com", "d.com"]);
    expect(rows[0].anchors).toEqual(["free tool"]);
    expect(rows[0]).not.toHaveProperty("anchorSet");
  });

  it("counts an address's http, www and tracking variants as one page, and keeps subdomains apart", () => {
    const rows = linkedPageRows([
      link("https://rival-two.example/", "a.com", 10, true, null),
      link("http://www.rival-two.example/?utm_source=x&ref=producthunt", "b.com", 20, true, null),
      link("https://rival-two.example/#top", "c.com", 30, true, null),
      link("https://rival-two.example/search?q=seo&utm_medium=email", "d.com", 40, true, null),
      link("https://app.rival-two.example/", "e.com", 50, true, null),
    ]);
    expect(rows.map((r) => [r.url, r.referringDomains])).toEqual([
      ["https://rival-two.example/", 3],
      ["https://rival-two.example/search?q=seo", 1],
      ["https://app.rival-two.example/", 1],
    ]);
  });

  it("keeps at most five domains and five link texts a page", () => {
    const many = Array.from({ length: 7 }, (_, i) => link("https://example.com/", `s${i}.com`, i, true, `text ${i}`));
    const [row] = linkedPageRows(many);
    expect(row.referringDomains).toBe(7);
    expect(row.topDomains).toHaveLength(5);
    expect(row.anchors).toHaveLength(5);
  });
});
