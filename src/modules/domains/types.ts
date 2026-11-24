import type { KeywordData } from "@/modules/keywords/types";

/** Only the DataForSEO Labs response fields this module reads. */

export interface OrganicMetrics {
  pos_1: number;
  pos_2_3: number;
  pos_4_10: number;
  pos_11_20: number;
  pos_21_30: number;
  pos_31_40: number;
  pos_41_50: number;
  pos_51_60: number;
  pos_61_70: number;
  pos_71_80: number;
  pos_81_90: number;
  pos_91_100: number;
  etv: number;
  count: number;
  estimated_paid_traffic_cost: number | null;
  is_new: number;
  is_up: number;
  is_down: number;
  is_lost: number;
}

export interface RankOverviewResult {
  items: { metrics: { organic: OrganicMetrics | null } }[] | null;
}

export interface HistoryResult {
  items: { year: number; month: number; metrics: { organic: OrganicMetrics | null } }[] | null;
}

export interface RankedSerpItem {
  type: string;
  rank_group: number;
  rank_absolute: number;
  url: string | null;
  relative_url: string | null;
  etv: number | null;
  estimated_paid_traffic_cost: number | null;
  rank_changes: {
    previous_rank_absolute: number | null;
    is_new: boolean;
    is_up: boolean;
    is_down: boolean;
  } | null;
}

export interface RankedKeywordItem {
  keyword_data: KeywordData;
  ranked_serp_element: {
    serp_item: RankedSerpItem;
    serp_item_types: string[] | null;
    keyword_difficulty: number | null;
    is_lost: boolean;
  };
}

export interface RankedKeywordsResult {
  total_count: number;
  metrics: { organic: OrganicMetrics | null } | null;
  items: RankedKeywordItem[] | null;
}

export interface PagesResult {
  total_count: number;
  items: { page_address: string; metrics: { organic: OrganicMetrics | null } }[] | null;
}

export interface CompetitorsResult {
  total_count: number;
  items:
    | {
        domain: string;
        avg_position: number;
        intersections: number;
        full_domain_metrics: { organic: OrganicMetrics | null } | null;
        /** The target's metrics on the shared keywords. */
        metrics: { organic: OrganicMetrics | null } | null;
        /** The competitor's metrics on the shared keywords. */
        competitor_metrics: { organic: OrganicMetrics | null } | null;
      }[]
    | null;
}
