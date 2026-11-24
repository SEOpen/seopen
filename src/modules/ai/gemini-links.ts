/**
 * Gemini links each source it cites through a Google redirect
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) that stops working after a while and
 * names the real site only in the title. When an answer comes in, each redirect is asked once where it
 * leads, and the citation is stored under that page instead.
 *
 * Only the redirect itself is requested, never the page it points at: one GET to Google through
 * `safeFetch` (public addresses only, checked after DNS), no redirects followed, stopped after the
 * headers, with a short deadline. A run has a cap on lookups. Anything that goes wrong leaves the
 * citation as Gemini gave it, so `readCitation` still files it under the site its title names.
 */
import pLimit from "p-limit";
import type { AiCitation } from "@/db/schema/ai";
import { safeFetch } from "@/lib/web/fetch";
import { cleanUrl, hostOf, isGeminiRedirect, looksLikeDomain } from "./detect";

/** Lookups one run makes at most. A run's Gemini answers cite about ten pages each. */
export const MAX_LOOKUPS_PER_RUN = 300;
/** Each lookup's whole deadline. */
const LOOKUP_TIMEOUT_MS = 4000;
/** Lookups at once for one answer. */
const LOOKUP_CONCURRENCY = 4;
/** Longer addresses aren't stored. */
const MAX_URL_LENGTH = 2048;

/** Where a redirect leads, or null when it can't be told. Never throws. */
export type RedirectLookup = (url: string) => Promise<string | null>;

/** The address a redirect's Location header gives, when it's a page worth storing. */
export function redirectTarget(location: string | undefined, from: string): string | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.username || target.password || !target.hostname.includes(".")) return null;
  const url = cleanUrl(target.toString());
  if (url.length > MAX_URL_LENGTH || isGeminiRedirect(url)) return null;
  return url;
}

/** Asks Google where one redirect leads, without going there. */
export const lookUpRedirect: RedirectLookup = async (url) => {
  try {
    const res = await safeFetch(url, { headOnly: true, maxRedirects: 0, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (res.status < 300 || res.status >= 400) return null;
    const location = res.headers.location;
    return redirectTarget(Array.isArray(location) ? location[0] : location, url);
  } catch {
    return null;
  }
};

export interface GeminiLinks {
  /** The citations with each Gemini redirect it could follow replaced by the page, deduped by address. Never throws. */
  resolve(citations: AiCitation[]): Promise<AiCitation[]>;
  /** Lookups made so far. */
  readonly lookups: number;
}

/** One run's resolver: a cap on lookups across its answers, and each redirect looked up once. */
export function geminiLinks({ maxLookups = MAX_LOOKUPS_PER_RUN, lookUp = lookUpRedirect }: { maxLookups?: number; lookUp?: RedirectLookup } = {}): GeminiLinks {
  const known = new Map<string, Promise<string | null>>();
  let lookups = 0;
  const limit = pLimit(LOOKUP_CONCURRENCY);
  const target = (url: string): Promise<string | null> => {
    const seen = known.get(url);
    if (seen) return seen;
    if (lookups >= maxLookups) return Promise.resolve(null);
    lookups++;
    const p = lookUp(url).catch(() => null);
    known.set(url, p);
    return p;
  };
  return {
    get lookups() {
      return lookups;
    },
    async resolve(citations) {
      if (!citations.some((c) => isGeminiRedirect(c.url))) return citations;
      const out = await Promise.all(
        citations.map((c) =>
          isGeminiRedirect(c.url) ? limit(async () => followed(c, await target(c.url))) : c,
        ),
      );
      const seen = new Set<string>();
      return out.filter((c) => !seen.has(c.url) && !!seen.add(c.url));
    },
  };
}

/**
 * A Gemini citation stored under the page it leads to. Its title was often only the site's name
 * ("shopfinder.example"), which says nothing the address doesn't, so that kind of title goes.
 */
function followed(c: AiCitation, url: string | null): AiCitation {
  if (!url) return c;
  return { url, domain: hostOf(url), title: c.title && !looksLikeDomain(c.title) ? c.title : null };
}
