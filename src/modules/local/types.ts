// DataForSEO Google Maps response fields the local module reads. Only what we use, not whole responses.

/** serp/google/maps/tasks_ready result. */
export interface TasksReadyResult {
  id: string;
  tag: string | null;
}

/** An item in a serp/google/maps advanced result. Fields vary by type; all are optional here. */
export interface MapsItem {
  type: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  title?: string | null;
  domain?: string | null;
  url?: string | null;
  address?: string | null;
  phone?: string | null;
  category?: string | null;
  additional_categories?: string[] | null;
  rating?: { value?: number | null; votes_count?: number | null } | null;
  cid?: string | null;
  place_id?: string | null;
  feature_id?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** serp/google/maps live/advanced and task_get/advanced result. */
export interface MapsResult {
  keyword?: string;
  check_url?: string | null;
  datetime?: string | null;
  items_count?: number | null;
  items?: MapsItem[] | null;
}
