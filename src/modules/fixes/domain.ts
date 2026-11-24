const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * Whether an address belongs to the project: its domain, with or without www, or a subdomain of it.
 * Pure, so the sync and the live checks share it. A stored URL that fails this is never fetched, and
 * an audit finding that fails it never becomes a fix.
 */
export function onProjectDomain(url: string, domain: string): boolean {
  try {
    const host = bareHost(new URL(url).hostname);
    const own = bareHost(domain);
    return host === own || host.endsWith(`.${own}`);
  } catch {
    return false;
  }
}

/**
 * Why a fetch of a project page didn't read that page: it redirected off the project's domain, as a
 * sign-in or access gate in front of the site does (Cloudflare Access sends visitors to its own login).
 * What came back is another site's page, so judging a fix by it would count a login page's title as
 * the change. Null when the fetch stayed on the domain.
 */
export function offSiteReason(fetched: { url: string; redirects?: string[] }, domain: string): string | null {
  if (!fetched.redirects?.length || onProjectDomain(fetched.url, domain)) return null;
  let host = fetched.url;
  try {
    host = new URL(fetched.url).hostname;
  } catch {
    // Keeps the address as it came.
  }
  return `The page redirects to ${host}, which isn't on ${domain}, so SEOpen can't read it. A sign-in or access gate in front of the site does this.`;
}
