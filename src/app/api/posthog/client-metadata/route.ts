import { NextResponse } from "next/server";
import { clientMetadata } from "@/modules/posthog/oauth";

/**
 * SEOpen's PostHog OAuth client: its URL is the client id, and PostHog fetches it at consent.
 * Public (proxy.ts lets it through), never redirected, and small.
 */
export function GET() {
  return NextResponse.json(clientMetadata(), { headers: { "cache-control": "public, max-age=3600" } });
}
