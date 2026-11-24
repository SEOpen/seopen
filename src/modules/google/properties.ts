import { googleApis } from "./apis";
import { usableSite } from "./matching";
import { GoogleNotConnectedError, type Ga4Property, type GscSite } from "./types";

const TTL_MS = 5 * 60 * 1000;

type CachedProps = { at: number; sites: GscSite[]; ga4: Ga4Property[]; mode: string };

declare global {
  /** Per workspace: each workspace lists the properties of its own Google connection. */
  var __seopenGooglePropsByWorkspace: Map<number, CachedProps> | undefined;
}

/** Forgets a workspace's cached property list, e.g. after it disconnects Google. */
export function forgetGoogleProperties(workspaceId: number) {
  globalThis.__seopenGooglePropsByWorkspace?.delete(workspaceId);
}

/**
 * Search Console sites and GA4 properties for the workspace's connected account. Cached in memory
 * for five minutes so the mapping UI doesn't hit the Admin API on every render.
 */
export async function listGoogleProperties(workspaceId: number, force = false): Promise<{ sites: GscSite[]; ga4: Ga4Property[] }> {
  const api = await googleApis(workspaceId);
  const cache = (globalThis.__seopenGooglePropsByWorkspace ??= new Map());
  const c = cache.get(workspaceId);
  if (!force && c && c.mode === api.mode && Date.now() - c.at < TTL_MS) return c;
  const [sites, ga4] = await Promise.all([api.gsc.sites(), api.ga4.properties()]);
  sites.sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
  ga4.sort((a, b) => a.propertyName.localeCompare(b.propertyName));
  cache.set(workspaceId, { at: Date.now(), sites, ga4, mode: api.mode });
  return { sites, ga4 };
}

/** What the new project form can offer: the account's properties, a link to connect one, or nothing. */
export type GoogleChoices = { state: "connected"; sites: GscSite[]; ga4: Ga4Property[] } | { state: "connect" } | { state: "hidden" };

/**
 * The properties a new project could link. It never rejects: the page streams this past the form,
 * and a Google failure must not get in the way of creating a project. Without OAuth configured
 * there is nothing to connect to, so that says nothing either.
 */
export async function googleChoices(workspaceId: number): Promise<GoogleChoices> {
  try {
    const { sites, ga4 } = await listGoogleProperties(workspaceId);
    return { state: "connected", sites: sites.filter(usableSite), ga4 };
  } catch (e) {
    if (e instanceof GoogleNotConnectedError) return e.reason === "not_configured" ? { state: "hidden" } : { state: "connect" };
    console.error("[google.choices]", e);
    return { state: "hidden" };
  }
}
