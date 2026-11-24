/** Only the DataForSEO response fields this module reads. */

export interface MonthlySearch {
  year: number;
  month: number;
  search_volume: number | null;
}

export interface KeywordInfo {
  search_volume: number | null;
  cpc: number | null;
  competition: number | null;
  competition_level: "LOW" | "MEDIUM" | "HIGH" | null;
  monthly_searches: MonthlySearch[] | null;
  search_volume_trend?: { monthly: number | null; quarterly: number | null; yearly: number | null } | null;
}

/** The Labs "keyword data" block shared by overview, suggestions, related and ranked keywords. */
export interface KeywordData {
  keyword: string;
  keyword_info: KeywordInfo | null;
  keyword_properties: { keyword_difficulty: number | null } | null;
  search_intent_info: { main_intent: string | null } | null;
  serp_info?: { serp_item_types: string[] | null } | null;
  avg_backlinks_info?: { referring_domains: number | null; backlinks: number | null } | null;
}

export interface KeywordOverviewResult {
  items: KeywordData[] | null;
}

export interface SuggestionsResult {
  total_count: number;
  items: KeywordData[] | null;
}

export interface RelatedResult {
  total_count: number;
  items: { depth: number; keyword_data: KeywordData }[] | null;
}

export interface SerpItem {
  type: string;
  rank_group: number;
  rank_absolute: number;
  domain?: string | null;
  url?: string | null;
  /** The real site when `url` is a google.com/goto link (src/lib/dataforseo/serp-target.ts). */
  breadcrumb?: string | null;
  title?: string | null;
  description?: string | null;
  is_featured_snippet?: boolean;
  references?: { domain: string; url: string; title: string | null }[] | null;
  /** An AI Overview's parts, which carry their own references. */
  items?: { references?: { domain: string; url: string; title: string | null }[] | null }[] | null;
}

export interface SerpResult {
  keyword: string;
  datetime: string;
  check_url: string;
  item_types: string[] | null;
  se_results_count: number | null;
  items: SerpItem[] | null;
}
