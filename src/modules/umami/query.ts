import type { SourceRow } from "@/lib/ai-referrers";
import type { UmamiLandingRow } from "./types";

/**
 * How SEOpen asks Umami for organic landing pages. Umami's API has no channel filter and no daily
 * breakdown of entry pages (https://docs.umami.is/docs/api-reference/get-website-expanded-metrics
 * lists the filters), so each day is its own pair of requests to
 * `GET /websites/:websiteId/metrics/expanded?type=entry`, filtered to visits that came from a search site.
 */

/**
 * The search sites Umami's Organic Search channel counts, as a regular expression on the referrer's
 * domain. The list is Umami's own `SEARCH_DOMAINS` (src/lib/constants.ts in umami-software/umami:
 * baidu.com, bing.com, duckduckgo.com, ecosia.org, google., msn.com, search.brave.com, yandex.).
 * Written to read the same in Postgres and ClickHouse, the two databases Umami runs on.
 */
export const SEARCH_REFERRER = "(^|\\.)(baidu\\.com|bing\\.com|duckduckgo\\.com|ecosia\\.org|google\\.[a-z.]+|msn\\.com|search\\.brave\\.com|yandex\\.[a-z.]+)$";

/** The same test in JavaScript, for checking a server applies the filter (see `checkUmami` in api.ts). */
export const isSearchReferrer = (domain: string) => new RegExp(SEARCH_REFERRER).test(domain.toLowerCase());

/** Entry pages one request asks for. A full page means there may be another. */
export const PAGE_ROWS = 500;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A UTC day as Umami's `startAt` and `endAt`, both in milliseconds and both inclusive. */
export function dayWindow(day: string): { startAt: number; endAt: number } {
  if (!DAY.test(day)) throw new Error(`Bad day ${day}`);
  const startAt = Date.parse(`${day}T00:00:00Z`);
  return { startAt, endAt: startAt + DAY_MS - 1 };
}

/**
 * One page of a day's entry pages for visits from a search site. `referrer=re.` is Umami's regex
 * operator (`OPERATORS.regex` in its src/lib/constants.ts, parsed in src/lib/params.ts); the public
 * docs list the filter names but not the operators, so a server that doesn't know it would match
 * nothing, which `checkUmami` tests for before a connection is saved. `engaged` adds
 * `excludeBounce`, documented as excluding "visits with only one pageview".
 */
export function organicEntryParams(day: string, offset: number, engaged: boolean): URLSearchParams {
  const { startAt, endAt } = dayWindow(day);
  const p = new URLSearchParams({ type: "entry", startAt: String(startAt), endAt: String(endAt), timezone: "UTC", referrer: `re.${SEARCH_REFERRER}`, limit: String(PAGE_ROWS), offset: String(offset) });
  if (engaged) p.set("excludeBounce", "1");
  return p;
}

/** One row of the expanded metrics response: `name` is the entry path (or referrer domain), `visits` the visits that began there. */
export interface ExpandedRow {
  name?: unknown;
  visits?: unknown;
  bounces?: unknown;
}

/** Referrer pages one AI assistants read follows, at PAGE_ROWS each, before it stops. */
export const SOURCE_PAGES = 4;

/**
 * One page of a range's visits by referrer domain, for "AI assistants" (src/lib/ai-referrers.ts).
 * Umami's referrer metric has no utm_source, so a tagged link that sent no referrer isn't in it.
 */
export function sourceParams(start: string, end: string, offset: number): URLSearchParams {
  const { startAt } = dayWindow(start);
  const { endAt } = dayWindow(end);
  return new URLSearchParams({ type: "referrer", startAt: String(startAt), endAt: String(endAt), timezone: "UTC", limit: String(PAGE_ROWS), offset: String(offset) });
}

/** Referrer rows: engaged visits are the ones that weren't bounces. */
export function parseSourceRows(rows: ExpandedRow[]): SourceRow[] {
  return rows.map((r) => {
    const visits = Number(r.visits) || 0;
    return { sources: [typeof r.name === "string" && r.name ? r.name : null], sessions: visits, engagedSessions: Math.max(0, visits - (Number(r.bounces) || 0)) };
  });
}

/** A host as the Analytics table holds it: lower case, no scheme, port or path. */
export function hostOf(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/:?#].*$/, "");
}

/**
 * A day's rows. Sessions are Umami's visits; engaged sessions are the visits that weren't bounces
 * (more than one pageview). Umami reports a path without its host, so every row is filed under the
 * website's domain. Paths repeated in a response merge.
 */
export function parseDay(day: string, host: string, visits: ExpandedRow[], engaged: ExpandedRow[]): UmamiLandingRow[] {
  const rows = new Map<string, UmamiLandingRow>();
  const page = (r: ExpandedRow) => (typeof r.name === "string" && r.name ? r.name : "(not set)");
  const row = (landingPage: string) => {
    let r = rows.get(landingPage);
    if (!r) rows.set(landingPage, (r = { date: day, hostName: host, landingPage, sessions: 0, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 }));
    return r;
  };
  for (const v of visits) row(page(v)).sessions += Number(v.visits) || 0;
  for (const e of engaged) {
    const r = rows.get(page(e));
    // Engaged visits are a subset, so a path missing from the full list (it moved between pages) can't add any.
    if (r) r.engagedSessions = Math.min(r.sessions, r.engagedSessions + (Number(e.visits) || 0));
  }
  return [...rows.values()].filter((r) => r.sessions > 0);
}
