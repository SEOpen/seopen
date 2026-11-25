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

describe("a sitemap's edges", () => {
  it("doesn't take <urlset> or <sitemapindex> for an entry, and reads an empty lastmod as none", () => {
    expect(sitemapEntries("<urlset><url><loc>https://a.com/</loc><lastmod> </lastmod></url></urlset>")).toEqual({ index: false, entries: [{ loc: "https://a.com/", lastmod: null }] });
    expect(sitemapEntries("<sitemapindex><sitemap><loc>https://a.com/s.xml</loc><lastmod> 2026-10-01 </lastmod></sitemap></sitemapindex>").entries).toEqual([{ loc: "https://a.com/s.xml", lastmod: "2026-10-01" }]);
  });

  it("leaves out a URL longer than the protocol allows", () => {
    const long = `https://a.com/${"x".repeat(2_048)}`;
    const ok = `https://a.com/${"x".repeat(2_000)}`;
    const xml = `<urlset><url><loc>${long}</loc></url><url><loc>${ok}</loc></url></urlset>`;
    expect(sitemapLocs(xml).locs).toEqual([ok]);
    expect(sitemapEntries(xml).entries).toEqual([{ loc: ok, lastmod: null }]);
  });

  it("reads 10 MB of markup in linear time", () => {
    const MB10 = 10_000_000;
    const spaces = " ".repeat(MB10);
    for (const xml of ["<url>".repeat(MB10 / 5), `<url><loc>https://a.com/</loc><lastmod>${spaces}<x></url>`, `<url><loc>${spaces}<x></url>`, `<url><loc>a${spaces}<x></url>`, "<loc>".repeat(MB10 / 5)]) {
      const started = Date.now();
      sitemapEntries(xml);
      sitemapLocs(xml);
      expect(Date.now() - started, xml.slice(0, 40)).toBeLessThan(3000);
    }
  });
});
