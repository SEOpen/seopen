import { projectScope, type WorkspaceScope } from "@/lib/workspace";
import { indexingView } from "@/modules/indexing/data";
import { INSPECTIONS_PER_DAY, keyFileUrl } from "@/modules/indexing/state";
import { resolveProject } from "./data";

/**
 * get_indexing: the project's Indexing tab as data (src/modules/indexing). Which
 * sitemap pages Google hasn't indexed, as the worker last found with URL Inspection, each with the
 * Search Console link where the owner presses Request Indexing, plus IndexNow's state. Stored data only.
 */

const NOTE =
  "Pages come from the site's sitemap; the worker inspects up to " +
  `${INSPECTIONS_PER_DAY} a day with Search Console's URL Inspection, so a big site fills in over days. ` +
  "status request_indexing means Google hasn't indexed the page (it may not have found it yet; `advice` says which): the owner opens inspection_link and presses Request Indexing (no API can). " +
  "requested_at is when the owner marked that they pressed Request Indexing; such pages are inspected again a day later. Search Console allows about 10 requests a day. " +
  "fix_first means something stops indexing (noindex, robots.txt, an error status, a redirect), so fix the page before asking. " +
  "IndexNow is for Bing and other engines, not Google.";

const STATUS_KEY = { waiting: "request_indexing", blocked: "fix_first", duplicate: "duplicate", other: "not_indexed", error: "check_failed", unchecked: "not_checked", indexed: "indexed" } as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function indexingData(ws: WorkspaceScope, args: { project?: string | number; limit?: number }) {
  const p = await resolveProject(ws, args.project);
  const v = await indexingView(projectScope(p));
  const limit = args.limit ?? 50;
  const s = v.settings;
  return {
    project: { id: p.id, domain: p.domain },
    search_console: p.gscProperty ? { property: p.gscProperty, inspected_at: iso(s?.inspectedAt), paused: s?.inspectError ?? null } : { connected: false, note: "Map a Search Console property in SEOpen to get the Not indexed list." },
    sitemap: { url: s?.sitemapUrl ?? null, read_at: iso(s?.sitemapReadAt), error: s?.sitemapError ?? null, pages_listed: s?.sitemapPages ?? null },
    counts: {
      pages: v.counts.pages,
      inspected: v.counts.inspected,
      indexed: v.counts.indexed,
      not_indexed: v.counts.notIndexed,
      request_indexing: v.counts.requestIndexing,
      not_checked: v.counts.unchecked,
    },
    not_indexed: v.notIndexed.slice(0, limit).map((x) => ({
      url: x.url,
      status: STATUS_KEY[x.status],
      advice: x.advice,
      coverage: x.coverage,
      last_crawl: iso(x.lastCrawlTime),
      google_canonical: x.googleCanonical,
      inspected_at: iso(x.inspectedAt),
      inspection_link: x.inspectionLink,
      requested_at: iso(x.requestedAt),
    })),
    not_indexed_omitted: Math.max(0, v.notIndexed.length - limit),
    requested_last_24h: v.requestedToday,
    now_indexed: v.nowIndexed.slice(0, limit).map((x) => ({ url: x.url, indexed_at: iso(x.indexedAt) })),
    indexnow: s
      ? {
          enabled: s.indexnowEnabled,
          key_file: keyFileUrl(s.indexnowHost ?? p.domain, s.indexnowKey),
          key_file_found: !!s.indexnowVerifiedAt,
          last_sent_at: iso(s.lastSubmitAt),
          last_sent_count: s.lastSubmitCount,
          waiting_to_send: v.pendingIndexNow,
          error: s.indexnowError,
        }
      : { enabled: false, note: "Not set up yet. The key appears after the project's first indexing check." },
    note: NOTE,
  };
}
