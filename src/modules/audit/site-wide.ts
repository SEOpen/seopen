import type { Severity } from "./taxonomy";

/**
 * Notices found on nearly every crawled page, such as a low text-to-HTML ratio or a render-blocking
 * script, almost always come from the template every page shares. They are grouped apart in
 * get_audit_issues and on the audit pages, so a new notice on a handful of pages isn't buried under
 * them. Only notices: an error or warning on every page still leads the list. The health score
 * doesn't change.
 */
export const SITE_WIDE_SHARE = 0.9;
/** Fewer flagged pages than this is too small a site to call anything site-wide. */
export const SITE_WIDE_MIN_PAGES = 10;

export const SITE_WIDE_NOTE = "Found on 90% or more of the crawled pages, so it's most likely the template they share: fixing it there fixes every page.";

/** Whether an issue that `count` URLs have, out of `pagesCrawled`, is a site-wide notice. */
export function isSiteWide(issue: { severity: Severity; count: number }, pagesCrawled: number | null | undefined): boolean {
  if (issue.severity !== "notice" || !pagesCrawled) return false;
  return issue.count >= SITE_WIDE_MIN_PAGES && issue.count >= SITE_WIDE_SHARE * pagesCrawled;
}

/** Issues split into the rest and the site-wide notices, each keeping its order. */
export function splitSiteWide<T extends { severity: Severity; count: number }>(rows: readonly T[], pagesCrawled: number | null | undefined): { rest: T[]; siteWide: T[] } {
  const rest: T[] = [];
  const siteWide: T[] = [];
  for (const r of rows) (isSiteWide(r, pagesCrawled) ? siteWide : rest).push(r);
  return { rest, siteWide };
}
