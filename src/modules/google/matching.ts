/**
 * Pure helpers that match projects to Search Console sites and GA4 properties, and join GA4
 * landing pages to GSC page URLs. No database or network access, so they are unit-tested.
 */

export interface GscSite {
  /** "sc-domain:alphanote.example" or "https://www.alphanote.example/" */
  siteUrl: string;
  permissionLevel: string;
}

export interface Ga4Property {
  /** "properties/123456789" */
  property: string;
  propertyName: string;
  account: string;
  accountName: string;
  /** Hostnames of the property's web data streams, when known. */
  streamDomains: string[];
}

/** Same rules as normalizeDomain in src/lib/projects.ts, kept here so this file stays pure. */
export function bareDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^sc-domain:/, "").replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  return s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Domain a GSC property covers: "sc-domain:x.com" and "https://www.x.com/" both give "x.com". */
export function siteDomain(siteUrl: string): string {
  return bareDomain(siteUrl);
}

export function isDomainProperty(siteUrl: string): boolean {
  return siteUrl.startsWith("sc-domain:");
}

/** A property in plain words: "sc-domain:x.com" is "x.com", "https://www.x.com/" is "www.x.com", "properties/123" is "GA4 property 123". */
export function propertyName(property: string): string {
  if (property.startsWith("properties/")) return `GA4 property ${property.slice("properties/".length)}`;
  return property.replace(/^sc-domain:/, "").replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}

/** A Search Console site in a list where "x.com" and "https://x.com/" can both appear, so the two stay apart. */
export function siteLabel(siteUrl: string): string {
  return isDomainProperty(siteUrl) ? `${propertyName(siteUrl)} (whole domain)` : siteUrl;
}

/** GSC rejects queries for unverified sites. */
export function usableSite(site: GscSite): boolean {
  return site.permissionLevel !== "siteUnverifiedUser";
}

/**
 * How well a GSC property fits a project domain (0 = no match). A Domain property covers every
 * subdomain and protocol, so it wins; a URL-prefix property on the root path comes next; a
 * prefix with a path ("https://x.com/blog/") only covers part of the site.
 */
export function scoreGscMatch(projectDomain: string, siteUrl: string): number {
  const want = bareDomain(projectDomain);
  const host = siteDomain(siteUrl);
  if (isDomainProperty(siteUrl)) {
    if (host === want) return 100;
    if (want.endsWith(`.${host}`)) return 60;
    return 0;
  }
  if (host !== want) return 0;
  const path = siteUrl.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const https = siteUrl.startsWith("https://");
  if (path === "" || path === "/") return https ? 90 : 80;
  return 40;
}

export function suggestGscProperty(projectDomain: string, sites: GscSite[]): string | null {
  let best: { siteUrl: string; score: number } | null = null;
  for (const s of sites) {
    if (!usableSite(s)) continue;
    const score = scoreGscMatch(projectDomain, s.siteUrl);
    if (score > 0 && (!best || score > best.score)) best = { siteUrl: s.siteUrl, score };
  }
  return best?.siteUrl ?? null;
}

/** A choice someone made in a property list, and the address it was made for. */
export interface PropertyPick {
  domain: string;
  value: string;
}

/**
 * What a property list on the new project form shows: the person's own choice while the address is
 * the one they chose it for, otherwise the best match. "" is None. A new address gets a new match,
 * so a site picked for one address is never linked to another.
 */
export function currentPick(domain: string, own: PropertyPick | null, suggested: string | null): string {
  return own && own.domain === bareDomain(domain) ? own.value : (suggested ?? "");
}

/** Stream hostnames are the reliable signal; the display name is a fallback ("alphanote.example - GA4"). */
export function scoreGa4Match(projectDomain: string, p: Ga4Property): number {
  const want = bareDomain(projectDomain);
  const streams = p.streamDomains.map(bareDomain);
  if (streams.includes(want)) return 100;
  if (streams.some((s) => s.endsWith(`.${want}`) || want.endsWith(`.${s}`))) return 70;
  const name = p.propertyName.toLowerCase();
  const label = want.split(".")[0];
  if (name.includes(want)) return 50;
  if (label.length >= 4 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(name)) return 30;
  return 0;
}

export function suggestGa4Property(projectDomain: string, props: Ga4Property[]): string | null {
  let best: { property: string; score: number } | null = null;
  for (const p of props) {
    const score = scoreGa4Match(projectDomain, p);
    if (score > 0 && (!best || score > best.score)) best = { property: p.property, score };
  }
  return best?.property ?? null;
}

/**
 * GSC sites that no project covers yet, one per domain (a Domain property beats URL-prefix
 * variants of the same host). Used by "Import projects from Search Console".
 */
export function planImport(
  projects: { domain: string; gscProperty: string | null }[],
  sites: GscSite[],
): { domain: string; siteUrl: string }[] {
  const mapped = new Set(projects.map((p) => p.gscProperty).filter(Boolean));
  const covered = new Set(projects.map((p) => bareDomain(p.domain)));
  const byDomain = new Map<string, { siteUrl: string; score: number }>();
  for (const s of sites) {
    if (!usableSite(s) || mapped.has(s.siteUrl)) continue;
    const domain = siteDomain(s.siteUrl);
    if (!domain || covered.has(domain)) continue;
    const score = scoreGscMatch(domain, s.siteUrl);
    const prev = byDomain.get(domain);
    if (!prev || score > prev.score) byDomain.set(domain, { siteUrl: s.siteUrl, score });
  }
  return [...byDomain.entries()]
    .map(([domain, v]) => ({ domain, siteUrl: v.siteUrl }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * The subset of an import plan the user ticked, each with its chosen GA4 property. Anything not in
 * the current plan (already imported, no access, tampered form) is dropped, and a GA4 choice the
 * account can't see falls back to none.
 */
export function selectImports(
  plan: { domain: string; siteUrl: string }[],
  selected: string[],
  ga4Choice: (siteUrl: string) => string | null | undefined,
  ga4: Ga4Property[],
): { domain: string; siteUrl: string; ga4Property: string | null }[] {
  const want = new Set(selected);
  const known = new Set(ga4.map((g) => g.property));
  return plan
    .filter((item) => want.has(item.siteUrl))
    .map((item) => {
      const choice = ga4Choice(item.siteUrl);
      return { ...item, ga4Property: choice && known.has(choice) ? choice : null };
    });
}

/**
 * Join key for a page across GSC and GA4: host without "www.", path without query, fragment
 * or trailing slash. GSC gives absolute URLs; GA4 gives hostName + landingPage separately.
 */
export function pageKey(urlOrHost: string, path?: string): string {
  let host: string;
  let p: string;
  if (path === undefined) {
    const m = urlOrHost.match(/^[a-z]+:\/\/([^/?#]+)([^?#]*)/i);
    if (!m) return urlOrHost;
    host = m[1];
    p = m[2] || "/";
  } else {
    host = urlOrHost;
    p = path.split(/[?#]/)[0] || "/";
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return `${host}${p}`;
}
