/**
 * Where a SERP result really points. Since early November 2026 DataForSEO returns many organic
 * results as `domain: "google.com"` with a `https://google.com/goto?url=<opaque token>` link,
 * while `breadcrumb` still shows the real site, e.g. "https://www.linkedin.com › services › …".
 * Taking `domain` as-is credits google.com with the ranking and misses the project's own results.
 *
 * For a wrapped result this returns the breadcrumb's origin as both the domain and the URL: the
 * path in a breadcrumb is display text (sometimes cut short with "..."), so it isn't kept as the
 * URL. It comes back as `breadcrumb` instead, with `originOnly: true`, so whoever shows the URL
 * can say it's the site's origin and not the page. Anything else passes through unchanged.
 */
export interface SerpTargetFields {
  domain?: string | null;
  url?: string | null;
  breadcrumb?: string | null;
}

export interface SerpTarget {
  domain: string | null;
  url: string | null;
  /** True when `url` is only the site's origin because Google hid the real link. */
  originOnly: boolean;
  /** For an origin-only result, Google's display path after the origin, e.g. "services › seo". May be cut short. Null otherwise. */
  breadcrumb: string | null;
}

const GOTO = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/goto\?/i;

export function isGoogleRedirect(url: string | null | undefined): boolean {
  return !!url && GOTO.test(url);
}

export function serpTarget(item: SerpTargetFields): SerpTarget {
  const domain = item.domain ?? null;
  const url = item.url ?? null;
  if (!isGoogleRedirect(url)) return { domain, url, originOnly: false, breadcrumb: null };
  const [origin, ...rest] = (item.breadcrumb ?? "").split("›").map((s) => s.trim());
  try {
    const u = new URL(origin ?? "");
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not a web origin");
    const path = rest.filter(Boolean).join(" › ");
    return { domain: u.hostname, url: `${u.origin}/`, originOnly: true, breadcrumb: path || null };
  } catch {
    // No usable breadcrumb: say we don't know rather than crediting google.com.
    return { domain: null, url: null, originOnly: false, breadcrumb: null };
  }
}
