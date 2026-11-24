import type { ContentMatch, CrawledLink, CrawledPage, CrawledResource, DuplicateGroup, SiteInfo } from "./issues";
import type { DfsContentMatches, DfsDuplicateGroup, DfsLighthouse, DfsLink, DfsPage, DfsResource, DfsSummary } from "./types";

/** On-Page price per crawled page (docs/dataforseo.md §2). The options replace, not add to, the base rate. */
export const PRICE_PER_PAGE = { base: 0.00015, resources: 0.00045, javascript: 0.0015 } as const;
/** Lighthouse price per page, Live or Standard (docs/dataforseo.md §2). */
export const LIGHTHOUSE_PRICE_USD = 0.005;

/** A unit price as the docs write it: 0.00045 → "$0.00045". formatUsd would round it to "$0.0005". */
export const priceText = (usd: number) => `$${usd}`;

export function estimateCrawlCost(opts: { maxPages: number; enableJavascript: boolean; loadResources: boolean }): number {
  const rate = opts.enableJavascript ? PRICE_PER_PAGE.javascript : opts.loadResources ? PRICE_PER_PAGE.resources : PRICE_PER_PAGE.base;
  return Math.max(0, opts.maxPages) * rate;
}

/** Browser-like user agent: the provider's default ("RSiteAuditor") gets blocked by some CDNs. */
export const CRAWL_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 SEOpen/1.0";

export function crawlTaskBody(opts: {
  target: string;
  maxPages: number;
  enableJavascript: boolean;
  loadResources: boolean;
  tag: string;
  acceptLanguage: string;
}) {
  return {
    target: opts.target,
    // Without this the crawler starts at http:// and an HTTP-only firewall rule can sink the whole crawl.
    start_url: `https://${opts.target}/`,
    max_crawl_pages: opts.maxPages,
    load_resources: opts.loadResources || opts.enableJavascript,
    enable_javascript: opts.enableJavascript,
    custom_user_agent: CRAWL_USER_AGENT,
    accept_language: opts.acceptLanguage,
    tag: opts.tag,
  };
}

/** "en" + US → "en-US". The API rejects full header values with q-weights. */
export function acceptLanguage(languageCode: string, countryIso?: string | null): string {
  const lang = languageCode.toLowerCase();
  return countryIso ? `${lang}-${countryIso.toUpperCase()}` : lang;
}

export function toCrawledPage(p: DfsPage): CrawledPage {
  const h1s = (p.meta?.htags?.h1 ?? []).map((s) => s.trim()).filter(Boolean);
  return {
    url: p.url,
    statusCode: p.status_code,
    resourceType: p.resource_type,
    location: p.location ?? null,
    title: p.meta?.title ?? null,
    description: p.meta?.description ?? null,
    h1s,
    canonical: p.meta?.canonical ?? null,
    depth: p.click_depth ?? null,
    wordCount: p.meta?.content?.plain_text_word_count ?? null,
    internalLinksIn: p.meta?.inbound_links_count ?? null,
    loadTimeMs: p.page_timing?.duration_time ?? null,
    waitingTimeMs: p.page_timing?.waiting_time ?? null,
    sizeBytes: p.size ?? null,
    duplicateTitle: !!p.duplicate_title,
    duplicateDescription: !!p.duplicate_description,
    duplicateContent: !!p.duplicate_content,
    checks: p.checks ?? {},
    textRate: p.meta?.content?.plain_text_rate ?? undefined,
    renderBlocking:
      p.meta?.render_blocking_scripts_count != null || p.meta?.render_blocking_stylesheets_count != null
        ? { scripts: p.meta.render_blocking_scripts_count ?? null, stylesheets: p.meta.render_blocking_stylesheets_count ?? null }
        : undefined,
  };
}

/** Database row for audit_pages (minus crawlId and issueCount). */
export function pageRow(p: DfsPage) {
  const c = toCrawledPage(p);
  return {
    url: c.url,
    statusCode: c.statusCode,
    resourceType: c.resourceType,
    title: c.title,
    description: c.description,
    h1: c.h1s[0] ?? null,
    canonical: c.canonical,
    depth: c.depth,
    wordCount: c.wordCount,
    internalLinksOut: p.meta?.internal_links_count ?? null,
    externalLinksOut: p.meta?.external_links_count ?? null,
    internalLinksIn: c.internalLinksIn,
    loadTimeMs: c.loadTimeMs == null ? null : Math.round(c.loadTimeMs),
    sizeBytes: c.sizeBytes,
    onpageScore: p.onpage_score ?? null,
    indexable: null as boolean | null,
    checks: Object.entries(c.checks)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort(),
  };
}

export function toCrawledLink(l: DfsLink): CrawledLink {
  return { fromUrl: l.link_from, toUrl: l.link_to, direction: l.direction ?? null, dofollow: l.dofollow, isBroken: l.is_broken };
}

export function toCrawledResource(r: DfsResource): CrawledResource {
  return { url: r.url, resourceType: r.resource_type ?? null, statusCode: r.status_code };
}

export function toDuplicateGroups(kind: DuplicateGroup["kind"], groups: DfsDuplicateGroup[]): DuplicateGroup[] {
  return groups
    .map((g) => ({ kind, value: g.accumulator ?? null, urls: [...new Set((g.pages ?? []).map((p) => p.url))] }))
    .filter((g) => g.urls.length > 1);
}

/** The most similar other page, or null when DataForSEO lists none. It doesn't document the order, so this looks at them all. */
export function toContentMatch(r: DfsContentMatches | undefined): ContentMatch | null {
  if (!r) return null;
  const listed = (r.pages ?? []).flatMap((p) => (p.page ?? []).map((o) => ({ url: o.url, similarity: p.similarity ?? 0 })));
  const others = listed.filter((o) => o.url !== r.url);
  if (!others.length) return null;
  const best = others.reduce((a, b) => (b.similarity > a.similarity ? b : a));
  const total = (r.total_count ?? 0) - (listed.length - others.length);
  return { url: r.url, matchUrl: best.url, similarity: best.similarity, more: Math.max(total, others.length) - 1 };
}

export function toSiteInfo(s: DfsSummary | null): SiteInfo {
  const d = s?.domain_info;
  const extra = d as unknown as Record<string, unknown> | null | undefined;
  const num = (k: string) => (typeof extra?.[k] === "number" ? (extra[k] as number) : null);
  return {
    checks: d?.checks ?? null,
    validCertificate: d?.ssl_info?.valid_certificate ?? null,
    certificateExpires: d?.ssl_info?.certificate_expiration_date ?? null,
    notFoundStatus: num("page_not_found_status_code"),
    altHostStatus: num("www_redirect_status_code"),
  };
}

const CRAWL_FAILURES: Record<string, string> = {
  site_unreachable: "DataForSEO's crawler could not reach the site. The host may be blocking its IP range, or timing out.",
  invalid_page_status_code: "The start page returned an error status, so the crawler stopped.",
  forbidden_meta_tag: "The start page has a robots meta tag that forbids crawling.",
  forbidden_robots: "robots.txt forbids crawling the site.",
  forbidden_http_header: "The start page sends an X-Robots-Tag header that forbids crawling.",
  too_many_redirects: "The start page redirects too many times.",
};

/** Why a finished crawl produced nothing usable, or null when it's fine to score. */
export function crawlFailureReason(s: DfsSummary): string | null {
  const status = s.domain_info?.extended_crawl_status;
  if (status && CRAWL_FAILURES[status]) return `${CRAWL_FAILURES[status]} (${status})`;
  if (status && status !== "no_errors" && !s.crawl_status?.pages_crawled) return `The crawl stopped: ${status.replace(/_/g, " ")}.`;
  return null;
}

/** The part of the summary worth keeping after the provider deletes the crawl. */
export function summarySubset(s: DfsSummary | null) {
  if (!s) return null;
  const d = s.domain_info;
  const m = s.page_metrics;
  return {
    crawlStopReason: s.crawl_stop_reason ?? null,
    extendedStatus: s.domain_info?.extended_crawl_status ?? null,
    domain: d
      ? {
          cms: d.cms,
          server: d.server,
          ip: d.ip,
          totalPages: d.total_pages,
          crawlStart: d.crawl_start,
          crawlEnd: d.crawl_end,
          ssl: d.ssl_info,
          checks: d.checks,
        }
      : null,
    metrics: m
      ? {
          onpageScore: m.onpage_score,
          linksInternal: m.links_internal,
          linksExternal: m.links_external,
          brokenLinks: m.broken_links,
          brokenResources: m.broken_resources,
          duplicateTitle: m.duplicate_title,
          duplicateDescription: m.duplicate_description,
          duplicateContent: m.duplicate_content,
          nonIndexable: m.non_indexable,
        }
      : null,
  };
}
export type SummarySubset = ReturnType<typeof summarySubset>;

/** Lighthouse JSON → the four category scores (0–100) and the lab metrics we chart. */
export function lighthouseScores(lh: DfsLighthouse) {
  const cat = (k: string) => {
    const v = lh.categories?.[k]?.score;
    return v == null ? null : Math.round(v * 100);
  };
  const audit = (k: string) => lh.audits?.[k]?.numericValue ?? null;
  return {
    performance: cat("performance"),
    accessibility: cat("accessibility"),
    bestPractices: cat("best-practices"),
    seo: cat("seo"),
    metrics: {
      lcp: audit("largest-contentful-paint"),
      fcp: audit("first-contentful-paint"),
      tbt: audit("total-blocking-time"),
      cls: audit("cumulative-layout-shift"),
      si: audit("speed-index"),
      tti: audit("interactive"),
    },
  };
}
