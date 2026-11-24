// Response fields the backlinks module uses. Verified against live responses on 2026-10-29.
// DataForSEO "rank" values are on its default 0–1000 scale; spam scores are 0–100.

export interface BacklinksSummary {
  target: string;
  first_seen: string | null;
  rank: number | null;
  backlinks: number;
  backlinks_spam_score: number | null;
  broken_backlinks: number | null;
  referring_domains: number;
  referring_domains_nofollow: number | null;
  referring_main_domains: number | null;
  referring_ips: number | null;
  referring_subnets: number | null;
  referring_pages: number | null;
  referring_links_tld: Record<string, number> | null;
  referring_links_types: Record<string, number> | null;
  referring_links_attributes: Record<string, number> | null;
  referring_links_countries: Record<string, number> | null;
  info: { target_spam_score: number | null } | null;
}

export interface ItemsResult<T> {
  total_count: number;
  items_count: number;
  items: T[] | null;
}

export interface NewLostItem {
  date: string;
  new_backlinks: number;
  lost_backlinks: number;
  new_referring_domains: number;
  lost_referring_domains: number;
}

export interface ReferringDomainItem {
  domain: string;
  rank: number | null;
  backlinks: number;
  first_seen: string | null;
  lost_date: string | null;
  backlinks_spam_score: number | null;
  referring_pages: number | null;
  referring_domains_nofollow: number | null;
  referring_links_tld: Record<string, number> | null;
  referring_links_countries: Record<string, number> | null;
  referring_links_attributes: Record<string, number> | null;
}

export interface BacklinkItem {
  domain_from: string;
  url_from: string;
  url_to: string;
  tld_from: string | null;
  is_new: boolean;
  is_lost: boolean;
  backlink_spam_score: number | null;
  rank: number | null;
  domain_from_rank: number | null;
  domain_from_ip: string | null;
  page_from_title: string | null;
  first_seen: string | null;
  last_seen: string | null;
  item_type: string | null;
  attributes: string[] | null;
  dofollow: boolean;
  anchor: string | null;
  is_broken: boolean;
}

export interface AnchorItem {
  anchor: string;
  backlinks: number;
  referring_domains: number;
  referring_domains_nofollow: number | null;
  backlinks_spam_score: number | null;
  first_seen: string | null;
}

/** One row of domain_intersection: keys are the request's target numbers ("1", "2", …). */
export interface IntersectionItem {
  domain_intersection: Record<string, { target: string; rank: number | null; backlinks: number; backlinks_spam_score: number | null; first_seen: string | null } | null>;
}
