import { readRobots } from "@/lib/web/crawlers";
import { fetchErrorMessage, safeFetch } from "@/lib/web/fetch";
import { sitemapEntries, type SitemapEntry } from "@/lib/web/sitemap";
import { hostOf, MAX_CHILD_SITEMAPS, MAX_PAGES } from "./state";

const SITEMAP_BYTES = 10_000_000;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 5;

export type SitemapRead =
  | { ok: true; sitemapUrl: string; pages: SitemapEntry[]; total: number }
  | { ok: false; sitemapUrl: string | null; error: string };

type Fetch = typeof safeFetch;

async function fetchXml(fetch: Fetch, url: string): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { maxBytes: SITEMAP_BYTES, timeoutMs: TIMEOUT_MS });
    if (r.status !== 200) return { ok: false, error: `${url} answered HTTP ${r.status}.` };
    if (/\.gz$/i.test(new URL(r.url).pathname)) return { ok: false, error: `${url} is gzipped, which isn't read yet.` };
    return { ok: true, body: r.body };
  } catch (err) {
    return { ok: false, error: `${url}: ${fetchErrorMessage(err)}` };
  }
}

/** Where the site's sitemaps are: robots.txt's `Sitemap:` lines, else /sitemap.xml, else /sitemap_index.xml. */
async function findSitemaps(fetch: Fetch, domain: string): Promise<string[]> {
  const origin = `https://${domain}`;
  const robots = await fetch(`${origin}/robots.txt`, { maxBytes: 500_000, timeoutMs: TIMEOUT_MS }).catch(() => null);
  const listed = readRobots(robots).sitemaps.filter((u) => hostOf(u) !== null);
  if (listed.length) return [...new Set(listed)].slice(0, 5);
  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const r = await fetch(`${origin}${path}`, { headOnly: true, timeoutMs: TIMEOUT_MS }).catch(() => null);
    if (r && r.status === 200) return [r.url];
  }
  return [];
}

/**
 * The site's sitemap pages with their `<lastmod>`, the first MAX_PAGES of them, following one level
 * of sitemap index. Never throws: a site with no readable sitemap comes back with why.
 */
export async function readSitemap(domain: string, fetch: Fetch = safeFetch): Promise<SitemapRead> {
  const roots = await findSitemaps(fetch, domain);
  if (!roots.length) return { ok: false, sitemapUrl: null, error: "No sitemap found: robots.txt lists none, and /sitemap.xml isn't there." };

  const pages = new Map<string, SitemapEntry>();
  let total = 0;
  const errors: string[] = [];
  const children: string[] = [];
  const take = (entries: SitemapEntry[]) => {
    for (const e of entries) {
      if (!hostOf(e.loc) || pages.has(e.loc)) continue;
      total++;
      if (pages.size < MAX_PAGES) pages.set(e.loc, e);
    }
  };

  for (const url of roots) {
    const r = await fetchXml(fetch, url);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    const parsed = sitemapEntries(r.body);
    if (parsed.index) children.push(...parsed.entries.map((e) => e.loc));
    else take(parsed.entries);
  }
  const queue = [...new Set(children)].slice(0, MAX_CHILD_SITEMAPS);
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = await Promise.all(queue.slice(i, i + CONCURRENCY).map((u) => fetchXml(fetch, u)));
    for (const r of batch) {
      if (!r.ok) {
        errors.push(r.error);
        continue;
      }
      const parsed = sitemapEntries(r.body);
      // A child that is itself an index isn't followed further.
      if (!parsed.index) take(parsed.entries);
    }
  }

  if (!pages.size) return { ok: false, sitemapUrl: roots[0], error: errors[0] ?? "The sitemap lists no pages." };
  return { ok: true, sitemapUrl: roots[0], pages: [...pages.values()], total };
}
