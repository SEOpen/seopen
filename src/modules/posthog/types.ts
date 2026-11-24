import type { SourceRow } from "@/lib/ai-referrers";
import type { Ga4LandingRow } from "@/modules/google/types";

/** PostHog Cloud regions. OAuth and the API both live on the region's app host. */
export const REGIONS = { us: "https://us.posthog.com", eu: "https://eu.posthog.com" } as const;
export type Region = keyof typeof REGIONS;

export const isRegion = (v: unknown): v is Region => v === "us" || v === "eu";

/** Read-only: list the granted projects and run aggregate HogQL queries. Nothing else. */
export const SCOPES = ["project:read", "query:read"];

/** The connect flow's routes. The metadata document's URL is SEOpen's OAuth client id (CIMD). */
export const CLIENT_METADATA_PATH = "/api/posthog/client-metadata";
export const CALLBACK_PATH = "/api/posthog/callback";

export interface PosthogProject {
  id: number;
  name: string;
  /** IANA time zone PostHog reports dates in, e.g. "UTC" or "Europe/London". */
  timezone: string;
}

/** One day of organic-search sessions for a landing page: the GA4 row shape, so both sources share a table. */
export type PosthogLandingRow = Ga4LandingRow;

/** Everything SEOpen asks of PostHog. The real client and the fixtures both implement it. */
export interface PosthogApis {
  /** "live" talks to PostHog; "fixtures" serves generated data for development. */
  mode: "live" | "fixtures";
  projects(): Promise<PosthogProject[]>;
  project(id: number): Promise<PosthogProject>;
  organicLandingPages(projectId: number, start: string, end: string): Promise<PosthogLandingRow[]>;
  /** Every session in the range by entry referrer and utm_source. Read live for "AI assistants", never stored. */
  sourceSessions(projectId: number, start: string, end: string): Promise<SourceRow[]>;
}

/**
 * No usable connection: none saved, it needs reconnecting, or OAuth isn't available here (it
 * needs an https app origin PostHog can fetch the client metadata from).
 */
export class PosthogNotConnectedError extends Error {
  constructor(readonly reason: "not_connected" | "reauth_required" | "not_configured") {
    super(
      reason === "reauth_required"
        ? "PostHog needs reconnecting"
        : reason === "not_configured"
          ? "PostHog connections need the app's https address"
          : "PostHog is not connected",
    );
  }
}

/**
 * PostHog refused this project (HTTP 403). The connection works, so it stays active: it may still
 * reach other projects. Only a new grant helps, so jobs don't retry and the panel offers a reconnect.
 */
export class PosthogAccessError extends Error {
  constructor() {
    super("This PostHog connection can't reach that project. Reconnect and grant it");
  }
}

/** PostHog rate-limited the query (HTTP 429); jobs back off and retry. */
export class PosthogQuotaError extends Error {}
