import type { SourceRow } from "@/lib/ai-referrers";
import type { Ga4LandingRow } from "@/modules/google/types";

/** Plausible Cloud. Fixed on purpose: a customer-supplied address would need server-side request forgery protection. */
export const PLAUSIBLE_ORIGIN = "https://plausible.io";

/** A site the connection's key can read. */
export interface PlausibleSite {
  /** The site's domain as added to Plausible, which is also its site ID in the API. */
  domain: string;
  /** IANA time zone Plausible reports the site's dates in. */
  timezone: string;
}

/** One day of Organic Search visits for a landing page: the GA4 row shape, so every source shares a table. */
export type PlausibleLandingRow = Ga4LandingRow;

/** Everything SEOpen asks of Plausible. The real client and the fixtures both implement it. */
export interface PlausibleApis {
  /** "live" talks to Plausible; "fixtures" serves generated data for development. */
  mode: "live" | "fixtures";
  sites(): Promise<PlausibleSite[]>;
  site(id: string): Promise<PlausibleSite>;
  organicLandingPages(siteId: string, start: string, end: string): Promise<PlausibleLandingRow[]>;
  /** Every visit in the range by source. Read live for "AI assistants", never stored. */
  sourceSessions(siteId: string, start: string, end: string): Promise<SourceRow[]>;
}

/** No usable connection: none saved, or Plausible stopped accepting the key. */
export class PlausibleNotConnectedError extends Error {
  constructor(readonly reason: "not_connected" | "reauth_required") {
    super(reason === "reauth_required" ? "Plausible needs reconnecting" : "Plausible is not connected");
  }
}

/**
 * The key works but can't read this: a site outside its team, or an account without the Stats API
 * (HTTP 402, a plan without it or a lapsed subscription). Only the customer can change either, so
 * jobs don't retry, and the connection stays active.
 */
export class PlausibleAccessError extends Error {
  constructor(readonly reason: "site" | "plan") {
    super(reason === "plan" ? "This Plausible account doesn't include the Stats API, or its subscription has lapsed" : "This Plausible key can't reach that site");
  }
}

/** Plausible rate-limited the key (HTTP 429, 600 requests an hour by default); jobs back off and retry. */
export class PlausibleQuotaError extends Error {}

/** A refused response from Plausible. `detail` is its own words, with the key taken out. */
export class PlausibleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(`Plausible API error ${status}${detail ? `: ${detail}` : ""}`);
  }
}
