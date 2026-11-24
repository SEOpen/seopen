import { posthogApis } from "./api";
import type { PosthogProject } from "./types";

const TTL_MS = 5 * 60 * 1000;

declare global {
  /** Per workspace: each workspace lists the projects of its own PostHog connection. */
  var __seopenPosthogProjectsByWorkspace: Map<number, { at: number; mode: string; projects: PosthogProject[] }> | undefined;
}

export function forgetPosthogProjects(workspaceId: number) {
  globalThis.__seopenPosthogProjectsByWorkspace?.delete(workspaceId);
}

/** The projects the workspace's PostHog connection can read, cached for five minutes. */
export async function listPosthogProjects(workspaceId: number, force = false): Promise<PosthogProject[]> {
  const api = posthogApis(workspaceId);
  const cache = (globalThis.__seopenPosthogProjectsByWorkspace ??= new Map());
  const c = cache.get(workspaceId);
  if (!force && c && c.mode === api.mode && Date.now() - c.at < TTL_MS) return c.projects;
  const projects = (await api.projects()).sort((a, b) => a.name.localeCompare(b.name));
  cache.set(workspaceId, { at: Date.now(), mode: api.mode, projects });
  return projects;
}
