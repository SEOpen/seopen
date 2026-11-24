import { missingAltDetail, type ImagesWithoutAlt } from "./image-alt";
import { ISSUES } from "./taxonomy";

/** A crawled page in the shape the detector needs (see transform.ts for how it's built). */
export interface CrawledPage {
  url: string;
  statusCode: number | null;
  resourceType: string;
  location: string | null;
  title: string | null;
  description: string | null;
  h1s: string[];
  canonical: string | null;
  depth: number | null;
  wordCount: number | null;
  internalLinksIn: number | null;
  loadTimeMs: number | null;
  waitingTimeMs: number | null;
  sizeBytes: number | null;
  duplicateTitle: boolean;
  duplicateDescription: boolean;
  duplicateContent: boolean;
  /** Provider checks as returned (true, false or null). */
  checks: Record<string, boolean | null>;
  /** The images the audit's own fetch found with no alt attribute, when it fetched the page. */
  imagesWithoutAlt?: ImagesWithoutAlt;
  /** Visible text as a share of the HTML, 0 to 1 (DataForSEO's plain_text_rate). */
  textRate?: number;
  /** Scripts and stylesheets in the head that hold up the first paint. */
  renderBlocking?: { scripts: number | null; stylesheets: number | null };
}

export interface CrawledLink {
  fromUrl: string;
  toUrl: string;
  direction: string | null;
  dofollow: boolean | null;
  isBroken: boolean | null;
}

export interface CrawledResource {
  url: string;
  resourceType: string | null;
  statusCode: number | null;
}

export interface DuplicateGroup {
  kind: "title" | "description";
  value: string | null;
  urls: string[];
}

/** The page most similar to a flagged page, from on_page/duplicate_content. */
export interface ContentMatch {
  url: string;
  matchUrl: string;
  /** DataForSEO's score, 0 to 10. */
  similarity: number;
  /** How many other pages also count as similar. */
  more: number;
}

export interface SiteInfo {
  checks: Record<string, boolean> | null;
  validCertificate: boolean | null;
  certificateExpires: string | null;
  /** Status the server returns for a made-up URL. */
  notFoundStatus: number | null;
  /** Status the alternate host (www vs non-www) returns. */
  altHostStatus: number | null;
}

export interface CrawlInput {
  target: string;
  pages: CrawledPage[];
  links: CrawledLink[];
  resources: CrawledResource[];
  duplicates: DuplicateGroup[];
  contentMatches: ContentMatch[];
  nonIndexable: { url: string; reason: string | null }[];
  site: SiteInfo;
  /** Reference time for the certificate-expiry check; defaults to now. */
  now?: Date;
}

export interface IssueRow {
  code: string;
  url: string;
  detail: string | null;
}

/** Provider checks mapped 1:1 onto our codes. `when` is the value that means "problem". */
const CHECK_MAP: { check: string; code: string; when: boolean }[] = [
  { check: "no_title", code: "missing-title", when: true },
  { check: "no_description", code: "missing-description", when: true },
  { check: "title_too_long", code: "title-too-long", when: true },
  { check: "title_too_short", code: "title-too-short", when: true },
  { check: "duplicate_meta_tags", code: "duplicate-meta-tags", when: true },
  { check: "no_h1_tag", code: "missing-h1", when: true },
  { check: "low_content_rate", code: "low-text-ratio", when: true },
  { check: "no_image_alt", code: "missing-alt", when: true },
  { check: "lorem_ipsum", code: "placeholder-text", when: true },
  { check: "https_to_http_links", code: "links-to-http", when: true },
  { check: "high_waiting_time", code: "slow-server-response", when: true },
  { check: "high_loading_time", code: "slow-page", when: true },
  { check: "no_content_encoding", code: "no-compression", when: true },
  { check: "large_page_size", code: "heavy-page", when: true },
  { check: "size_greater_than_3mb", code: "html-too-large", when: true },
  { check: "frame", code: "frames", when: true },
  { check: "no_doctype", code: "no-doctype", when: true },
  { check: "has_meta_refresh_redirect", code: "meta-refresh", when: true },
  { check: "redirect_chain", code: "redirect-chain", when: true },
  { check: "canonical_to_broken", code: "canonical-to-broken", when: true },
  { check: "canonical_to_redirect", code: "canonical-to-redirect", when: true },
  { check: "recursive_canonical", code: "canonical-loop", when: true },
  { check: "canonical_chain", code: "canonical-to-redirect", when: true },
  { check: "has_micromarkup_errors", code: "structured-data-errors", when: true },
  // has_micromarkup is only reliable with validate_micromarkup on (unpriced), so "no structured data" isn't reported.
  { check: "canonical", code: "missing-canonical", when: false },
  { check: "no_encoding_meta_tag", code: "no-charset", when: true },
  { check: "has_render_blocking_resources", code: "render-blocking", when: true },
  { check: "has_links_to_redirects", code: "links-to-redirects", when: true },
  { check: "low_readability_rate", code: "low-readability", when: true },
  // Only the character and parameter sub-checks: the umbrella seo_friendly_url also fails
  // clean URLs that don't repeat the title's keywords, which isn't what this issue is about.
  { check: "seo_friendly_url_characters_check", code: "unfriendly-url", when: false },
  { check: "seo_friendly_url_dynamic_check", code: "unfriendly-url", when: false },
  { check: "no_favicon", code: "no-favicon", when: true },
];

/** Below this many words a page counts as thin. */
export const THIN_CONTENT_WORDS = 200;
export const DEEP_PAGE_DEPTH = 3;
export const LONG_URL_CHARS = 200;
export const CERT_WARNING_DAYS = 21;

function pageDetail(code: string, p: CrawledPage): string | null {
  switch (code) {
    case "title-too-long":
    case "title-too-short":
      return p.title != null ? `${p.title.length} characters` : null;
    case "slow-server-response":
      return p.waitingTimeMs != null ? `${Math.round(p.waitingTimeMs)} ms to first byte` : null;
    case "slow-page":
      return p.loadTimeMs != null ? `${Math.round(p.loadTimeMs)} ms` : null;
    case "heavy-page":
    case "html-too-large":
      return p.sizeBytes != null ? `${Math.round(p.sizeBytes / 1024)} KB` : null;
    case "canonical-to-broken":
    case "canonical-to-redirect":
    case "canonical-loop":
      return p.canonical;
    case "missing-alt":
      return p.imagesWithoutAlt ? missingAltDetail(p.imagesWithoutAlt) : null;
    case "low-text-ratio":
      return p.textRate != null ? `${(p.textRate * 100).toFixed(1)}% of the HTML is text` : null;
    case "render-blocking":
      return renderBlockingDetail(p.renderBlocking);
    default:
      return null;
  }
}

/** "2 scripts, 1 stylesheet", or null when the crawl didn't count them. */
function renderBlockingDetail(r: CrawledPage["renderBlocking"]): string | null {
  if (!r) return null;
  const parts = [r.scripts ? `${r.scripts} ${r.scripts === 1 ? "script" : "scripts"}` : null, r.stylesheets ? `${r.stylesheets} ${r.stylesheets === 1 ? "stylesheet" : "stylesheets"}` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** on_page/non_indexable reasons that mean the owner kept the page out of search. "attribute" and "too_many_redirects" don't. */
const OUT_OF_SEARCH_REASONS = new Set(["robots_txt", "meta_tag", "http_header"]);
const withoutSlash = (url: string) => url.replace(/\/$/, "");

function matchDetail(m: ContentMatch | undefined): string | null {
  if (!m) return null;
  return `${m.matchUrl} (${m.similarity} of 10${m.more > 0 ? `, +${m.more} more` : ""})`;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Turns a crawl into issue rows, one per (code, URL). Pure: no I/O. */
export function detectIssues(input: CrawlInput): IssueRow[] {
  const out = new Map<string, IssueRow>();
  const add = (code: string, url: string, detail: string | null = null) => {
    if (!ISSUES[code]) throw new Error(`Unknown issue code ${code}`);
    const key = `${code}\u0000${url}`;
    if (!out.has(key)) out.set(key, { code, url, detail });
  };

  const matches = new Map(input.contentMatches.map((m) => [m.url, m]));

  for (const p of input.pages) {
    const s = p.statusCode ?? 0;
    if (s === 0 && p.resourceType === "broken") add("unreachable", p.url);
    else if (s >= 500) add("http-5xx", p.url, String(s));
    else if (s >= 400) add("http-4xx", p.url, String(s));
    else if (s === 302 || s === 303 || s === 307) add("temporary-redirect", p.url, p.location ? `${s} → ${p.location}` : String(s));
    else if (s === 301 || s === 308) add("permanent-redirect", p.url, p.location ? `${s} → ${p.location}` : String(s));
    if (p.checks.redirect_chain === true) add("redirect-chain", p.url);

    if (p.resourceType !== "html" || s < 200 || s >= 300) continue;

    for (const m of CHECK_MAP) {
      if (p.checks[m.check] === m.when) add(m.code, p.url, pageDetail(m.code, p));
    }
    if (p.url.startsWith("http://")) add("not-https", p.url);
    if (p.wordCount != null && p.wordCount < THIN_CONTENT_WORDS) add("thin-content", p.url, String(p.wordCount));
    if (p.h1s.length > 1) add("multiple-h1", p.url, String(p.h1s.length));
    if (p.title && p.h1s[0] && norm(p.title) === norm(p.h1s[0])) add("title-equals-h1", p.url);
    if (p.depth != null && p.depth > DEEP_PAGE_DEPTH) add("deep-page", p.url, String(p.depth));
    if (p.url.length > LONG_URL_CHARS) add("long-url", p.url, String(p.url.length));
    if (p.depth != null && p.depth > 0 && p.internalLinksIn != null) {
      if (p.internalLinksIn === 0 || p.checks.is_orphan_page === true) add("orphan-page", p.url);
      else if (p.internalLinksIn === 1) add("single-inlink", p.url);
    }
    if (p.duplicateContent) add("duplicate-content", p.url, matchDetail(matches.get(p.url)));
  }

  // Duplicate titles and descriptions: prefer the grouped data (it carries the shared value).
  const grouped = new Set<string>();
  for (const g of input.duplicates) {
    if (g.urls.length < 2) continue;
    const code = g.kind === "title" ? "duplicate-title" : "duplicate-description";
    grouped.add(code);
    for (const url of g.urls) add(code, url, g.value);
  }
  for (const p of input.pages) {
    if (!grouped.has("duplicate-title") && p.duplicateTitle) add("duplicate-title", p.url, p.title);
    if (!grouped.has("duplicate-description") && p.duplicateDescription) add("duplicate-description", p.url, p.description);
  }

  for (const n of input.nonIndexable) add("non-indexable", n.url, n.reason?.replace(/_/g, " ") ?? null);

  // A nofollow link to a page deliberately kept out of search costs nothing, so it isn't a finding.
  const outOfSearch = new Set(input.nonIndexable.filter((n) => OUT_OF_SEARCH_REASONS.has(n.reason ?? "")).map((n) => withoutSlash(n.url)));

  // Links: one row per source page, naming the first broken target and how many more.
  const linkGroups = new Map<string, string[]>();
  for (const l of input.links) {
    const internal = l.direction === "internal";
    const code = l.isBroken ? (internal ? "broken-internal-links" : "broken-external-links") : internal && l.dofollow === false && !outOfSearch.has(withoutSlash(l.toUrl)) ? "nofollow-internal" : null;
    if (!code) continue;
    const key = `${code}\u0000${l.fromUrl}`;
    const list = linkGroups.get(key) ?? [];
    if (!list.includes(l.toUrl)) list.push(l.toUrl);
    linkGroups.set(key, list);
  }
  for (const [key, targets] of linkGroups) {
    const [code, url] = key.split("\u0000");
    add(code, url, targets.length > 1 ? `${targets[0]} (+${targets.length - 1} more)` : targets[0]);
  }

  for (const r of input.resources) {
    if ((r.statusCode ?? 0) >= 400) add("broken-resources", r.url, `${r.statusCode} ${r.resourceType ?? ""}`.trim());
  }

  // Site-wide checks, reported against the homepage.
  const home = `https://${input.target}/`;
  const site = input.site;
  if (site.validCertificate === false) add("invalid-certificate", home);
  if (site.certificateExpires) {
    const days = (new Date(site.certificateExpires).getTime() - (input.now ?? new Date()).getTime()) / 86_400_000;
    if (Number.isFinite(days) && days < CERT_WARNING_DAYS) add("certificate-expiring", home, site.certificateExpires.slice(0, 10));
  }
  if (site.checks?.sitemap === false) add("no-sitemap", home);
  if (site.checks?.robots_txt === false) add("no-robots-txt", home);
  if (site.notFoundStatus != null && site.notFoundStatus >= 200 && site.notFoundStatus < 300) add("soft-404", home, String(site.notFoundStatus));
  if (site.altHostStatus != null && site.altHostStatus >= 200 && site.altHostStatus < 300) add("host-not-canonical", home, String(site.altHostStatus));

  return [...out.values()];
}
