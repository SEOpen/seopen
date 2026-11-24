/**
 * The marketing site's last check before an event leaves for PostHog (posthog-js `before_send`).
 * The site runs PostHog in cookieless mode for one job: which pages visitors land on and where they
 * came from, which is what an Analytics source needs (organic sessions per landing page). So only
 * page views and page leaves go out, page addresses lose their query and hash, and referrers keep
 * only their origin. Campaign tags (utm_*) arrive as their own properties, so the channel survives.
 * Imports only the URL helpers, so the unit test needs no browser.
 */
import { cleanUrl, type PostHogEvent } from "./sanitize";

const EVENTS = new Set(["$pageview", "$pageleave"]);
const URL_KEYS = new Set(["$current_url", "$session_entry_url", "$initial_current_url"]);
const REFERRER_KEYS = new Set(["$referrer", "$session_entry_referrer", "$initial_referrer"]);

/** A referrer down to its origin; PostHog's "$direct" (no referrer) passes as it is. */
function referrerOrigin(value: unknown): unknown {
  if (typeof value !== "string" || value === "$direct") return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function sanitizeSiteEvent<T extends PostHogEvent>(event: T | null): T | null {
  if (!event || !EVENTS.has(event.event)) return null;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    if (URL_KEYS.has(key)) properties[key] = typeof value === "string" ? cleanUrl(value) : null;
    else if (REFERRER_KEYS.has(key)) properties[key] = referrerOrigin(value);
    else properties[key] = value;
  }
  const out: T = { ...event, properties };
  // Cookieless mode keeps no person, so there's nothing to set on one.
  delete out.$set;
  delete out.$set_once;
  return out;
}
