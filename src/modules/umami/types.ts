import type { SourceRow } from "@/lib/ai-referrers";
import type { Ga4LandingRow } from "@/modules/google/types";

/**
 * Umami Cloud's API root, from https://docs.umami.is/docs/api ("you would make calls to
 * https://api.umami.is/v1 using an API key"). A self-hosted server's root is its address plus "/api".
 */
export const UMAMI_CLOUD_API = "https://api.umami.is/v1";

/** A website the connection can read. */
export interface UmamiSite {
  /** Umami's website ID, a UUID. What a project stores. */
  id: string;
  name: string;
  /** The domain entered in Umami, which the landing rows are filed under. */
  domain: string;
}

/** One day of Organic Search visits for a landing page: the GA4 row shape, so every source shares a table. */
export type UmamiLandingRow = Ga4LandingRow;

/** Everything SEOpen asks of Umami. The real client and the fixtures both implement it. */
export interface UmamiApis {
  /** "live" talks to Umami; "fixtures" serves generated data for development. */
  mode: "live" | "fixtures";
  sites(): Promise<UmamiSite[]>;
  site(id: string): Promise<UmamiSite>;
  organicLandingPages(site: UmamiSite, start: string, end: string): Promise<UmamiLandingRow[]>;
  /** Every visit in the range by referrer domain (UTC days). Read live for "AI assistants", never stored. */
  sourceSessions(siteId: string, start: string, end: string): Promise<SourceRow[]>;
}

/** No usable connection: none saved, or Umami stopped accepting the credential. */
export class UmamiNotConnectedError extends Error {
  constructor(readonly reason: "not_connected" | "reauth_required") {
    super(reason === "reauth_required" ? "Umami needs reconnecting" : "Umami is not connected");
  }
}

/** The credential works but can't read this website (outside its user and teams, or deleted). Jobs don't retry, and the connection stays active. */
export class UmamiAccessError extends Error {
  constructor() {
    super("This Umami connection can't reach that website");
  }
}

/** Umami rate-limited the key (HTTP 429; Umami Cloud allows 50 calls every 15 seconds per key). Jobs back off and retry. */
export class UmamiQuotaError extends Error {}

/** A self-hosted server that couldn't be reached: down, private, refused or too slow. `message` is written for the customer. */
export class UmamiUnreachableError extends Error {}

/** A refused response from Umami. `detail` is its own words, with the credential taken out. */
export class UmamiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(`Umami API error ${status}${detail ? `: ${detail}` : ""}`);
  }
}
