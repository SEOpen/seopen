import type { SourceRow } from "@/lib/ai-referrers";
import type { PosthogLandingRow } from "./types";

/** PostHog's channel for unpaid search-engine visits, as in its Web analytics. */
export const ORGANIC_CHANNEL = "Organic Search";

/** Rows one query may return. Past it, the range is split (see organicLandingPages in api.ts). */
export const ROW_LIMIT = 50_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Organic-search sessions per landing page per day, in the project's time zone (HogQL converts
 * timestamps to it). The wide timestamp bounds let ClickHouse skip partitions; the date test is exact.
 * "Engaged" means not bounced, PostHog's nearest match to GA4's engaged session.
 */
export function organicLandingQuery(start: string, end: string): string {
  if (!DAY.test(start) || !DAY.test(end)) throw new Error(`Bad date range ${start}..${end}`);
  return `SELECT toString(toDate($start_timestamp)) AS day, lower($entry_hostname) AS host, $entry_pathname AS page,
  count() AS sessions, countIf(NOT $is_bounce) AS engaged
FROM sessions
WHERE $start_timestamp >= toDateTime('${start} 00:00:00') - INTERVAL 1 DAY
  AND $start_timestamp < toDateTime('${end} 00:00:00') + INTERVAL 2 DAY
  AND toDate($start_timestamp) >= toDate('${start}') AND toDate($start_timestamp) <= toDate('${end}')
  AND $channel_type = '${ORGANIC_CHANNEL}'
GROUP BY day, host, page
ORDER BY day, host, page
LIMIT ${ROW_LIMIT}`;
}

/** Turns the query's result rows into landing rows; a session with no entry path counts as "(not set)", as in GA4. */
export function parseLandingRows(results: unknown[][]): PosthogLandingRow[] {
  return results.map(([day, host, page, sessions, engaged]) => ({
    date: String(day),
    hostName: String(host ?? "").toLowerCase(),
    landingPage: page ? String(page) : "(not set)",
    sessions: Number(sessions) || 0,
    engagedSessions: Number(engaged) || 0,
    keyEvents: 0,
    totalRevenue: 0,
  }));
}

/** Source groups one AI assistants query reads, the largest first. */
export const SOURCE_ROWS = 10_000;

/**
 * Every session in the range by where it came from: the entry referrer's domain and the entry
 * utm_source, the two things PostHog's own channel types are worked out from. Read live for
 * "AI assistants" (src/lib/ai-referrers.ts), never stored.
 */
export function sourceSessionsQuery(start: string, end: string): string {
  if (!DAY.test(start) || !DAY.test(end)) throw new Error(`Bad date range ${start}..${end}`);
  return `SELECT lower($entry_referring_domain) AS referrer, lower($entry_utm_source) AS utm_source,
  count() AS sessions, countIf(NOT $is_bounce) AS engaged
FROM sessions
WHERE $start_timestamp >= toDateTime('${start} 00:00:00') - INTERVAL 1 DAY
  AND $start_timestamp < toDateTime('${end} 00:00:00') + INTERVAL 2 DAY
  AND toDate($start_timestamp) >= toDate('${start}') AND toDate($start_timestamp) <= toDate('${end}')
GROUP BY referrer, utm_source
ORDER BY sessions DESC
LIMIT ${SOURCE_ROWS}`;
}

/** The query's rows: the referrer decides, then the utm_source. PostHog's "$direct" is no referrer. */
export function parseSourceRows(results: unknown[][]): SourceRow[] {
  const text = (v: unknown) => (typeof v === "string" && v && v !== "$direct" ? v : null);
  return results.map(([referrer, utm, sessions, engaged]) => ({ sources: [text(referrer), text(utm)], sessions: Number(sessions) || 0, engagedSessions: Number(engaged) || 0 }));
}
