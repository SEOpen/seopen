/** DataForSEO On-Page response fields the audit module reads. Only what we use is typed. */

export interface DfsCrawlStatus {
  max_crawl_pages: number;
  pages_in_queue: number;
  pages_crawled: number;
}

export interface DfsSummary {
  crawl_progress: "in_progress" | "finished";
  crawl_status: DfsCrawlStatus | null;
  crawl_stop_reason?: string | null;
  domain_info: {
    name: string;
    cms: string | null;
    ip: string | null;
    server: string | null;
    crawl_start: string | null;
    crawl_end: string | null;
    total_pages: number | null;
    main_domain?: string | null;
    /** "no_errors", or why the crawl couldn't proceed (e.g. "site_unreachable"). */
    extended_crawl_status?: string | null;
    ssl_info: {
      valid_certificate: boolean | null;
      certificate_issuer: string | null;
      certificate_expiration_date: string | null;
    } | null;
    checks: Record<string, boolean> | null;
  } | null;
  page_metrics: {
    onpage_score: number | null;
    links_internal: number | null;
    links_external: number | null;
    broken_links: number | null;
    broken_resources: number | null;
    duplicate_title: number | null;
    duplicate_description: number | null;
    duplicate_content: number | null;
    non_indexable: number | null;
    checks: Record<string, number> | null;
  } | null;
}

export interface DfsPage {
  resource_type: string;
  status_code: number | null;
  location: string | null;
  url: string;
  meta: {
    title: string | null;
    description: string | null;
    canonical: string | null;
    htags: Record<string, string[]> | null;
    internal_links_count: number | null;
    external_links_count: number | null;
    inbound_links_count: number | null;
    title_length: number | null;
    description_length: number | null;
    content: { plain_text_word_count: number | null; plain_text_rate: number | null } | null;
    render_blocking_scripts_count?: number | null;
    render_blocking_stylesheets_count?: number | null;
  } | null;
  page_timing: { duration_time: number | null; waiting_time: number | null } | null;
  onpage_score: number | null;
  click_depth: number | null;
  size: number | null;
  url_length?: number | null;
  duplicate_title?: boolean | null;
  duplicate_description?: boolean | null;
  duplicate_content?: boolean | null;
  checks: Record<string, boolean | null> | null;
}

export interface DfsItems<T> {
  crawl_progress: string;
  total_items_count: number;
  items_count: number;
  items: T[] | null;
}

export interface DfsLink {
  type: string;
  link_from: string;
  link_to: string;
  direction: "internal" | "external" | string;
  dofollow: boolean | null;
  is_broken: boolean | null;
  text: string | null;
  page_to_status_code?: number | null;
}

export interface DfsResource {
  resource_type: string;
  status_code: number | null;
  url: string;
  size: number | null;
  checks: Record<string, boolean | null> | null;
}

export interface DfsDuplicateGroup {
  accumulator: string | null;
  total_count: number;
  pages: { url: string }[] | null;
}

export interface DfsContentMatches {
  url: string;
  total_count: number | null;
  pages: { similarity: number | null; page: { url: string }[] | null }[] | null;
}

export interface DfsNonIndexable {
  reason: string | null;
  url: string;
}

export interface DfsLighthouse {
  categories?: Record<string, { score: number | null } | undefined>;
  audits?: Record<string, { numericValue?: number | null } | undefined>;
  requestedUrl?: string;
}
