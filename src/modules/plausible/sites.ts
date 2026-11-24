import { plausibleApis } from "./api";
import type { PlausibleSite } from "./types";

const TTL_MS = 5 * 60 * 1000;

declare global {
  /** Per workspace: each workspace lists the sites of its own Plausible connection. */
  var __seopenPlausibleSitesByWorkspace: Map<number, { at: number; mode: string; sites: PlausibleSite[] }> | undefined;
}

export function forgetPlausibleSites(workspaceId: number) {
  globalThis.__seopenPlausibleSitesByWorkspace?.delete(workspaceId);
}

/** The sites the workspace's Plausible key can read, cached for five minutes. */
export async function listPlausibleSites(workspaceId: number, force = false): Promise<PlausibleSite[]> {
  const api = plausibleApis(workspaceId);
  const cache = (globalThis.__seopenPlausibleSitesByWorkspace ??= new Map());
  const c = cache.get(workspaceId);
  if (!force && c && c.mode === api.mode && Date.now() - c.at < TTL_MS) return c.sites;
  const sites = (await api.sites()).sort((a, b) => a.domain.localeCompare(b.domain));
  cache.set(workspaceId, { at: Date.now(), mode: api.mode, sites });
  return sites;
}
