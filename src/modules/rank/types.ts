// DataForSEO response fields the rank module reads. Only what we use, not whole responses.

/** One task in a serp/google/organic/task_post response (result is null on post). */
export interface SerpTaskPostData {
  keyword: string;
  tag?: string;
}

/** serp/google/organic/tasks_ready result. */
export interface TasksReadyResult {
  id: string;
  se: string;
  se_type: string;
  date_posted: string;
  tag: string | null;
  endpoint_advanced: string | null;
}

export interface SerpReference {
  domain?: string | null;
  url?: string | null;
  /** "https://www.example.com › blog › post": the real site when `url` is a google.com/goto link. */
  breadcrumb?: string | null;
}

/** An item in a SERP advanced result. Fields vary by type; all are optional here. */
export interface SerpItem {
  type: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  domain?: string | null;
  url?: string | null;
  title?: string | null;
  /** ai_overview: whether it was loaded asynchronously. */
  asynchronous_ai_overview?: boolean | null;
  references?: SerpReference[] | null;
  /** Nested elements (ai_overview_element, local_pack entries, carousel items…). */
  items?: (SerpReference & { references?: SerpReference[] | null; links?: SerpReference[] | null })[] | null;
  links?: SerpReference[] | null;
}

/** serp/google/organic/task_get/advanced result. */
export interface SerpAdvancedResult {
  keyword: string;
  check_url?: string;
  datetime: string;
  item_types: string[] | null;
  se_results_count?: number | null;
  items: SerpItem[] | null;
}

/** dataforseo_labs/google/keyword_overview/live result. */
export interface KeywordOverviewResult {
  items:
    | {
        keyword: string;
        keyword_info: { search_volume: number | null; cpc: number | null } | null;
        keyword_properties: { keyword_difficulty: number | null } | null;
      }[]
    | null;
}

/** One keyword of keywords_data/google_ads/search_volume. Null when Google shows too few searches to report. */
export interface AdsVolumeResult {
  keyword: string;
  search_volume: number | null;
}
