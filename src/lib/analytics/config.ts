/**
 * PostHog settings, read from process.env and importing nothing, so src/proxy.ts can use them
 * for the /ingest relay. Without NEXT_PUBLIC_POSTHOG_KEY analytics is off: the app renders no
 * script and the server sends nothing, so local dev and tests need no setup.
 */

/** First-party path the browser sends events to; src/proxy.ts relays it to PostHog. */
export const INGEST_PATH = "/ingest";

const DEFAULT_HOST = "https://us.i.posthog.com";

/** The project key (phc_…), or null when analytics is off. Never set while tests run. */
export function posthogKey(): string | null {
  if (process.env.VITEST) return null;
  return process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;
}

/**
 * The marketing site's own PostHog project key (phc_…), or null when the site sends nothing. A
 * separate project from the app's, so site visits stay out of product analytics and the site's
 * project can be SEOpen's own Analytics source. Never set while tests run.
 */
export function posthogSiteKey(): string | null {
  if (process.env.VITEST) return null;
  return process.env.NEXT_PUBLIC_POSTHOG_SITE_KEY?.trim() || null;
}

/** PostHog's ingestion host: https://us.i.posthog.com (US Cloud) or https://eu.i.posthog.com (EU). */
export function posthogHost(): string {
  return (process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, "");
}

/** Where PostHog serves its lazy-loaded scripts: us.i.posthog.com → us-assets.i.posthog.com. */
export function posthogAssetsHost(host = posthogHost()): string {
  return host.replace(/^https:\/\/(us|eu)\.i\.posthog\.com$/, "https://$1-assets.i.posthog.com");
}

/** The PostHog app, for the toolbar's links: us.i.posthog.com → us.posthog.com. */
export function posthogUiHost(host = posthogHost()): string {
  return host.replace(/^https:\/\/(us|eu)\.i\.posthog\.com$/, "https://$1.posthog.com");
}

/** Whether this copy sends anything to PostHog at all. Unlike the keys above, true in tests when a key is set. */
export function analyticsOn(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_SITE_KEY?.trim());
}

/**
 * The reverse proxy, so ad blockers that drop *.posthog.com requests don't drop our events: where a
 * request under /ingest goes at PostHog, or null when it goes nowhere. src/proxy.ts is the only
 * caller and the only way there, so no request reaches PostHog with headers it did not choose.
 * Null for /ingest itself, for another letter case, and on a copy with analytics off.
 */
export function ingestDestination(pathname: string, search = ""): string | null {
  if (!analyticsOn() || !pathname.startsWith(`${INGEST_PATH}/`)) return null;
  const rest = pathname.slice(INGEST_PATH.length);
  const host = rest.startsWith("/static/") || rest.startsWith("/array/") ? posthogAssetsHost() : posthogHost();
  return `${host}${rest}${search}`;
}
