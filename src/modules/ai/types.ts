/** DataForSEO response fields the ai module reads. Not complete types; only what we use. */

export interface LlmAnnotation {
  title?: string | null;
  url?: string | null;
}

export interface LlmSection {
  type: string;
  text?: string | null;
  annotations?: LlmAnnotation[] | null;
}

export interface LlmItem {
  type: string;
  sections?: LlmSection[] | null;
}

/** `ai_optimization/{platform}/llm_responses/live` and `task_get/{id}` result. */
export interface LlmResponseResult {
  model_name: string;
  input_tokens?: number;
  output_tokens?: number;
  web_search?: boolean;
  /** Token cost charged by the model provider (USD). */
  money_spent?: number;
  datetime?: string;
  items?: LlmItem[] | null;
}

export interface AiOverviewReference {
  domain?: string | null;
  url?: string | null;
  title?: string | null;
  source?: string | null;
}

export interface SerpItem {
  type: string;
  markdown?: string | null;
  text?: string | null;
  references?: AiOverviewReference[] | null;
  items?: SerpItem[] | null;
}

/** `serp/google/organic/task_get/advanced/{id}` result. */
export interface SerpResult {
  keyword: string;
  item_types?: string[] | null;
  items?: SerpItem[] | null;
}

export interface MentionsGroupElement {
  key: string;
  mentions: number;
  ai_search_volume: number | null;
}

export interface MentionsMetrics {
  platform?: MentionsGroupElement[] | null;
  sources_domain?: MentionsGroupElement[] | null;
}

/** `ai_optimization/llm_mentions/{multi_target_metrics,target_metrics}/live` result. */
export interface MultiTargetResult {
  aggregated_metrics?: MentionsMetrics | null;
  items?: (MentionsMetrics & { key: string })[] | null;
}

/** `dataforseo_labs/google/ranked_keywords/live` item (fields we use). */
export interface RankedKeywordItem {
  keyword_data: { keyword: string; keyword_info?: { search_volume?: number | null } | null };
}

/** `dataforseo_labs/google/keywords_for_site/live` item (fields we use). */
export interface SiteKeywordItem {
  keyword: string;
  keyword_info?: { search_volume?: number | null } | null;
}
