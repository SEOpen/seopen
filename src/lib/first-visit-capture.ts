/**
 * Where a visitor's first page on the site came from, kept in this module's memory and nowhere else:
 * the privacy page promises the site stores nothing in the browser (no cookie, nothing in local or
 * session storage). Moving between site pages keeps the module, so the first visit survives a
 * browse; a reload or a new tab starts again, and that is accepted. The site's sign-up links carry
 * it to the app's /sign-up as query parameters (FirstVisitLinks), and src/lib/first-visit.ts checks
 * it there before the new account keeps it.
 *
 * No imports, so the site's bundle gets only this.
 */

/** The query parameters on the app's /sign-up link. */
export const FIRST_VISIT_PARAMS = { source: "src", referrerHost: "ref_host", landingPath: "landing" } as const;

export interface CapturedVisit {
  /** utm_source, or ref when there's no utm_source. */
  source: string | null;
  /** The other site that linked here: its host only, and never one of ours. */
  referrerHost: string | null;
  /** The site page it landed on, without its query. */
  landingPath: string;
}

let first: CapturedVisit | null = null;

/** Whether `host` is one of ours: one of `own`, or under one, so app.site-a.example counts with site-a.example. */
export function isOwnHost(host: string, own: readonly string[]): boolean {
  const h = host.toLowerCase();
  return own.some((o) => {
    const mine = o.toLowerCase();
    return Boolean(mine) && (h === mine || h.endsWith(`.${mine}`));
  });
}

/** What a page load says about where it came from. `own` is our hosts besides the page's own. */
export function readVisit(href: string, referrer: string, own: readonly string[]): CapturedVisit {
  const url = new URL(href);
  const ours = [url.hostname, ...own];
  let referrerHost: string | null = null;
  try {
    const host = referrer ? new URL(referrer).hostname : "";
    if (host && !isOwnHost(host, ours)) referrerHost = host;
  } catch {}
  return {
    source: url.searchParams.get("utm_source")?.trim() || url.searchParams.get("ref")?.trim() || null,
    referrerHost,
    landingPath: url.pathname,
  };
}

/** Records the first page load's visit, once: later calls keep the first and return it. */
export function captureFirstVisit(href: string, referrer: string, own: readonly string[]): CapturedVisit {
  first ??= readVisit(href, referrer, own);
  return first;
}

/** The visit recorded so far, or null before the first page load has run. */
export const firstVisit = (): CapturedVisit | null => first;

/**
 * `href` with the first visit added, when it's a link to /sign-up on one of our hosts. Anything else,
 * and a link that already carries a value, comes back unchanged.
 */
export function withFirstVisit(href: string, own: readonly string[]): string {
  if (!first) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.pathname !== "/sign-up" || !isOwnHost(url.hostname, own)) return href;
  const values: [string, string | null][] = [
    [FIRST_VISIT_PARAMS.source, first.source],
    [FIRST_VISIT_PARAMS.referrerHost, first.referrerHost],
    [FIRST_VISIT_PARAMS.landingPath, first.landingPath],
  ];
  for (const [key, value] of values) if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  return url.toString();
}
