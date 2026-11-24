import { TTL } from "@/lib/dataforseo/client";
import type { DfsSpec } from "@/modules/keywords/dfs";
import { labsCost, type Market } from "@/modules/keywords/requests";

/** Row limits offered for ranked keywords. The overview, keywords and gap pages share the cache per limit. */
export const KEYWORD_LIMITS = [100, 500, 1000] as const;
export const DEFAULT_KEYWORD_LIMIT = 500;
export const PAGES_LIMIT = 100;
export const COMPETITORS_LIMIT = 50;
export const HISTORY_MONTHS = 24;

const base = (target: string, m: Market) => ({ target, location_code: m.locationCode, language_code: m.languageCode });

export function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  return (KEYWORD_LIMITS as readonly number[]).includes(n) ? n : DEFAULT_KEYWORD_LIMIT;
}

/** What a Run button said this lookup would cost, sent with its click. `lookup` names what was priced. */
export function priceQuote(lookup: string, usd: number) {
  return `${lookup}|${usd.toFixed(6)}`;
}

/**
 * Whether a click may spend what's pending now. Saved results can expire while a page sits open, so
 * "cached, free" or 15 credits can be out of date by the click: then nothing is spent and the page
 * shows the new price. A different lookup typed into the form had its own price on the button.
 */
export function withinQuote(quote: string | undefined, lookup: string, pendingUsd: number) {
  if (!quote) return true;
  const cut = quote.lastIndexOf("|");
  if (quote.slice(0, cut) !== lookup) return true;
  const quoted = Number(quote.slice(cut + 1));
  return Number.isFinite(quoted) && pendingUsd <= quoted + 1e-6;
}

export function rankOverviewSpec(target: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/domain_rank_overview/live",
    task: base(target, m),
    ttlSeconds: TTL.week,
    estUsd: labsCost(1),
    module: "domains",
  };
}

/** First day of the month `HISTORY_MONTHS` ago, so the cache key changes at most monthly. */
export function historyFrom(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, 1));
  return d.toISOString().slice(0, 10);
}

export function historySpec(target: string, m: Market, now = new Date()): DfsSpec {
  return {
    path: "dataforseo_labs/google/historical_rank_overview/live",
    task: { ...base(target, m), date_from: historyFrom(now) },
    ttlSeconds: TTL.month,
    // Historical endpoints bill 10× the Labs rate per month returned.
    estUsd: 0.12 + 0.0012 * (HISTORY_MONTHS + 1),
    module: "domains",
  };
}

/** Current and recently lost organic rankings, highest traffic first. The API default also returns paid items. */
export function rankedKeywordsSpec(target: string, m: Market, limit = DEFAULT_KEYWORD_LIMIT): DfsSpec {
  return {
    path: "dataforseo_labs/google/ranked_keywords/live",
    task: {
      ...base(target, m),
      limit,
      item_types: ["organic"],
      historical_serp_mode: "all",
      order_by: ["ranked_serp_element.serp_item.etv,desc"],
    },
    ttlSeconds: TTL.week,
    estUsd: labsCost(limit),
    module: "domains",
  };
}

export function pagesSpec(target: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/relevant_pages/live",
    task: { ...base(target, m), limit: PAGES_LIMIT, order_by: ["metrics.organic.etv,desc"] },
    ttlSeconds: TTL.week,
    estUsd: labsCost(PAGES_LIMIT),
    module: "domains",
  };
}

export function competitorsSpec(target: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/competitors_domain/live",
    task: { ...base(target, m), limit: COMPETITORS_LIMIT, exclude_top_domains: true, order_by: ["intersections,desc"] },
    ttlSeconds: TTL.week,
    estUsd: labsCost(COMPETITORS_LIMIT),
    module: "domains",
  };
}
