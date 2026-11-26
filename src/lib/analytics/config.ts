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
 * What the two PostHog clients (src/components/analytics) ask for, and nothing else: events, and
 * flags should either ever turn them on. Both turn off recordings, surveys and every script PostHog
 * would load (disable_external_dependency_loading), so /s/ and /static/ aren't relayed. A client
 * setting that turns one of those on needs its path added here.
 */
const EVENT_PATHS = new Set(["/e/", "/i/v0/e/", "/batch/", "/flags/", "/decide/"]);

/** This copy's own project keys, the only ones whose remote config is relayed. Read straight from env, as analyticsOn is. */
function ownKeys(): string[] {
  return [process.env.NEXT_PUBLIC_POSTHOG_KEY, process.env.NEXT_PUBLIC_POSTHOG_SITE_KEY].map((k) => k?.trim() ?? "").filter(Boolean);
}

/**
 * The reverse proxy, so ad blockers that drop *.posthog.com requests don't drop our events: where a
 * request under /ingest goes at PostHog, or null when it goes nowhere. src/proxy.ts is the only
 * caller and the only way there, so no request reaches PostHog with headers it did not choose.
 *
 * Whatever PostHog answers is served from this copy's own origin, so only the paths the clients use
 * go on: the event endpoints (GET or POST), and GET of this copy's own project config. Anything else
 * is null: /ingest itself, another letter case, another path or method, another project's key, and
 * every path on a copy with analytics off.
 */
export function ingestDestination(pathname: string, search = "", method = "GET"): string | null {
  if (!analyticsOn() || !pathname.startsWith(`${INGEST_PATH}/`)) return null;
  const rest = pathname.slice(INGEST_PATH.length);
  if (EVENT_PATHS.has(rest)) return method === "GET" || method === "POST" ? `${posthogHost()}${rest}${search}` : null;
  const config = /^\/array\/([^/]+)\/config(?:\.js)?$/.exec(rest);
  if (config && method === "GET" && ownKeys().includes(config[1])) return `${posthogAssetsHost()}${rest}${search}`;
  return null;
}

/**
 * Headers the relay adds to whatever PostHog answers, since it's served from this copy's origin.
 * The clients only read JSON from it, so the answer gets no rights a page would have: a sandbox with
 * nothing allowed, no sniffing past its Content-Type, and no framing.
 */
export const INGEST_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};
