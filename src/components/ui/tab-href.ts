import { docsPath, MODULE_DOCS } from "@/lib/docs";

/**
 * Where a tab goes: its own query, or the page's when it has none. `run` never travels: on /keywords and
 * /backlinks it means "spend now", and a tab must not repeat a paid lookup.
 */
export function tabHref(href: string, search: string): string {
  if (href.includes("?") || !search) return href;
  const q = new URLSearchParams(search);
  q.delete("run");
  const rest = q.toString();
  return rest ? `${href}?${rest}` : href;
}

/** How far the tab row's fade reaches past the scrolling edge, and so how far clear of it the active tab sits. */
export const TAB_FADE_PX = 24;

/** Which edges of a scrolling row have more off-screen. A pixel of slack, because a scroll position can be fractional. */
export function edgeFade(scrollLeft: number, scrollWidth: number, clientWidth: number): "none" | "start" | "end" | "both" {
  const start = scrollLeft > 1;
  const end = scrollLeft + clientWidth < scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

/** Where to scroll a row so a tab sits clear of the fades, moving as little as it can. If the tab can't fit, its start wins. */
export function revealLeft(tabLeft: number, tabWidth: number, scrollLeft: number, clientWidth: number): number {
  const from = tabLeft - TAB_FADE_PX;
  const to = tabLeft + tabWidth + TAB_FADE_PX;
  if (from < scrollLeft || to - from > clientWidth) return Math.max(0, from);
  return to > scrollLeft + clientWidth ? to - clientWidth : scrollLeft;
}

/**
 * The docs page a module's page belongs to, from its path or its tab row's first tab, or null if it
 * has none (src/lib/docs.ts, MODULE_DOCS). It carries no query, so it can't carry `run`.
 * The docs are on the marketing site: the app host sends /docs there.
 */
export function docsHelpHref(path: string | undefined): string | null {
  const section = path?.split("?")[0].split("/")[1];
  return section && Object.hasOwn(MODULE_DOCS, section) ? docsPath(MODULE_DOCS[section]) : null;
}
