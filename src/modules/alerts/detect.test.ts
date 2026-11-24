import { describe, expect, it } from "vitest";
import type { AccessReport } from "@/modules/audit/access";
import { botBlocked, leftTop10, pageBroken, pageKey, type RankRow } from "./detect";

const report = (keyPages: string[], error: string | null = null) =>
  ({ robots: { url: "https://x.test/robots.txt", status: error ? null : 200, fetchedAt: "", found: true, error, sitemaps: [] }, crawlers: [], keyPages, probes: [] }) as unknown as AccessReport;

describe("pageKey", () => {
  it("reads one page the same however it's written", () => {
    expect(pageKey("https://X.test/pricing/")).toBe("https://x.test/pricing");
    expect(pageKey("https://x.test/pricing#plans")).toBe("https://x.test/pricing");
    expect(pageKey("https://x.test/")).toBe("https://x.test/");
    expect(pageKey("https://x.test/a?b=1")).toBe("https://x.test/a?b=1");
  });
});

describe("page-broken", () => {
  const clicked = new Map([
    ["https://x.test/pricing", 40],
    ["https://x.test/blog", 1],
    ["https://x.test/about", 3],
    ["https://x.test/down", 5],
  ]);

  it("fires for a clicked page that answers 4xx or 5xx or is set to noindex, and leaves pages without clicks alone", () => {
    const out = pageBroken({
      crawlId: 7,
      clicked,
      pages: [
        { url: "https://x.test/pricing/", statusCode: 404 },
        { url: "https://x.test/down", statusCode: 503 },
        { url: "https://x.test/blog", statusCode: 200 },
        { url: "https://x.test/about", statusCode: 200 },
        { url: "https://x.test/never-clicked", statusCode: 404 },
      ],
      nonIndexable: [
        { url: "https://x.test/blog", reason: "meta_tag" },
        { url: "https://x.test/about", reason: "canonical" },
      ],
    });
    expect(out.findings).toEqual([
      { key: "https://x.test/pricing", title: "/pricing/ answers 404", detail: "40 Search Console clicks in the last 28 days", screen: "/audit/pages?crawl=7&status=4xx" },
      { key: "https://x.test/down", title: "/down answers 503", detail: "5 Search Console clicks in the last 28 days", screen: "/audit/pages?crawl=7&status=5xx" },
      { key: "https://x.test/blog", title: "/blog is set to noindex", detail: "It has a noindex tag. 1 Search Console click in the last 28 days.", screen: "/audit/issues?crawl=7&category=indexability" },
    ]);
    // A canonical elsewhere isn't noindex: the page is fine.
    expect(out.fine).toEqual(["https://x.test/about"]);
  });

  it("judges nothing the crawl didn't reach", () => {
    expect(pageBroken({ crawlId: 1, clicked, pages: [], nonIndexable: [] })).toEqual({ findings: [], fine: [] });
  });
});

describe("bot-blocked", () => {
  const home = "https://x.test/";
  const blog = "https://x.test/blog";

  it("fires for a key page the previous check found open", () => {
    const out = botBlocked({
      crawlId: 9,
      current: { report: report([home, blog]), blocked: [{ url: blog, detail: "Googlebot (Disallow: /blog)" }] },
      previous: { report: report([home, blog]), blocked: [] },
    });
    expect(out.findings).toEqual([
      { key: blog, title: "robots.txt now blocks search crawlers from /blog", detail: "Blocked: Googlebot (Disallow: /blog). The previous crawl's check found it open.", screen: "/audit/issues?crawl=9&category=access" },
    ]);
    expect(out.fine).toEqual([home]);
  });

  it("doesn't call a page newly blocked when it was blocked before, or wasn't checked before", () => {
    const out = botBlocked({
      crawlId: 9,
      current: { report: report([home, blog]), blocked: [{ url: home, detail: "Bingbot" }, { url: blog, detail: "Googlebot" }] },
      previous: { report: report([home]), blocked: [{ url: home, detail: "Bingbot" }] },
    });
    expect(out.findings).toEqual([]);
  });

  it("needs an earlier check to compare with, and a robots.txt it could read", () => {
    const current = { report: report([home]), blocked: [{ url: home, detail: "Googlebot" }] };
    expect(botBlocked({ crawlId: 1, current, previous: null }).findings).toEqual([]);
    expect(botBlocked({ crawlId: 1, current, previous: { report: null, blocked: [] } }).findings).toEqual([]);
    expect(botBlocked({ crawlId: 1, current, previous: { report: report([home], "timed out"), blocked: [] } }).findings).toEqual([]);
    // robots.txt unread now: nothing fires and nothing is called fine.
    expect(botBlocked({ crawlId: 1, current: { report: report([home], "timed out"), blocked: [] }, previous: { report: report([home]), blocked: [] } })).toEqual({ findings: [], fine: [] });
  });
});

describe("left-top-10", () => {
  const row = (o: Partial<RankRow>): RankRow => ({ keywordId: 1, keyword: "emergency plumber", locationCode: 2840, position: 14, depth: 20, notChecked: false, previous: { position: 6, date: "2026-11-14" }, ...o });
  const day = (d: string) => (d === "2026-11-14" ? "Nov 14" : d);

  it("fires for a keyword in the top 10 at its previous check and below it now", () => {
    const out = leftTop10([row({}), row({ keywordId: 2, keyword: "drain repair", position: null })], day);
    expect(out.findings).toEqual([
      { key: "1:2840", title: "“emergency plumber” left the top 10", detail: "Position 6 on Nov 14, position 14 now.", screen: "/rank/1" },
      { key: "2:2840", title: "“drain repair” left the top 10", detail: "Position 6 on Nov 14, not in the top 20 now.", screen: "/rank/2" },
    ]);
  });

  it("ignores positions no look confirmed, keywords already outside the top 10, and none before", () => {
    const out = leftTop10([row({ notChecked: true }), row({ previous: { position: 11, date: "2026-11-14" } }), row({ previous: null }), row({ previous: { position: null, date: "2026-11-14" } })], day);
    expect(out.findings).toEqual([]);
  });

  it("calls a keyword back in the top 10 fine", () => {
    expect(leftTop10([row({ position: 10 })], day)).toEqual({ findings: [], fine: ["1:2840"] });
  });
});
