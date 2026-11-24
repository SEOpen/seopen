/**
 * Sitemap parsing shared by the site audit, the fix live check and the public tools. It lives in
 * core, not `src/modules/tools/` (cloud only), so the open-source tree can build. Pure, no I/O.
 */
import { decodeEntities } from "@/lib/web/html";

/** `<loc>`s from a sitemap or a sitemap index. */
export function sitemapLocs(xml: string): { index: boolean; locs: string[] } {
  const index = /<sitemapindex\b/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
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
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[1]);
    entries.push({ loc: decodeEntities(loc[1]), lastmod: lastmod ? lastmod[1] : null });
  }
  return { index, entries };
}
