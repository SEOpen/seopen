/**
 * Sitemap parsing shared by the site audit, the fix live check and the public tools. It lives in
 * core, not `src/modules/tools/` (cloud only), so the open-source tree can build. Pure, no I/O.
 *
 * The XML comes from any site, so nothing here may take more than linear time (src/lib/web/html.ts).
 */
import { decodeEntities, elements } from "@/lib/web/html";

/** The sitemap protocol's longest URL: a `<loc>` has to be shorter than 2,048 characters. A longer one is left out. */
const MAX_LOC = 2_048;
const fits = (loc: string) => loc.length < MAX_LOC;

/** `<loc>`s from a sitemap or a sitemap index. */
export function sitemapLocs(xml: string): { index: boolean; locs: string[] } {
  const index = /<sitemapindex\b/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1])).filter(fits);
  return { index, locs };
}

export interface SitemapEntry {
  loc: string;
  /** `<lastmod>` as written, or null when the entry has none. */
  lastmod: string | null;
}

/** Each `<url>` (or, in an index, each `<sitemap>`) with its `<lastmod>`. */
export function sitemapEntries(xml: string): { index: boolean; entries: SitemapEntry[] } {
  const index = /<sitemapindex\b/i.test(xml);
  const tag = index ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  for (const { inner } of elements(xml, [tag])) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(inner);
    const url = loc ? decodeEntities(loc[1]) : "";
    if (!url || !fits(url)) continue;
    entries.push({ loc: url, lastmod: /<lastmod>([^<]*)<\/lastmod>/i.exec(inner)?.[1].trim() || null });
  }
  return { index, entries };
}
