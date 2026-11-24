import "server-only";
import { headers } from "next/headers";

type Param = string | string[] | undefined;

/**
 * True when SEOpen's own page sent the browser here: `Sec-Fetch-Site: same-origin`. Only SEOpen's Run
 * buttons and forms add `?run=1`, and they are always same-origin. Anything else may be someone else's
 * link: `cross-site` from another site, `same-site` from a sibling host such as the
 * marketing site (whose pages may show third-party URLs), `none` from an email or chat app, and no header from a browser without Fetch
 * Metadata. Each of those carries the SameSite=Lax session cookie on a top-level GET, so none may spend.
 */
export function isSameOrigin(secFetchSite: string | null): boolean {
  return secFetchSite?.trim().toLowerCase() === "same-origin";
}

/** Whether `?run=1` may spend, given the request's `Sec-Fetch-Site`. The pure half of `wantsRun`. */
export function runAllowed(run: Param, secFetchSite: string | null): boolean {
  return (Array.isArray(run) ? run[0] : run) === "1" && isSameOrigin(secFetchSite);
}

/**
 * True when this request asks to spend (`?run=1`) and came from SEOpen itself. Otherwise the page shows
 * as if `run` weren't there, with its Run button and price, so spending takes a press here. Reads the
 * request headers only when `run=1` is asked for.
 */
export async function wantsRun(run: Param): Promise<boolean> {
  if ((Array.isArray(run) ? run[0] : run) !== "1") return false;
  return runAllowed(run, (await headers()).get("sec-fetch-site"));
}
