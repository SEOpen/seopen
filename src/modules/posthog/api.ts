import { fixtureApis as googleFixtures } from "@/modules/google/fixtures";
import { addDays, daysBetween } from "@/modules/google/windowing";
import { fixtureMode, posthogAccessToken, rejectPosthogToken, type PosthogAccount } from "./account";
import { organicLandingQuery, parseLandingRows, parseSourceRows, ROW_LIMIT, sourceSessionsQuery } from "./hogql";
import { PosthogAccessError, PosthogNotConnectedError, PosthogQuotaError, REGIONS, type PosthogApis, type PosthogLandingRow, type PosthogProject } from "./types";

/** Fixture projects, each borrowing a GA4 fixture property's generated organic traffic. */
export const FIXTURE_PROJECTS: (PosthogProject & { ga4: string })[] = [
  { id: 2001, name: "Alphanote", timezone: "America/New_York", ga4: "properties/1000001" },
  { id: 2002, name: "PaperFinch", timezone: "America/New_York", ga4: "properties/1000002" },
];

export const fixturePosthogApis: PosthogApis = {
  mode: "fixtures",
  projects: async () => FIXTURE_PROJECTS.map(({ id, name, timezone }) => ({ id, name, timezone })),
  project: async (id) => {
    const p = FIXTURE_PROJECTS.find((x) => x.id === id);
    if (!p) throw new Error(`No fixture PostHog project ${id}`);
    return { id: p.id, name: p.name, timezone: p.timezone };
  },
  organicLandingPages: async (id, start, end) => {
    const p = FIXTURE_PROJECTS.find((x) => x.id === id);
    if (!p) return [];
    const rows = await googleFixtures.ga4.organicLandingPages(p.ga4, start, end);
    return rows.map((r) => ({ ...r, keyEvents: 0, totalRevenue: 0 }));
  },
  sourceSessions: async (id, start, end) => {
    const p = FIXTURE_PROJECTS.find((x) => x.id === id);
    return p ? googleFixtures.ga4.sourceSessions(p.ga4, start, end) : [];
  },
};

type ProjectJson = { id: number; name?: string; timezone?: string };

const toProject = (j: ProjectJson): PosthogProject => ({ id: j.id, name: j.name || `Project ${j.id}`, timezone: j.timezone || "UTC" });

/** The REST client for one stored connection. `fetchImpl` is for tests. */
export function livePosthogApis(workspaceId: number, fetchImpl: typeof fetch = fetch): PosthogApis {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const { token, account } = await posthogAccessToken(workspaceId, fetchImpl);
    const base = REGIONS[account.region as keyof typeof REGIONS];
    const res = await fetchImpl(new URL(path, base), {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...init?.headers },
    });
    if (res.ok) return (await res.json()) as T;
    return fail(res, account);
  }

  async function fail(res: Response, account: PosthogAccount): Promise<never> {
    const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
    if (res.status === 401) {
      await rejectPosthogToken(account);
      throw new PosthogNotConnectedError("reauth_required");
    }
    if (res.status === 429) throw new PosthogQuotaError(detail ?? "PostHog rate limit reached");
    if (res.status === 403) {
      // The token works but doesn't cover this project. It isn't rejected: it may still reach others.
      console.error("[posthog] 403:", detail ?? "no detail");
      throw new PosthogAccessError();
    }
    throw new Error(`PostHog API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  async function project(id: number) {
    return toProject(await call<ProjectJson>(`/api/projects/${id}/`));
  }

  /** One HogQL query; past ROW_LIMIT rows the range is halved until each part fits. */
  async function landing(id: number, start: string, end: string): Promise<PosthogLandingRow[]> {
    const json = await call<{ results?: unknown[][] }>(`/api/projects/${id}/query/`, {
      method: "POST",
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: organicLandingQuery(start, end) }, name: "seopen_organic_landing_pages" }),
    });
    const results = json.results ?? [];
    const days = daysBetween(start, end);
    if (results.length < ROW_LIMIT || days < 1) return parseLandingRows(results);
    const mid = addDays(start, Math.floor(days / 2));
    return [...(await landing(id, start, mid)), ...(await landing(id, addDays(mid, 1), end))];
  }

  return {
    mode: "live",
    project,
    organicLandingPages: landing,
    async sourceSessions(id, start, end) {
      const json = await call<{ results?: unknown[][] }>(`/api/projects/${id}/query/`, {
        method: "POST",
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: sourceSessionsQuery(start, end) }, name: "seopen_sessions_by_source" }),
      });
      return parseSourceRows(json.results ?? []);
    },
    async projects() {
      const { account } = await posthogAccessToken(workspaceId, fetchImpl);
      // Granted specific projects: read those. Granted all: list them.
      if (account.scopedTeams.length) return Promise.all(account.scopedTeams.map(project));
      const out: PosthogProject[] = [];
      let path: string | null = "/api/projects/?limit=200";
      while (path) {
        const page: { results?: ProjectJson[]; next?: string | null } = await call(path);
        out.push(...(page.results ?? []).map(toProject));
        path = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
      }
      return out;
    },
  };
}

/** The PostHog client for the workspace's connection. Throws PosthogNotConnectedError when there is none. */
export function posthogApis(workspaceId: number): PosthogApis {
  return fixtureMode() ? fixturePosthogApis : livePosthogApis(workspaceId);
}
