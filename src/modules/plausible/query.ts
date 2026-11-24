import type { SourceRow } from "@/lib/ai-referrers";
import type { PlausibleLandingRow } from "./types";

/** The channel Plausible files search visits under: the source is a known search site, or the medium is "organic". */
export const ORGANIC_CHANNEL = "Organic Search";

/** Rows one query asks for, Plausible's default page size. A full page means there may be another. */
export const PAGE_ROWS = 10_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One page of Organic Search visits per landing page per day, in the site's reporting time zone.
 * Imported stats are left out by default, so these are visits Plausible's own script saw.
 */
export function organicLandingQuery(siteId: string, start: string, end: string, offset = 0) {
  if (!DAY.test(start) || !DAY.test(end)) throw new Error(`Bad date range ${start}..${end}`);
  return {
    site_id: siteId,
    metrics: ["visits", "bounce_rate"],
    date_range: [start, end],
    dimensions: ["time:day", "visit:entry_page_hostname", "visit:entry_page"],
    filters: [["is", "visit:channel", [ORGANIC_CHANNEL]]],
    // A fixed order, so pages join up.
    order_by: [
      ["time:day", "asc"],
      ["visit:entry_page_hostname", "asc"],
      ["visit:entry_page", "asc"],
    ],
    pagination: { limit: PAGE_ROWS, offset },
  };
}

export interface QueryRow {
  dimensions?: unknown[];
  metrics?: unknown[];
}

/**
 * Turns a query's rows into landing rows. Sessions are Plausible's visits. "Engaged" means not bounced,
 * worked out from its whole-percent bounce rate, so a large page's figure can be slightly off.
 * Hostnames differing only by case merge, because the table holds one row per lower-cased host.
 */
export function parseLandingRows(results: QueryRow[]): PlausibleLandingRow[] {
  const rows = new Map<string, PlausibleLandingRow>();
  for (const { dimensions = [], metrics = [] } of results) {
    const [day, host, page] = dimensions;
    const date = String(day);
    if (!DAY.test(date)) throw new Error(`Plausible returned a day that isn't a date: ${date}`);
    const hostName = String(host ?? "").toLowerCase();
    const landingPage = page ? String(page) : "(not set)";
    const sessions = Number(metrics[0]) || 0;
    const engagedSessions = Math.round(sessions * (1 - (Number(metrics[1]) || 0) / 100));
    const key = `${date}|${hostName}|${landingPage}`;
    const had = rows.get(key);
    rows.set(key, { date, hostName, landingPage, sessions: sessions + (had?.sessions ?? 0), engagedSessions: engagedSessions + (had?.engagedSessions ?? 0), keyEvents: 0, totalRevenue: 0 });
  }
  return [...rows.values()];
}

/** Sources one AI assistants query reads, the largest first. */
export const SOURCE_ROWS = 10_000;

/**
 * Every visit in the range by `visit:source`, which Plausible takes from a utm_source, source or ref
 * tag, or else the referrer (https://plausible.io/docs/stats-api). It names known sites ("Google")
 * and shows others by domain, so the shared list matches both. Read live for "AI assistants"
 * (src/lib/ai-referrers.ts), never stored.
 */
export function sourceSessionsQuery(siteId: string, start: string, end: string) {
  if (!DAY.test(start) || !DAY.test(end)) throw new Error(`Bad date range ${start}..${end}`);
  return {
    site_id: siteId,
    metrics: ["visits", "bounce_rate"],
    date_range: [start, end],
    dimensions: ["visit:source"],
    order_by: [["visits", "desc"]],
    pagination: { limit: SOURCE_ROWS, offset: 0 },
  };
}

/** The query's rows, engaged worked out from the bounce rate as for landing pages. */
export function parseSourceRows(results: QueryRow[]): SourceRow[] {
  return results.map(({ dimensions = [], metrics = [] }) => {
    const sessions = Number(metrics[0]) || 0;
    const source = dimensions[0];
    return { sources: [typeof source === "string" ? source : null], sessions, engagedSessions: Math.round(sessions * (1 - (Number(metrics[1]) || 0) / 100)) };
  });
}
