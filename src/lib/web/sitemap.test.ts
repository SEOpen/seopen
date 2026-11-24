import { describe, expect, it } from "vitest";
import { sitemapEntries, sitemapLocs } from "./sitemap";

describe("sitemapLocs", () => {
  it("reads locs and spots an index", () => {
    expect(sitemapLocs("<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url></urlset>")).toEqual({ index: false, locs: ["https://a.com/x?a=1&b=2"] });
    expect(sitemapLocs("<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>").index).toBe(true);
  });
});

describe("sitemapEntries", () => {
  it("pairs each loc with its lastmod, if any", () => {
    const xml = `<urlset>
      <url><loc>https://a.com/</loc><lastmod>2026-11-01</lastmod></url>
      <url>
        <loc> https://a.com/x?a=1&amp;b=2 </loc>
        <image:image><image:loc>https://a.com/i.png</image:loc></image:image>
      </url>
    </urlset>`;
    expect(sitemapEntries(xml)).toEqual({
      index: false,
      entries: [
        { loc: "https://a.com/", lastmod: "2026-11-01" },
        { loc: "https://a.com/x?a=1&b=2", lastmod: null },
      ],
    });
  });

  it("reads an index's sitemaps", () => {
    const r = sitemapEntries('<sitemapindex xmlns="x"><sitemap><loc>https://a.com/s1.xml</loc><lastmod>2026-10-01T10:00:00Z</lastmod></sitemap></sitemapindex>');
    expect(r).toEqual({ index: true, entries: [{ loc: "https://a.com/s1.xml", lastmod: "2026-10-01T10:00:00Z" }] });
  });
});
