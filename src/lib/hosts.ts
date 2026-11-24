/**
 * The marketing site and the app share one deploy. With SEOPEN_SITE_HOST and SEOPEN_APP_HOST
 * both set (production only), next.config.ts sends app paths on the site host to the app host
 * (the proxy never runs there), and proxy.ts sends everything but the app on the app host back
 * to the site host. Without them (local dev, previews) one host serves everything.
 * Reads process.env directly and imports nothing, so next.config.ts and the proxy can use it.
 */

export type Hosts = { site: string; app: string };

export function splitHosts(): Hosts | null {
  const site = process.env.SEOPEN_SITE_HOST?.trim().toLowerCase();
  const app = process.env.SEOPEN_APP_HOST?.trim().toLowerCase();
  return site && app ? { site, app } : null;
}

/**
 * Every top-level path that belongs to the app: the folders of `(app)`, `(admin)`, `(auth)` and `api`
 * (except `/api/public`, the marketing site's free tools), plus `/login` and `/ingest` (the
 * PostHog proxy, a rewrite in next.config.ts) and the two OAuth discovery documents in `.well-known`.
 * The app's `/` is the dashboard and is handled separately. Everything else is the marketing site's,
 * so a new marketing page needs no registration here. hosts.test.ts checks this list against the folders.
 */
export const APP_PREFIXES = [
  "/admin", "/agents", "/ai", "/audit", "/backlinks", "/billing", "/dev", "/domains", "/fixes", "/ga4", "/gsc",
  "/keywords", "/local", "/projects", "/rank", "/settings",
  "/connect", "/forgot-password", "/ingest", "/login", "/reset-password", "/set-password", "/sign-in", "/sign-up", "/verify-email",
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
  "/api/auth", "/api/billing", "/api/cron", "/api/email", "/api/google", "/api/mcp", "/api/posthog", "/api/projects", "/api/webhooks",
] as const;

/** Whole segments only, so `/rank` never catches `/rankings`. */
export function isAppPath(pathname: string): boolean {
  return APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The site's absolute origin for crawler files, email links and the MCP server's website, which need
 * full URLs even when hosts aren't split. SEOPEN_SITE_HOST alone names a single-host copy's address
 * without splitting anything; unset, it is the app's own address (appOrigin), never another copy's.
 */
export function siteOrigin(): string {
  const host = process.env.SEOPEN_SITE_HOST?.trim().toLowerCase();
  return host ? `https://${host}` : appOrigin();
}

/**
 * The beta waitlist the auth pages point to while sign-up is closed: the form on the hosted service's
 * home page. Null on a copy without the marketing site, or at any other address.
 */
export function waitlistHref(): string | null {
  if (!siteLinks()) return null;
  const host = process.env.SEOPEN_SITE_HOST?.trim().toLowerCase();
  return !host || host === "getseopen.com" ? `${siteHref("/")}#waitlist` : null;
}

/**
 * Whether this copy has the marketing site to link to: home, privacy, terms and the waitlist. A
 * self-hosted copy has none of those pages (next.config.ts sets SEOPEN_HAS_SITE at build time).
 */
export function siteLinks(): boolean {
  return process.env.SEOPEN_HAS_SITE === "1";
}

/** A marketing page's address: absolute on the site host once hosts are split, relative otherwise. */
export function siteHref(path: string): string {
  const hosts = splitHosts();
  const target = path === "/landing" ? "/" : path;
  if (hosts) return `https://${hosts.site}${target}`;
  return path === "/" ? "/landing" : path;
}

/** The app's absolute origin, for links that leave the app (Stripe's return URLs, emails). */
export function appOrigin(): string {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const hosts = splitHosts();
  return hosts ? `https://${hosts.app}` : "http://127.0.0.1:4100";
}

/** An app page's address: absolute on the app host once hosts are split, relative otherwise. */
export function appHref(path: string): string {
  const hosts = splitHosts();
  return hosts ? `https://${hosts.app}${path}` : path;
}
