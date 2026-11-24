import { getOAuthState } from "better-auth/api";
import { z } from "zod";
import { arrival } from "./arrival";
import { FIRST_VISIT_PARAMS } from "./first-visit-capture";
import { siteOrigin, splitHosts } from "./hosts";
import { signupOpen } from "./signup-open";

/**
 * Where a self sign-up's first visit to the site came from. The site notes it in memory
 * and its sign-up links carry it to /sign-up (src/lib/first-visit-capture.ts); the sign-up form sends
 * it with the email sign-up, or through Google's round trip in Better Auth's OAuth state, and the
 * user create hook in src/lib/auth/index.ts keeps it on the new account. Only then: a later sign-in
 * makes no account, so it never changes what's there.
 *
 * Every value comes from the browser, so each is checked again here and cut to fit, never refused:
 * a bad value is no reason to stop someone signing up.
 */

export interface FirstVisit {
  source: string | null;
  referrerHost: string | null;
  landingPath: string | null;
}

/** Our own hosts and any under them, which never count as a site that linked to us. */
function ownHost(host: string): boolean {
  const hosts = splitHosts();
  const ours = [new URL(siteOrigin()).hostname, ...(hosts ? [hosts.site, hosts.app] : [])];
  return ours.some((o) => host === o || host.endsWith(`.${o}`));
}

const referrerHost = arrival(253)
  .transform((s) => s?.toLowerCase() ?? null)
  .transform((s) => (s && /^[a-z0-9.-]+$/.test(s) && !ownHost(s) ? s : null));

/** A site path, as the waitlist's `fromPath` takes it, cut to 200 characters first. */
const landingPath = z
  .string()
  .trim()
  .transform((s) => s.slice(0, 200))
  .pipe(z.string().regex(/^\/[\w\-/.]*$/))
  .nullish()
  .catch(null)
  .transform((s) => s ?? null);

const firstVisitInput = z
  .object({ source: arrival(100), referrerHost, landingPath })
  .catch({ source: null, referrerHost: null, landingPath: null });

/** A first visit from anything the browser sent: an object with the three fields, or nothing usable. */
export function readFirstVisit(raw: unknown): FirstVisit {
  return firstVisitInput.parse(raw && typeof raw === "object" ? raw : {});
}

/** A first visit from /sign-up's query parameters. */
export function firstVisitFromParams(params: Record<string, string | string[] | undefined>): FirstVisit {
  const one = (key: string) => {
    const v = params[key];
    return typeof v === "string" ? v : undefined;
  };
  return readFirstVisit({ source: one(FIRST_VISIT_PARAMS.source), referrerHost: one(FIRST_VISIT_PARAMS.referrerHost), landingPath: one(FIRST_VISIT_PARAMS.landingPath) });
}

/** The users columns a new account gets. */
export function firstVisitColumns(raw: unknown) {
  const v = readFirstVisit(raw);
  return { firstSource: v.source, firstReferrerHost: v.referrerHost, firstLandingPath: v.landingPath };
}

/**
 * What Better Auth's user create hook adds to a new account, by the endpoint making it (`path`, as
 * `refuseTakenInbox` takes it). An email sign-up sends the visit in its body. Google's callback finds
 * it in the OAuth state the sign-up page started: Better Auth keeps that state in its verifications
 * table for ten minutes, keyed by the short-lived state cookie it already sets, so nothing new is
 * stored in the browser. A Google ID token posted to /sign-in/social brings it in `additionalData`.
 * Invites and admin accounts have no path and get nothing, and so does everything with sign-up closed.
 */
export async function firstVisitOnCreate(path: string | undefined, body: unknown): Promise<Partial<ReturnType<typeof firstVisitColumns>>> {
  if (!signupOpen() || !path) return {};
  const sent = (body && typeof body === "object" ? body : {}) as { firstVisit?: unknown; additionalData?: { firstVisit?: unknown } };
  if (path === "/sign-up/email") return firstVisitColumns(sent.firstVisit);
  if (path === "/sign-in/social") return firstVisitColumns(sent.additionalData?.firstVisit);
  if (path.startsWith("/callback/")) {
    // Outside Better Auth's request scope there is no state, and it throws; that's no visit.
    const state = (await getOAuthState().catch(() => null)) as { firstVisit?: unknown } | null;
    return firstVisitColumns(state?.firstVisit);
  }
  return {};
}
