import { umamiApis } from "./api";
import type { UmamiSite } from "./types";

const TTL_MS = 5 * 60 * 1000;

declare global {
  /** Per workspace: each workspace lists the sites of its own Umami connection. */
  var __seopenUmamiSitesByWorkspace: Map<number, { at: number; mode: string; sites: UmamiSite[] }> | undefined;
}

export function forgetUmamiSites(workspaceId: number) {
  globalThis.__seopenUmamiSitesByWorkspace?.delete(workspaceId);
}

/** The sites the workspace's Umami connection can read, cached for five minutes. */
export async function listUmamiSites(workspaceId: number, force = false): Promise<UmamiSite[]> {
  const api = umamiApis(workspaceId);
  const cache = (globalThis.__seopenUmamiSitesByWorkspace ??= new Map());
  const c = cache.get(workspaceId);
  if (!force && c && c.mode === api.mode && Date.now() - c.at < TTL_MS) return c.sites;
  const sites = (await api.sites()).sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain));
  cache.set(workspaceId, { at: Date.now(), mode: api.mode, sites });
  return sites;
}
