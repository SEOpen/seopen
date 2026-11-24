import type { SourceRow } from "@/lib/ai-referrers";
import type { Ga4Property, GscSite } from "./matching";

export type { Ga4Property, GscSite };

/** Read-only: Google verification wants the narrowest scope, so SEOpen doesn't submit sitemaps. */
export const SCOPE_WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
/** The full scope that connections made before 2026-10-29 hold; it covers everything read-only does. */
export const SCOPE_WEBMASTERS_FULL = "https://www.googleapis.com/auth/webmasters";
export const SCOPE_ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
/** Scopes asked for at connect. `openid email` only identify the connected account. */
export const SCOPES = ["openid", "email", SCOPE_WEBMASTERS, SCOPE_ANALYTICS];
export const REQUIRED_SCOPES = [SCOPE_WEBMASTERS, SCOPE_ANALYTICS];

export type GscDimension = "date" | "query" | "page" | "country" | "device";

/** One of Search Console's dimension filters. Country takes the lowercase ISO alpha-3 code it reports, such as "usa". */
export interface GscFilter {
  dimension: "country" | "device" | "query" | "page";
  /** includingRegex takes RE2 syntax. */
  operator: "equals" | "contains" | "includingRegex";
  expression: string;
}

export interface GscQueryRequest {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  dataState?: "final" | "all";
  /** All must match. */
  filters?: GscFilter[];
  /** Stop reading pages once this many rows are in. Rows come most clicks first. */
  maxRows?: number;
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryResult {
  rows: GscRow[];
  /** Only with dataState "all" grouped by date. */
  firstIncompleteDate?: string | null;
}

export interface GscSitemap {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  type: string | null;
  errors: number;
  warnings: number;
  submitted: number;
}

export interface GscInspection {
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  crawledAs: string | null;
  inspectionResultLink: string | null;
  richResults: unknown;
}

export interface Ga4LandingRow {
  date: string;
  hostName: string;
  landingPage: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  totalRevenue: number;
}

/** Everything the module asks of Google. The real client and the fixtures both implement it. */
export interface GoogleApis {
  /** "live" talks to Google; "fixtures" serves generated data for development. */
  mode: "live" | "fixtures";
  gsc: {
    sites(): Promise<GscSite[]>;
    query(siteUrl: string, req: GscQueryRequest): Promise<GscQueryResult>;
    sitemaps(siteUrl: string): Promise<GscSitemap[]>;
    inspect(siteUrl: string, url: string): Promise<GscInspection>;
  };
  ga4: {
    properties(): Promise<Ga4Property[]>;
    organicLandingPages(property: string, start: string, end: string): Promise<Ga4LandingRow[]>;
    /** Every session in the range by `sessionSource` (a referrer host, or the utm_source when a link has one). Read live for "AI assistants", never stored. */
    sourceSessions(property: string, start: string, end: string): Promise<SourceRow[]>;
    /** IANA time zone the property reports dates in, e.g. "America/New_York". */
    timeZone(property: string): Promise<string>;
  };
}

/** No connected account, or the account needs to reconnect. Pages show a connect callout. */
export class GoogleNotConnectedError extends Error {
  constructor(public reason: "not_configured" | "not_connected" | "reauth_required") {
    super(
      reason === "not_configured"
        ? "Google OAuth isn't configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty in the env file."
        : reason === "reauth_required"
          ? "Google access was revoked or expired. Reconnect Google."
          : "No Google account is connected.",
    );
    this.name = "GoogleNotConnectedError";
  }
}

/** Search Console and GA4 return one "quota exceeded" error for every quota; back off. */
export class GoogleQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleQuotaError";
  }
}
