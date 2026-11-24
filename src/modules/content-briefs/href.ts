import type { PageType } from "./types";

/**
 * The link any screen uses to start a brief: Keyword research, AI visibility → Actions, and later a
 * page's refresh panel. It opens the create form with the price; nothing is bought until the button
 * on that page is pressed, so the link never carries `run`.
 */
export function newBriefHref(keyword: string, opts: { pageType?: PageType; from?: string } = {}): string {
  const qs = new URLSearchParams({ q: keyword.trim() });
  if (opts.pageType) qs.set("type", opts.pageType);
  if (opts.from) qs.set("from", opts.from);
  return `/keywords/briefs/new?${qs.toString()}`;
}

/** The keywords merged into the page, one per line or comma. */
export function splitKeywords(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter(Boolean);
}
